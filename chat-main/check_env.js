import "dotenv/config";

console.log("OPENAI_API_KEY:", process.env.OPENAI_API_KEY ? "Loaded" : "Not loaded");
console.log("ERP_TOKEN:", process.env.ERP_TOKEN ? "Loaded" : "Not loaded");
