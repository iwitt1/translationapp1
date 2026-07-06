import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import {
  buildMessages,
  PROMPT_VERSION,
  TRANSLATE_MODEL,
  TRANSLATE_REASONING_EFFORT,
  DETECT_MODEL,
} from '../lib/translatePrompt.js';
import { logTranslationEvent } from './lib/events.js';
import { inferProfile } from './lib/inferProfile.js';
import { requireAuth } from './lib/auth.js';

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
  // Every call (including detect) requires a valid user token.
  const principal = await requireAuth(req, res);
  if (!principal) return; // 401/403 already sent

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

    // Mode-based model selection (see lib/translatePrompt.js for rationale):
    // - detect: gpt-4o-mini, temperature 0 — trivial classification, cheap + fast.
    // - translate: gpt-5.4 with reasoning effort — no temperature (unsupported
    //   on reasoning calls) and JSON mode for guaranteed-parseable output.
    const isDetect = mode === 'detect';
    const modelUsed = isDetect ? DETECT_MODEL : TRANSLATE_MODEL;

    const requestBody = isDetect
      ? {
          model: DETECT_MODEL,
          messages,
          temperature: 0,
        }
      : {
          model: TRANSLATE_MODEL,
          reasoning: { effort: TRANSLATE_REASONING_EFFORT },
          messages,
          response_format: { type: 'json_object' },
        };

    // Timeout protection: 10s for detect; 30s for translate (gpt-5.4 reasoning
    // calls can exceed 10s at medium effort).
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), isDetect ? 10000 : 30000);

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
    // user_id: now the verified token's user (was null until Phase 2.1 token auth).
    // tenant_id: sole-tenant constant (correct today); moves to a JWT claim at
    // multi-tenant. (decisions.md 2026-06-23 "Token auth on backend API calls".)
    logTranslationEvent({
      tenant_id: '00000000-0000-0000-0000-000000000001',
      task_id: null,
      user_id: principal.userId,
      target_language: targetLanguage ?? 'detect',
      was_cached: false,
      model_used: modelUsed,
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
🧠 PROFILE INFERENCE
========================================================
Server-side profile inference. The client fires-and-forgets the translate
response's `inferences` here, keyed by `message_id`. The server derives the
authoritative sender from the message row (trust boundary — decisions.md
2026-06-10), then applies the inference guards and writes the sender's profile
atomically (SELECT ... FOR UPDATE). Replaces the dead client-side applyInferences
path that RLS blocked. See server/lib/inferProfile.js.
*/
app.post('/api/v1/infer-profile', async (req, res) => {
  // Login required (trust boundary in inferProfile handles target resolution).
  const principal = await requireAuth(req, res);
  if (!principal) return; // 401/403 already sent

  try {
    const { message_id, inferences, detected_language } = req.body;

    if (!message_id) {
      return res.status(400).json({ error: 'Missing message_id' });
    }

    // Await the transaction: the caller fires-and-forgets, but the server must
    // finish the write before responding (mirrors the Vercel-freeze fix in
    // api/v1/translate.js — a write started but not awaited can be torn down).
    const result = await inferProfile({
      messageId: message_id,
      inferences,
      detectedLanguage: detected_language,
    });

    return res.json(result);
  } catch (err) {
    console.error('🔥 infer-profile ERROR:', err);
    return res.status(500).json({ error: 'Inference failed' });
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
