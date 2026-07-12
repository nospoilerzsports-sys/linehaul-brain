// backend/server.js — brain endpoint that also searches your HubSpot CSVs.
//
// Put these files next to server.js (all REDACTED first):
//   briefing.json                          (from the Daily Dispatch artifact)
//   any number of .csv files               (HubSpot contacts, deals, etc.)
//
// Setup: npm install express cors csv-parse
//        env var ANTHROPIC_API_KEY=sk-ant-...
//        node server.js

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const API_KEY = process.env.ANTHROPIC_API_KEY;

// ---- load briefing.json (optional) ----
let briefing = {};
try { briefing = JSON.parse(fs.readFileSync(path.join(__dirname, "briefing.json"), "utf8")); } catch (e) {}

// ---- load every .csv in this folder into rows we can search ----
let rows = [];
try {
  for (const f of fs.readdirSync(__dirname)) {
    if (!f.toLowerCase().endsWith(".csv")) continue;
    try {
      const recs = parse(fs.readFileSync(path.join(__dirname, f), "utf8"), {
        columns: true, skip_empty_lines: true, relax_column_count: true, bom: true,
      });
      recs.forEach((r) => rows.push({ _file: f, ...r }));
    } catch (e) { console.error("skip", f, e.message); }
  }
  console.log("Loaded", rows.length, "CSV rows");
} catch (e) {}

function searchRows(q, limit) {
  limit = limit || 40;
  const words = q.toLowerCase().split(/[^a-z0-9$]+/).filter((w) => w.length > 2);
  if (!words.length) return rows.slice(0, limit);
  const scored = rows.map((r) => {
    const blob = Object.values(r).join(" ").toLowerCase();
    let score = 0;
    for (const w of words) if (blob.includes(w)) score++;
    return { r, score };
  });
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.r);
}

app.post("/ask", async (req, res) => {
  try {
    const { question, history } = req.body || {};
    if (!question) return res.status(400).json({ error: "no question" });

    const matches = searchRows(question, 40);
    const csvBlock = matches.length
      ? matches.map((r) => JSON.stringify(r)).join("\n").slice(0, 60000)
      : "(no matching CRM rows)";

    const ctx = `STATE OF BUSINESS: ${briefing.summary || ""}
BOTTOM LINE: ${briefing.bottomLine || ""}
BRIEFING FACTS: ${JSON.stringify(briefing.items || []).slice(0, 25000)}

RELEVANT CRM ROWS (from your HubSpot CSV exports, matched to the question):
${csvBlock}`;

    const hist = (history || []).slice(-6).map((m) => `${m.role === "user" ? "Team" : "Brain"}: ${m.content}`).join("\n");

    const prompt = `You are the shared business brain for a FedEx line haul brokerage. Answer using ONLY the data below (the briefing + matched CRM rows). Ground every answer in it; if it's not there, say so — NEVER invent names, numbers, or contacts. When asked to find or match someone (e.g. a buyer for a deal), pick from the CRM rows and explain why they fit. Be concise and specific.

${ctx}

CONVERSATION:
${hist}
Team: ${question}

Answer:`;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 900, messages: [{ role: "user", content: prompt }] }),
    });
    const data = await r.json();
    const answer = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    res.json({ answer: answer || "No answer returned." });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "brain error" });
  }
});

app.get("/", (_, res) => res.send("Linehaul brain is running. " + rows.length + " CRM rows loaded."));
app.listen(process.env.PORT || 3000, () => console.log("Brain listening"));
