import mysql from "mysql2/promise";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import OpenAI from "openai";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EMPL_PK = process.env.EMPL_PK || "default_empl_pk";
const PREPARED_BY = process.env.PREPARED_BY || "default_prepared_by";
const LOCATION_PK = process.env.LOCATION_PK || "default_location_pk";
const ERP_API = process.env.ERP_API || "https://your-default-erp-api.com";
const TOKEN = process.env.ERP_TOKEN;       // Already in your env
const OPENAI_KEY = process.env.OPENAI_API_KEY;

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

// MySQL Pool
const db = await mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
});

// JSON backup
const DATA_FILE = process.env.RENDER
  ? path.join("/tmp", "erpData.json")
  : path.join(__dirname, "erpData.json");

// In-memory storage
let allERPData = [];

  // Load existing ERP data from disk
  if (fs.existsSync(DATA_FILE)) {
    allERPData = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
    console.log(`✅ Loaded ${allERPData.length} ERP records from disk`);
  }

  // Utility
  function formatPeso(amount) {
    return new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(amount);
  }

  // Fetch ERP API
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

  // Summarize ERP data for filtering
  function summarizeERPData(erpData) {
    return erpData.map((so) => ({
      ...so, // Keep all fields
      division: so.Name_Dept || "Unknown",
      salesRep: so.Name_Empl || "Unknown",
      amount: Number(so.TotalAmount_TransH || 0),
      gpRate: parseFloat((so.gpRate || "0").toString().replace("%", "").replace(",", "")),
      status: so.Status_TransH,
      date: so.DateCreated_TransH,
      so_number: so.so_upk || "Unknown",
      

      
    }));
  }

// Merge new ERP data into MySQL and JSON
async function mergeNewData(newData) {
  let addedCount = 0;

  for (const so of newData) {
    // Insert new record, update if it exists
    const [result] = await db.query(
      `INSERT INTO sales_orders
      (so_pk, so_number, Name_Cust, Name_Empl, division, amount, gpRate, Status_TransH, DateCreated_TransH, Memo_TransH, ContractDescription_TransH)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        so_number = VALUES(so_number),
        Name_Cust = VALUES(Name_Cust),
        Name_Empl = VALUES(Name_Empl),
        division = VALUES(division),
        amount = VALUES(amount),
        gpRate = VALUES(gpRate),
        Status_TransH = VALUES(Status_TransH),
        DateCreated_TransH = VALUES(DateCreated_TransH),
        Memo_TransH = VALUES(Memo_TransH),
        ContractDescription_TransH = VALUES(ContractDescription_TransH)`,
      [
        so.so_pk,
        so.so_number,
        so.Name_Cust,
        so.Name_Empl,
        so.division,
        so.amount,
        so.gpRate,
        so.Status_TransH,
        so.DateCreated_TransH,
        so.Memo_TransH,
        so.ContractDescription_TransH
      ]
    );

    if (result.affectedRows > 0) addedCount++;
  }

  // Update in-memory array
  allERPData = newData.map(row => ({
    ...row,
    gpRate: Number(row.gpRate),
    amount: Number(row.amount)
  }));

  // Backup to JSON
  fs.writeFileSync(DATA_FILE, JSON.stringify(allERPData, null, 2));
  console.log(`✅ Added/Updated ${addedCount} ERP records in MySQL and JSON`);
}

// Example: Filter SOs by date + status
function getSalesOrdersByDateAndStatus(salesOrders, targetDate, targetStatus) {
  // Normalize for safe comparison
  const dateStr = new Date(targetDate).toISOString().split("T")[0].trim().toLowerCase();
  const statusStr = targetStatus.trim().toLowerCase();

  // Filter by date + status
  const filtered = salesOrders.filter(order => {
    const orderDate = new Date(order.date_created).toISOString().split("T")[0].toLowerCase();
    const orderStatus = order.status.trim().toLowerCase();
    return orderDate === dateStr && orderStatus === statusStr;
  });

  if (filtered.length === 0) {
    return {
      total_sales_orders: 0,
      total_amount: "₱0.00",
      highest_gp_rate: "-Infinity%",
      orders: []
    };
  }

  // Calculate totals
  const totalAmount = filtered.reduce((sum, o) => sum + (o.amount || 0), 0);
  const highestGpRate = Math.max(...filtered.map(o => o.gp_rate || 0));

  return {
    total_sales_orders: filtered.length,
    total_amount: `₱${totalAmount.toLocaleString(undefined, {minimumFractionDigits: 2})}`,
    highest_gp_rate: `${highestGpRate.toFixed(2)}%`,
    orders: filtered.map(o => ({
      so_number: o.so_number,
      amount: o.amount,
      gp_rate: o.gp_rate,
      status: o.status
    }))
  };
}

  // Parse question with GPT
  async function parseQuestionWithGPT(question) {
    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "user",
            content: `
  You are an ERP assistant. Detect if this question is about ERP sales orders or general. 
  Return JSON with intent, date, year, gpThreshold, customer, salesRep, status, topN, requested fields, or monthlyTotals intent.
  If it's a general question, return intent: "general".

  Automatically detect if any name mentioned is a customer or a salesRep.

  Question: "${question}"

  Return only JSON like:
  {
    "intent": "count" | "list" | "sample" | "topCustomers" | "topDivision" | "topSales" | "monthlyTotals" | "general",
    "date": "YYYY-MM-DD" | null,
    "year": "YYYY" | null,
    "gpThreshold": { "operator": ">", "value": 55 } | null,
    "customer": "customer keyword" | null,
    "salesRep": "salesRep keyword" | null,
    "status": "BILLED" | "JO IN-PROCESS" | "PENDING FOR JO" | "CANCELLED" | "PENDING BILLING" | null,
    "topN": 1 | 2 | 3 | null,
    "fields": ["so_number","gp_rate","amount","status"]
  }`
          }
        ],
        temperature: 0
      });

      let content = completion.choices[0].message.content;
      content = content.replace(/```json|```/g, "").trim();
      let parsed = JSON.parse(content);

      if (!parsed.intent) parsed.intent = "general";
      if (!parsed.fields) parsed.fields = [];
      // Default to null for missing properties
      parsed.customer = parsed.customer || null;
      parsed.salesRep = parsed.salesRep || null;
      parsed.topN = parsed.topN || null;
      parsed.year = parsed.year || null;
      parsed.date = parsed.date || null;
      parsed.gpThreshold = parsed.gpThreshold || null;
      parsed.status = parsed.status || null;

      return parsed;
    } catch (err) {
      console.error("GPT JSON parse error:", err);
      return { 
        intent: "general", 
        date: null, 
        gpThreshold: null, 
        customer: null, 
        salesRep: null, 
        status: null, 
        fields: [], 
        topN: null, 
        year: null 
      };
    }
  }

  // Filter ERP data
  function filterOrders(orders, parsed) {
    let filtered = orders;

    if (parsed.customer) {
      const kw = parsed.customer.toLowerCase();
      filtered = filtered.filter(o =>
        (o.Name_Cust || "").toLowerCase().includes(kw) ||
        (o.ContractDescription_TransH || "").toLowerCase().includes(kw) ||
        (o.Memo_TransH || "").toLowerCase().includes(kw)
      );
    }

    if (parsed.gpThreshold) {
      const { operator, value } = parsed.gpThreshold;
      filtered = filtered.filter(o => {
        switch (operator) {
          case ">": return o.gpRate > value;
          case "<": return o.gpRate < value;
          case ">=": return o.gpRate >= value;
          case "<=": return o.gpRate <= value;
          case "=": return o.gpRate === value;
          default: return true;
        }
      });
    }

    if (parsed.date) filtered = filtered.filter(o => o.DateCreated_TransH === parsed.date);
    if (parsed.year) filtered = filtered.filter(o => o.DateCreated_TransH.startsWith(parsed.year));

    return filtered;
  }

  // Format response
// --- inside formatResponse() ---
// --- inside formatResponse() ---
async function formatResponse(orders, parsed, question) {
  if (parsed.intent === "general") {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: question }],
      temperature: 0
    });
    return completion.choices[0].message.content;
  }

  if (!orders.length) return "There are 0 sales orders matching your query.";

  // Keep filtered orders in memory
  let filtered = [...orders];

  // --- filters ---
  if (parsed.salesRep) {
    filtered = filtered.filter(o =>
      (o.Name_Empl || "").toLowerCase() === parsed.salesRep.toLowerCase()
    );
  }

  if (parsed.year) {
    filtered = filtered.filter(o =>
      o.DateCreated_TransH.startsWith(parsed.year)
    );
  }

  if (parsed.date) {
    const targetDate = new Date(parsed.date).toISOString().split("T")[0];
    filtered = filtered.filter(o => {
      const orderDate = new Date(o.DateCreated_TransH).toISOString().split("T")[0];
      return orderDate === targetDate;
    });
  }

  if (question.toLowerCase().includes("september 2025")) {
    filtered = filtered.filter(o => {
      const d = new Date(o.DateCreated_TransH);
      return d.getFullYear() === 2025 && d.getMonth() === 8; // 0=Jan, 8=Sep
    });
  }

  if (parsed.status) {
    filtered = filtered.filter(o =>
      (o.Status_TransH || "").trim().toLowerCase() === parsed.status.trim().toLowerCase()
    );
  }

  // --- helper for field mapping ---
  const mapFields = (o) => {
    if (parsed.fields && parsed.fields.length) {
      return parsed.fields.map(f => {
        switch (f) {
          case "status": return `status: ${o.Status_TransH || "N/A"}`;
          case "so_number": return `so_number: ${o.so_upk || "N/A"}`;
          case "gp_rate": return `gp_rate: ${o.gpRate != null ? o.gpRate : "N/A"}`;
          case "amount": return `amount: ${o.amount != null ? o.amount : "N/A"}`;
          default: return `${f}: ${o[f] || "N/A"}`;
        }
      }).join(" - ");
    } else {
      return `so_number: ${o.so_upk || "N/A"} - gp_rate: ${o.gpRate != null ? o.gpRate : "N/A"} - amount: ${o.amount || "N/A"}`;
    }
  };

  // --- intents ---
  if (parsed.intent === "count") {
    const totalOrders = filtered.length;
    const totalAmount = filtered.reduce((sum, o) => sum + (o.amount || 0), 0);
    const highestGp = Math.max(...filtered.map(o => o.gpRate || 0));

    return `Total Sales Orders: ${totalOrders}\nTotal Amount: ${formatPeso(totalAmount)}\nHighest GP Rate: ${highestGp.toFixed(2)}%`;
  }

  if (parsed.intent === "list") {
    return filtered.map(mapFields).join("\n");
  }

  if (parsed.intent === "sample") {
    return filtered.length ? mapFields(filtered[0]) : "No matching sales order found.";
  }

  if (parsed.intent === "topCustomers") {
    const customerMap = {};
    filtered.forEach(o => { customerMap[o.Name_Cust] = (customerMap[o.Name_Cust] || 0) + o.amount; });
    const sorted = Object.entries(customerMap).sort((a, b) => b[1] - a[1]);
    const topN = parsed.topN || 1;
    return sorted.slice(0, topN).map(([cust, amt], i) =>
      `Top ${i + 1} Customer: ${cust} - Total Amount: ${formatPeso(amt)}`
    ).join("\n");
  }

  if (parsed.intent === "topDivision") {
    const divisionMap = {};
    filtered.forEach(o => { divisionMap[o.division] = (divisionMap[o.division] || 0) + o.amount; });
    const sorted = Object.entries(divisionMap).sort((a, b) => b[1] - a[1]);
    const topN = parsed.topN || 1;
    return sorted.slice(0, topN).map(([div, amt], i) =>
      `Top ${i + 1} Division: ${div} - Total Amount: ${formatPeso(amt)}`
    ).join("\n");
  }

  if (parsed.intent === "topSales") {
    const salesMap = {};
    filtered.forEach(o => { salesMap[o.salesRep] = (salesMap[o.salesRep] || 0) + o.amount; });
    const sorted = Object.entries(salesMap).sort((a, b) => b[1] - a[1]);
    const topN = parsed.topN || 1;
    return sorted.slice(0, topN).map(([rep, amt], i) =>
      `Top ${i + 1} Sales Personnel: ${rep} - Total Amount: ${formatPeso(amt)}`
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

    filtered.forEach(o => {
      if (!o.date) return;
      if (!validStatuses.includes(o.Status_TransH)) return;
      if (o.salesRep.toLowerCase() !== parsed.salesRep.toLowerCase()) return;

      const month = o.date.slice(0, 7);
      monthlyMap[month] = (monthlyMap[month] || 0) + o.amount;
    });

    return Object.entries(monthlyMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, amt]) => `${month}: ${formatPeso(amt)}`)
      .join("\n") || `No valid sales orders found for ${parsed.salesRep} in ${parsed.year}`;
  }

  // --- fallback ---
  console.log(`⚡ Unknown intent "${parsed.intent}" → falling back to GPT dynamic mode`);
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "You are an ERP assistant. Answer based only on ERP data provided below." },
      { role: "user", content: `Question: ${question}\nERP Data: ${JSON.stringify(filtered.slice(0, 200))}` }
    ],
    temperature: 0
  });

  return completion.choices[0].message.content;
}


  // Preload ERP data year-by-year
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
        filterDate: { filter: "range", date1: { hide: false, date: `${year}-01-01` }, date2: { hide: false, date: `${year}-12-31` } },
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

  // Update ERP data every minute
  setInterval(async () => {
    console.log("Updating ERP data...");
    await preloadERPData();
  }, 60_000);

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

  // Start server and preload data
  app.listen(3000, async () => {
    console.log("✅ Chatbot running on http://localhost:3000");
    await preloadERPData();
  });
    
