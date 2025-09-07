import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import OpenAI from "openai";
import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import pkg from "pg";

const { Pool } = pkg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

// PostgreSQL connection
const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 5432,
  ssl: {
    rejectUnauthorized: false // allows self-signed SSL certs
  }
});

// ERP API details
const ERP_API = process.env.ERP_API;
const TOKEN = process.env.ERP_TOKEN;
const LOCATION_PK = process.env.LOCATION_PK;
const EMPL_PK = process.env.EMPL_PK;
const PREPARED_BY = process.env.PREPARED_BY;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// In-memory cache
let allERPData = [];

// Load existing ERP data from DB into memory
async function loadDataFromDB() {
  try {
    const res = await pool.query("SELECT * FROM sales_orders");
    allERPData = res.rows;
    console.log(`✅ Loaded ${allERPData.length} ERP records from PostgreSQL`);
  } catch (err) {
    console.error("Error loading data from DB:", err);
  }
}

// Utility
function formatPeso(amount) {
  return new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(amount);
}

// Call ERP API
async function callERP(payload) {
  try {
    const response = await fetch(ERP_API, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return await response.json();
  } catch (err) {
    console.error("ERP API error:", err);
    return { data: [] };
  }
}

// Fetch all sales orders with pagination
async function fetchAllSalesOrders(payload) {
  let allData = [];
  let offset = 0;
  const limit = 500;

  while (true) {
    const res = await callERP({ ...payload, limit, offset });
    const soList = res.data?.[0] || [];
    allData = allData.concat(soList);
    if (soList.length < limit) break;
    offset += limit;
  }

  return allData;
}

// Summarize ERP data for DB
function summarizeERPData(erpData) {
  return erpData.map((so) => ({
    so_pk: so.so_pk,
    so_number: so.so_upk || "Unknown",
    date_created: so.DateCreated_TransH || null,
    amount: Number(so.TotalAmount_TransH || 0),
    gp_rate: parseFloat((so.gpRate || 0).toString().replace("%", "").replace(",", "")),
    status: so.Status_TransH || "Unknown",
    division: so.Name_Dept || "Unknown",
    salesRep: so.Name_Empl || "Unknown",
    customer: so.Name_Cust || "Unknown",
    contract_description: so.ContractDescription_TransH || "",
    memo: so.Memo_TransH || ""
  }));
}

// Merge new ERP data into DB and memory
async function mergeNewData(newData) {
  const existingSO = new Set(allERPData.map(o => o.so_pk));
  const filteredNew = newData.filter(o => !existingSO.has(o.so_pk));

  if (filteredNew.length === 0) return;

  allERPData.push(...filteredNew);
  console.log(`✅ Added ${filteredNew.length} new ERP records`);

  // Insert into PostgreSQL
  const client = await pool.connect();
  try {
    for (const so of filteredNew) {
      await client.query(
        `INSERT INTO sales_orders 
        (so_pk, so_number, date_created, status, customer_name, sales_rep, division, amount, gp_rate, memo)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (so_pk) DO NOTHING`,
        [
          so.so_pk,
          so.so_number,
          so.date_created,
          so.status,
          so.customer,
          so.salesRep,
          so.division,
          so.amount,
          so.gp_rate,
          so.memo
        ]
      );
    }
    console.log("✅ ERP data stored in PostgreSQL");
  } catch (err) {
    console.error("DB insert error:", err);
  } finally {
    client.release();
  }
}

// Preload ERP data from API -> DB -> memory
async function preloadERPData() {
  const startYear = 2020;
  const endYear = new Date().getFullYear();

  for (let year = startYear; year <= endYear; year++) {
    console.log(`Fetching ERP data for year ${year}...`);
    const payload = {
      empl_pk: EMPL_PK,
      preparedBy: PREPARED_BY,
      viewAll: 1,
      searchKey: "",
      customerPK: null,
      departmentPK: null,
      filterDate: {
        filter: "range",
        date1: { hide: false, date: `${year}-01-01` },
        date2: { hide: false, date: `${year}-12-31` }
      },
      limit: 500,
      offset: 0,
      locationPK: LOCATION_PK,
      salesRepPK: null,
      status: "",
    };
    const rawData = await fetchAllSalesOrders(payload);
    const summarized = summarizeERPData(rawData);
    await mergeNewData(summarized);
    console.log(`✅ Completed loading year ${year} with ${summarized.length} records`);
  }
}

// GPT parse question
async function parseQuestionWithGPT(question) {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "user", content: `
You are an ERP assistant. Return a JSON for the following question.
Include fields: intent (count, list, topCustomers, topDivision, topSales, monthlyTotals, general),
date (YYYY-MM-DD), year (YYYY), status, salesRep, customer, gpThreshold (if any), topN (1-3), fields (["so_number","gp_rate","amount","status"]).
Question: "${question}"
        ` }
      ],
      temperature: 0
    });

    let content = completion.choices[0].message.content.replace(/```/g, "").trim();
    let parsed = JSON.parse(content);
    if (!parsed.intent) parsed.intent = "general";
    parsed.customer = parsed.customer || null;
    parsed.salesRep = parsed.salesRep || null;
    parsed.status = parsed.status || null;
    parsed.date = parsed.date || null;
    parsed.year = parsed.year || null;
    parsed.gpThreshold = parsed.gpThreshold || null;
    parsed.topN = parsed.topN || null;
    parsed.fields = parsed.fields || [];
    return parsed;
  } catch (err) {
    console.error("GPT JSON parse error:", err);
    return { intent: "general" };
  }
}

// Filter orders based on parsed intent
function filterOrders(orders, parsed) {
  let filtered = [...orders];

  if (parsed.customer) filtered = filtered.filter(o => o.customer.toLowerCase().includes(parsed.customer.toLowerCase()));
  if (parsed.salesRep) filtered = filtered.filter(o => o.salesRep.toLowerCase() === parsed.salesRep.toLowerCase());
  if (parsed.status) filtered = filtered.filter(o => o.status.toLowerCase() === parsed.status.toLowerCase());
  if (parsed.date) filtered = filtered.filter(o => new Date(o.date_created).toISOString().split("T")[0] === parsed.date);
  if (parsed.year) filtered = filtered.filter(o => new Date(o.date_created).getFullYear() === parseInt(parsed.year));
  return filtered;
}

// Format chatbot response
async function formatResponse(orders, parsed, question) {
  if (parsed.intent === "general") {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: question }],
      temperature: 0
    });
    return completion.choices[0].message.content;
  }

  if (!orders.length) return "No matching sales orders.";

  if (parsed.intent === "count") {
    const totalAmount = orders.reduce((sum, o) => sum + o.amount, 0);
    const highestGp = Math.max(...orders.map(o => o.gp_rate));
    return `Total Sales Orders: ${orders.length}\nTotal Amount: ${formatPeso(totalAmount)}\nHighest GP Rate: ${highestGp.toFixed(2)}%`;
  }

  if (parsed.intent === "list") {
    return orders.map(o => `so_number: ${o.so_number} - amount: ${formatPeso(o.amount)} - gp_rate: ${o.gp_rate}% - status: ${o.status}`).join("\n");
  }

  if (parsed.intent === "topSales") {
    const salesMap = {};
    orders.forEach(o => { salesMap[o.salesRep] = (salesMap[o.salesRep] || 0) + o.amount; });
    const sorted = Object.entries(salesMap).sort((a, b) => b[1] - a[1]);
    const topN = parsed.topN || 1;
    return sorted.slice(0, topN).map(([rep, amt], i) =>
      `Top ${i + 1} Sales Personnel: ${rep} - Total Amount: ${formatPeso(amt)}`
    ).join("\n");
  }

  if (parsed.intent === "topCustomers") {
    const customerMap = {};
    orders.forEach(o => { customerMap[o.customer] = (customerMap[o.customer] || 0) + o.amount; });
    const sorted = Object.entries(customerMap).sort((a, b) => b[1] - a[1]);
    const topN = parsed.topN || 1;
    return sorted.slice(0, topN).map(([cust, amt], i) =>
      `Top ${i + 1} Customer: ${cust} - Total Amount: ${formatPeso(amt)}`
    ).join("\n");
  }

  if (parsed.intent === "topDivision") {
    const divisionMap = {};
    orders.forEach(o => { divisionMap[o.division] = (divisionMap[o.division] || 0) + o.amount; });
    const sorted = Object.entries(divisionMap).sort((a, b) => b[1] - a[1]);
    const topN = parsed.topN || 1;
    return sorted.slice(0, topN).map(([div, amt], i) =>
      `Top ${i + 1} Division: ${div} - Total Amount: ${formatPeso(amt)}`
    ).join("\n");
  }

  if (parsed.intent === "monthlyTotals" && parsed.year && parsed.salesRep) {
    const monthlyMap = {};
    const validStatuses = [
      "BILLED",
      "PARTIALLYBILLED/PARTIALLY DELIVERED",
      "PARTIALLY DELIVERED",
      "PENDING BILLING",
      "PENDING DELIVERY",
      "JO IN-PROCESS"
    ];

    orders.forEach(o => {
      if (!o.date_created) return;
      if (!validStatuses.includes(o.status)) return;
      if (o.salesRep.toLowerCase() !== parsed.salesRep.toLowerCase()) return;

      const month = o.date_created.slice(0, 7);
      monthlyMap[month] = (monthlyMap[month] || 0) + o.amount;
    });

    return Object.entries(monthlyMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, amt]) => `${month}: ${formatPeso(amt)}`)
      .join("\n") || `No valid sales orders found for ${parsed.salesRep} in ${parsed.year}`;
  }

  return "Intent not implemented yet.";
}


// Chatbot endpoint
app.post("/chatbot", async (req, res) => {
  try {
    const { question } = req.body;
    const parsed = await parseQuestionWithGPT(question);
    const filtered = filterOrders(allERPData, parsed);
    const answer = await formatResponse(filtered, parsed, question);
    res.json({ type: "text", data: answer });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Chatbot failed" });
  }
});

// Reset memory
app.post("/reset-memory", (req, res) => res.json({ success: true }));

// Start server
app.listen(3000, async () => {
  console.log("✅ Chatbot running on http://localhost:3000");
  await loadDataFromDB();      // Load DB into memory
  await preloadERPData();       // Fetch new ERP data and merge into DB
  setInterval(preloadERPData, 60_000); // Auto-update ERP data every minute
});
