import express from "express";
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();
if (!process.env.OPENAI_API_KEY) {
  console.error("❌ Missing OPENAI_API_KEY in /server/.env");
  process.exit(1);
}
const app = express();

app.use(cors()); // ✅ allow frontend calls
app.use(express.json());

/*
========================================================
🧠 SAFE PARSE
========================================================
*/
function safeParse(content) {
  try {
    return JSON.parse(content);
  } catch (err) {
    console.error("JSON PARSE FAILED:", content);
    return null;
  }
}

/*
========================================================
🧪 HEALTH CHECK
========================================================
*/
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

/*
========================================================
🌍 TRANSLATE / DETECT
========================================================
*/
app.post("/api/v1/translate", async (req, res) => {
  try {
    const { text, targetLanguage, mode } = req.body;

    if (!text) {
      return res.status(400).json({ error: "Missing text" });
    }

    if (mode !== "detect" && !targetLanguage) {
      return res.status(400).json({ error: "Missing targetLanguage" });
    }

    // ✅ Debug logging (super useful)
    console.log("➡️ Incoming request:", {
      text,
      targetLanguage,
      mode,
    });

    const systemPrompt =
      mode === "detect"
        ? `
Detect the language of the message.

Return ONLY JSON:
{ "detected_language": "..." }
        `.trim()
        : `
You are a translation engine.

Translate into ${targetLanguage}.

Preserve tone, slang, and intent.
Handle idioms naturally instead of literal translation.

Return ONLY JSON:
{
  "detected_language": "...",
  "translated_text": "..."
}
        `.trim();

    // ✅ Timeout protection (prevents hanging requests)
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: text },
          ],
          temperature: 0,
        }),
      }
    );

    clearTimeout(timeout);

    const data = await response.json();

    if (!response.ok) {
      console.error("❌ OpenAI error:", data);
      return res.status(500).json({ error: "AI failed" });
    }

    const rawContent = data?.choices?.[0]?.message?.content;
    const parsed = safeParse(rawContent);

    if (!parsed) {
      return res.status(500).json({
        error: "Bad AI response",
        raw: rawContent,
      });
    }

    console.log("✅ AI response:", parsed);

    return res.json(parsed);
  } catch (err) {
    if (err.name === "AbortError") {
      console.error("⏱️ Request timed out");
      return res.status(500).json({ error: "Timeout" });
    }

    console.error("🔥 SERVER ERROR:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

/*
========================================================
🚀 START SERVER
========================================================
*/
const PORT = 3001;

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});