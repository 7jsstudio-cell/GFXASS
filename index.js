import mysql from "mysql2/promise";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import OpenAI from "openai";
import axios from "axios";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Environment variables
const EMPL_PK = process.env.EMPL_PK || "default_empl_pk";
const PREPARED_BY = process.env.PREPARED_BY || "default_prepared_by";
const LOCATION_PK = process.env.LOCATION_PK || "default_location_pk";
const ERP_API = process.env.ERP_API || "http://gsuite.graphicstar.com.ph/api/get_sales_orders";
const TOKEN = process.env.ERP_TOKEN;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

// Express setup
const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

import pkg from 'pg';
const { Pool } = pkg;

const db = new Pool({
  connectionString: "postgresql://askjwu_user:8maVyJaJCbxGXxZlcZHqsz6HlZAr0Z2I@dpg-d2ujvc3e5dus73eqv5r0-a.oregon-postgres.render.com/askjwu",
  ssl: { rejectUnauthorized: false } // required for Render
});

// Example query
const res = await db.query('SELECT * FROM sales_orders LIMIT 5');
console.log(res.rows);

// OpenAI client
const openai = new OpenAI({ apiKey: OPENAI_KEY });

// JSON backup file
const DATA_FILE = process.env.RENDER
  ? path.join("/tmp", "erpData.json")
  : path.join(__dirname, "erpData.json");

// In-memory storage
let allERPData = [];
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

// Summarize ERP data
function summarizeERPData(erpData) {
  return erpData.map((so) => ({
    ...so,
    division: so.Name_Dept || "Unknown",
    salesRep: so.Name_Empl || "Unknown",
    amount: Number(so.TotalAmount_TransH || 0),
    gpRate: parseFloat((so.gpRate || "0").toString().replace("%", "").replace(",", "")),
    status: so.Status_TransH,
    date: so.DateCreated_TransH,
    so_number: so.so_upk || "Unknown",
  }));
}

// Insert/update sales orders in MySQL
async function upsertSalesOrders(records) {
  for (const r of records) {
    await db.query(
      `INSERT INTO sales_orders (
        so_pk, so_upk, DateCreated_TransH, ContractDescription_TransH, PreparedBy_TransH,
        ApprovedBy_TransH, TotalAmount_TransH, PONo_TransH, Memo_TransH, Status_TransH,
        SubTotalVatEx_TransH, TaxAmount_TransH, sl_pk, sl_upk, Name_Loc, Name_Cust,
        Name_Empl, Name_Dept
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      ON CONFLICT (so_pk) DO UPDATE SET
        TotalAmount_TransH = EXCLUDED.TotalAmount_TransH,
        Status_TransH = EXCLUDED.Status_TransH`,
      [
        r.so_pk,
        r.so_upk,
        r.DateCreated_TransH,
        r.ContractDescription_TransH,
        r.PreparedBy_TransH,
        r.ApprovedBy_TransH,
        r.TotalAmount_TransH,
        r.PONo_TransH,
        r.Memo_TransH,
        r.Status_TransH,
        r.SubTotalVatEx_TransH,
        r.TaxAmount_TransH,
        r.sl_pk,
        r.sl_upk,
        r.Name_Loc,
        r.Name_Cust,
        r.Name_Empl,
        r.Name_Dept
      ]
    );
  }
}
// Merge new data into in-memory storage
async function mergeNewData(newData) {
  allERPData = [...allERPData.filter(old => !newData.some(n => n.so_upk === old.so_upk)), ...newData];
  fs.writeFileSync(DATA_FILE, JSON.stringify(allERPData, null, 2));
}

// Preload ERP data per year
async function preloadERPData() {
  const startYear = 2020;
  const endYear = new Date().getFullYear();

  for (let year = startYear; year <= endYear; year++) {
    console.log(`Fetching ERP data for year ${year}...`);
    const payload = {
      empl_pk: EMPL_PK,
      preparedBy: PREPARED_BY,
      viewAll: 1,
      filterDate: { filter: "range", date1: { hide: false, date: `${year}-01-01` }, date2: { hide: false, date: `${year}-12-31` } },
      limit: 500,
      offset: 0,
      locationPK: LOCATION_PK
    };

    const rawData = await fetchAllSalesOrders(payload);
    const summarized = summarizeERPData(rawData);

    await mergeNewData(summarized);
    await upsertSalesOrders(rawData);

    console.log(`✅ Completed loading year ${year} with ${summarized.length} records`);
  }
}

// Update ERP data every minute
setInterval(async () => {
  console.log("Updating ERP data...");
  await preloadERPData();
}, 60_000);

// Parse question with GPT
async function parseQuestionWithGPT(question) {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{
        role: "user",
        content: `You are an ERP assistant. Detect if this question is about ERP sales orders or general. Return JSON with intent, date, year, gpThreshold, customer, salesRep, status, topN, fields. Question: "${question}" `
      }],
      temperature: 0
    });

    let content = completion.choices[0].message.content.replace(/```json|```/g, "").trim();
    let parsed = JSON.parse(content);

    return {
      intent: parsed.intent || "general",
      date: parsed.date || null,
      year: parsed.year || null,
      gpThreshold: parsed.gpThreshold || null,
      customer: parsed.customer || null,
      salesRep: parsed.salesRep || null,
      status: parsed.status || null,
      topN: parsed.topN || null,
      fields: parsed.fields || []
    };
  } catch (err) {
    console.error("GPT parse error:", err);
    return { intent: "general", date: null, year: null, gpThreshold: null, customer: null, salesRep: null, status: null, fields: [], topN: null };
  }
}

// Filter ERP orders
function filterOrders(orders, parsed) {
  let filtered = [...orders];

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

  if (parsed.salesRep) filtered = filtered.filter(o => (o.salesRep || "").toLowerCase() === parsed.salesRep.toLowerCase());
  if (parsed.year) filtered = filtered.filter(o => o.date.startsWith(parsed.year));
  if (parsed.date) filtered = filtered.filter(o => o.date === parsed.date);
  if (parsed.status) filtered = filtered.filter(o => (o.status || "").trim().toLowerCase() === parsed.status.trim().toLowerCase());

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

  if (!orders.length) return "No sales orders matching your query.";

  const mapFields = (o) => parsed.fields.length
    ? parsed.fields.map(f => `${f}: ${o[f] ?? "N/A"}`).join(" - ")
    : `so_number: ${o.so_number} - gp_rate: ${o.gpRate} - amount: ${o.amount}`;

  switch (parsed.intent) {
    case "count":
      const totalAmount = orders.reduce((sum, o) => sum + o.amount, 0);
      const highestGp = Math.max(...orders.map(o => o.gpRate));
      return `Total Orders: ${orders.length}\nTotal Amount: ${formatPeso(totalAmount)}\nHighest GP: ${highestGp.toFixed(2)}%`;

    case "list": return orders.map(mapFields).join("\n");
    case "sample": return mapFields(orders[0]);
    case "topCustomers":
      const customerMap = {};
      orders.forEach(o => customerMap[o.Name_Cust] = (customerMap[o.Name_Cust] || 0) + o.amount);
      return Object.entries(customerMap).sort((a,b)=>b[1]-a[1]).slice(0, parsed.topN || 1)
        .map(([cust, amt], i)=>`Top ${i+1} Customer: ${cust} - ${formatPeso(amt)}`).join("\n");
    case "topDivision":
      const divMap = {};
      orders.forEach(o => divMap[o.division] = (divMap[o.division] || 0) + o.amount);
      return Object.entries(divMap).sort((a,b)=>b[1]-a[1]).slice(0, parsed.topN || 1)
        .map(([div, amt], i)=>`Top ${i+1} Division: ${div} - ${formatPeso(amt)}`).join("\n");
    case "topSales":
      const salesMap = {};
      orders.forEach(o => salesMap[o.salesRep] = (salesMap[o.salesRep] || 0) + o.amount);
      return Object.entries(salesMap).sort((a,b)=>b[1]-a[1]).slice(0, parsed.topN || 1)
        .map(([rep, amt], i)=>`Top ${i+1} Sales: ${rep} - ${formatPeso(amt)}`).join("\n");
    default:
      return "Intent not implemented.";
  }
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

// Reset memory endpoint
app.post("/reset-memory", (req, res) => res.json({ success: true }));

// Start server and preload data
app.listen(3000, async () => {
  console.log("✅ Chatbot running on http://localhost:3000");
  await preloadERPData();
});
