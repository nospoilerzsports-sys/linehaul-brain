// backend/server.js — brain endpoint: answers questions, searches HubSpot CSVs,
// and captures spoken UPDATES ("this deal is dead") into a chronological log.
//
// Files next to server.js (all REDACTED first):
//   briefing.json   + any number of .csv files (HubSpot contacts, deals, etc.)
//
// Setup: npm install express cors csv-parse
//        env ANTHROPIC_API_KEY=sk-ant-...   ->   node server.js
//
// API:
//   POST /ask  { question, history:[{role,content}], updates:[{ts,entity,change}] }
//     -> { answer, updates:[{entity,change}] }   // updates = NEW updates detected in this message
//   The app stores the update log on-device and sends it with every request,
//   so the newest state always wins — even if this server restarts.

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const API_KEY = process.env.ANTHROPIC_API_KEY;

let briefing = {};
try { briefing = JSON.parse(fs.readFileSync(path.join(__dirname, "briefing.json"), "utf8")); } catch (e) {}

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

function extractJSON(text) {
  if (!text) return null;
  let t = text.replace(/```json|```/g, "").trim();
  const s = t.indexOf("{");
  if (s > 0) t = t.slice(s);
  try { return JSON.parse(t); } catch (e) {}
  // salvage: trim to last closing brace
  const last = t.lastIndexOf("}");
  if (last > 0) { try { return JSON.parse(t.slice(0, last + 1)); } catch (e) {} }
  return null;
}


// Model router: cheap+fast for simple lookups, full Sonnet for analysis,
// comparisons, strategy, and anything ambiguous. Defaults UP, not down.
function pickModel(q) {
  const s = (q || "").toLowerCase();
  const simple = [
    /^(what('s| is) the (status|stage|phone|email|number)|where (is|are)|when (did|is)|who is )/,
    /^(show|list|find) (me )?(the )?[a-z ]{0,20}(deal|contact|number|email|phone)/,
  ];
  const isShort = s.length < 60;
  if (isShort && simple.some((re) => re.test(s))) return "claude-haiku-4-5-20251001";
  return "claude-sonnet-4-5"; // analysis, matching, strategy, general questions
}

app.post("/ask", async (req, res) => {
  try {
    const { question, history, updates } = req.body || {};
    if (!question) return res.status(400).json({ error: "no question" });

    const matches = searchRows(question, 25);
    const csvBlock = matches.length
      ? matches.map((r) => JSON.stringify(r)).join("\n").slice(0, 30000)
      : "(no matching CRM rows)";

    const updLog = Array.isArray(updates) && updates.length
      ? updates.slice(0, 80).map((u) => `${u.ts || ""} — ${u.entity || ""}: ${u.change || ""}`).join("\n")
      : "(none yet)";

    const ctx = `STATE OF BUSINESS: ${briefing.summary || ""}
BOTTOM LINE: ${briefing.bottomLine || ""}
BRIEFING FACTS: ${JSON.stringify(briefing.items || []).slice(0, 12000)}

TEAM UPDATE LOG (newest first — these OVERRIDE anything older in the briefing or CRM rows):
${updLog}

RELEVANT CRM ROWS (from HubSpot CSV exports, matched to the question):
${csvBlock}`;

    const hist = (history || []).slice(-6).map((m) => `${m.role === "user" ? "Team" : "Brain"}: ${m.content}`).join("\n");

    const prompt = `You are the shared business brain for a FedEx line haul brokerage. Use ONLY the data below. The TEAM UPDATE LOG is the newest truth — it overrides the briefing and CRM rows. NEVER invent facts, names, or numbers; if it's not in the data, say so.

ALSO: detect whether the team's last message contains business UPDATES — statements changing the state of a deal, contact, or task (e.g. "the SP030 deal is dead", "mark Swetha's deal as closing", "Rick sent the docs"). Questions are NOT updates.

${ctx}

CONVERSATION:
${hist}
Team: ${question}

FORMAT RULES for the answer:
- Start with a short bold headline: **Like This**
- Then 2-5 short bullet lines starting with "- " (each under 15 words)
- Bold key names/numbers inline with **asterisks**
- Keep the whole answer under 90 words. End with: _Ask for details if you want more._ ONLY when there is meaningfully more to tell.
- If updates were logged, acknowledge in one bullet.

Respond with ONLY valid JSON, no fences, no preamble:
{"answer":"formatted answer following the FORMAT RULES","updates":[{"entity":"deal/person/thing updated","change":"one line: what changed"}]}
If there are no updates, use "updates":[].`;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: pickModel(question), max_tokens: 1200, messages: [{ role: "user", content: prompt }] }),
    });
    const data = await r.json();
    if (data.error) {
      console.error("Anthropic API error:", JSON.stringify(data.error));
      return res.json({ answer: "", error: "AI request failed", detail: (data.error.message || data.error.type || "unknown") });
    }
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    const parsed = extractJSON(text);

    if (parsed && typeof parsed.answer === "string") {
      res.json({ answer: parsed.answer, updates: Array.isArray(parsed.updates) ? parsed.updates.filter((u) => u && u.change) : [] });
    } else {
      // graceful fallback: return raw text as the answer, no updates
      res.json({ answer: text || "No answer returned.", updates: [] });
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "brain error" });
  }
});

app.get("/", (_, res) => res.send("Linehaul brain is running. " + rows.length + " CRM rows loaded."));
app.listen(process.env.PORT || 3000, () => console.log("Brain listening"));
