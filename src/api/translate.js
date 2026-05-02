export default async function handler(req, res) {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }
  
    try {
      const { text, targetLanguage, mode } = req.body;
  
      if (!text) {
        return res.status(400).json({ error: "Missing text" });
      }
  
      const systemPrompt =
        mode === "detect"
          ? `
  Detect the language of the message.
  
  Return ONLY JSON:
  { "detected_language": "..." }
          `.trim()
          : `
  You are a real-time translator.
  
  Translate into ${targetLanguage}.
  
  Preserve tone, slang, and intent.
  
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
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, // ✅ server-side
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
  
      const content = data?.choices?.[0]?.message?.content;
  
      return res.status(200).json(JSON.parse(content));
    } catch (err) {
      console.error("API error:", err);
      return res.status(500).json({ error: "Server error" });
    }
  }