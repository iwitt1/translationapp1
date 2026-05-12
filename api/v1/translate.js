import { buildMessages } from '../../lib/translatePrompt.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const {
      text,
      targetLanguage,
      mode,
      context_type,
      context,
      history,
    } = req.body;

    if (!text) {
      return res.status(400).json({ error: 'Missing text' });
    }
    if (mode !== 'detect' && !targetLanguage) {
      return res.status(400).json({ error: 'Missing targetLanguage' });
    }

    const messages = buildMessages({
      mode,
      text,
      targetLanguage,
      contextType: context_type,
      context,
      history,
    });

    const requestBody = {
      model: 'gpt-4o-mini',
      messages,
      temperature: 0,
    };

    // JSON mode guarantees parseable output for translate calls.
    // Not used for detect: the detect prompt is intentionally minimal and
    // JSON mode requires the prompt to explicitly mention JSON (ours does,
    // but keeping detect simple avoids any edge cases).
    if (mode !== 'detect') {
      requestBody.response_format = { type: 'json_object' };
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify(requestBody),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('OpenAI error:', data);
      return res.status(500).json({ error: 'AI failed' });
    }

    const raw = data?.choices?.[0]?.message?.content;

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.error('Bad JSON from AI:', raw);
      return res.status(500).json({ error: 'Bad AI response' });
    }

    return res.status(200).json(parsed);
  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
