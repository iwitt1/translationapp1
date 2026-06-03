import { buildMessages, PROMPT_VERSION } from '../../lib/translatePrompt.js';
import { logTranslationEvent } from '../../server/lib/events.js';

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

    const startTime = Date.now();

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify(requestBody),
    });

    const data = await response.json();
    const latency_ms = Date.now() - startTime;

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

    // ── Event log (non-blocking) ───────────────────────────────────────────
    // was_cached: hardcoded false — no cache check exists in this path yet.
    // Known gap: update when message_translations cache is wired (Spec 4b report §known-gaps).
    // tenant_id: chat-app tenant UUID (hardcoded until multi-tenant routing exists).
    // user_id: not available in request body — null until auth is threaded through.
    logTranslationEvent({
      tenant_id: '00000000-0000-0000-0000-000000000001',
      task_id: null,
      user_id: null,
      target_language: targetLanguage ?? 'detect',
      was_cached: false,
      model_used: 'gpt-4o-mini',
      prompt_version: PROMPT_VERSION,
      latency_ms,
      character_count: text.length,
      input_tokens: data?.usage?.prompt_tokens ?? null,
      output_tokens: data?.usage?.completion_tokens ?? null,
      event_source: 'chat_app',
    });
    // Note: we intentionally do NOT await this — it's fire-and-forget.
    // The response is already built; we must not block the caller on a DB write.

    return res.status(200).json(parsed);
  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
