// backend/server.js — the brain endpoint (~60 lines).
// Holds your Claude API key + the briefing data. Deploy to Railway/Render/Vercel.
//
// Setup:
//   1. npm init -y && npm install express cors
//   2. Put your exported briefing.json next to this file.
//   3. Set env var: ANTHROPIC_API_KEY=sk-ant-...
//   4. node server.js   (listens on PORT or 3000)
//   5. In the app, set BRAIN_ENDPOINT to https://your-host/ask

const express = require("express");
const cors = require("cors");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const briefing = JSON.parse(fs.readFileSync(__dirname + "/briefing.json", "utf8"));
const API_KEY = process.env.ANTHROPIC_API_KEY;

app.post("/ask", async (req, res) => {
  try {
    const { question, history } = req.body || {};
    if (!question) return res.status(400).json({ error: "no question" });

    const ctx = `STATE OF BUSINESS: ${briefing.summary || ""}
BOTTOM LINE: ${briefing.bottomLine || ""}
FOCUS: ${JSON.stringify(briefing.focus || {})}
TOP RISKS: ${JSON.stringify(briefing.topRisks || [])}
STRATEGY: ${JSON.stringify(briefing.strategy || {})}
FACTS (deals, follow-ups, promises, risks): ${JSON.stringify(briefing.items || []).slice(0, 60000)}`;

    const hist = (history || []).slice(-6).map((m) => `${m.role === "user" ? "Team" : "Brain"}: ${m.content}`).join("\n");

    const prompt = `You are the shared business brain for a FedEx line haul brokerage. Answer the team's question using ONLY the data below. Ground every answer in it; if the data doesn't cover it, say so plainly — NEVER invent facts, names, or numbers. Be concise: who, which deal, next step.

${ctx}

CONVERSATION:
${hist}
Team: ${question}

Answer:`;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 800,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await r.json();
    const answer = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    res.json({ answer: answer || "No answer returned." });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "brain error" });
  }
});

app.get("/", (_, res) => res.send("Linehaul brain is running."));
app.listen(process.env.PORT || 3000, () => console.log("Brain listening"));
