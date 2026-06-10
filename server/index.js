import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import { buildMessages, PROMPT_VERSION } from '../lib/translatePrompt.js';
import { logTranslationEvent } from './lib/events.js';

dotenv.config();
if (!process.env.OPENAI_API_KEY) {
  console.error('❌ Missing OPENAI_API_KEY in /server/.env');
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json());

/*
========================================================
🧪 HEALTH CHECK
========================================================
*/
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

/*
========================================================
🌍 TRANSLATE / DETECT
========================================================
*/
app.post('/api/v1/translate', async (req, res) => {
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

    console.log('➡️  Incoming request:', { text, targetLanguage, mode, context_type });

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

    // JSON mode: guarantees parseable output for translate calls.
    if (mode !== 'detect') {
      requestBody.response_format = { type: 'json_object' };
    }

    // Timeout protection: abort if OpenAI takes > 10s
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const startTime = Date.now();

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify(requestBody),
    });

    clearTimeout(timeout);

    const data = await response.json();
    const latency_ms = Date.now() - startTime;

    if (!response.ok) {
      console.error('❌ OpenAI error:', data);
      return res.status(500).json({ error: 'AI failed' });
    }

    const rawContent = data?.choices?.[0]?.message?.content;

    let parsed;
    try {
      parsed = JSON.parse(rawContent);
    } catch (err) {
      console.error('❌ JSON parse failed:', rawContent);
      return res.status(500).json({ error: 'Bad AI response', raw: rawContent });
    }

    console.log('✅ AI response:', parsed);

    // ── Event log (non-blocking) ───────────────────────────────────────────
    // was_cached: hardcoded false — no cache check exists in this path yet.
    // Known gap: update when message_translations cache is wired.
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
    // Note: we intentionally do NOT await this — fire-and-forget.
    // Response is already built; we must not block the caller on a DB write.

    return res.json(parsed);
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error('⏱️  Request timed out');
      return res.status(500).json({ error: 'Timeout' });
    }
    console.error('🔥 SERVER ERROR:', err);
    return res.status(500).json({ error: 'Server error' });
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
