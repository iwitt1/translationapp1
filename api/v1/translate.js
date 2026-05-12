export default async function handler(req, res) {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }
  
    try {
      const { text, targetLanguage, mode } = req.body;
  
      if (!text) {
        return res.status(400).json({ error: "Missing text" });
      }
  
      if (mode !== "detect" && !targetLanguage) {
        return res.status(400).json({ error: "Missing targetLanguage" });
      }
  
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
  
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
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
      });
  
      const data = await response.json();
  
      if (!response.ok) {
        console.error("OpenAI error:", data);
        return res.status(500).json({ error: "AI failed" });
      }
  
      const raw = data?.choices?.[0]?.message?.content;
  
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        console.error("Bad JSON from AI:", raw);
        return res.status(500).json({ error: "Bad AI response" });
      }
  
      return res.status(200).json(parsed);
    } catch (err) {
      console.error("Server error:", err);
      return res.status(500).json({ error: "Server error" });
    }
  }