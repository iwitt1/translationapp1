import {
  buildMessages,
  PROMPT_VERSION,
  TRANSLATE_MODEL,
  TRANSLATE_REASONING_EFFORT,
  DETECT_MODEL,
} from '../../lib/translatePrompt.js';
import { logTranslationEvent } from '../../server/lib/events.js';
import { requireAuth } from '../../server/lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

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

    // ── Event log (awaited on Vercel serverless) ───────────────────────────
    // was_cached: hardcoded false — no cache check exists in this path yet.
    // Known gap: update when message_translations cache is wired (Spec 4b report §known-gaps).
    // user_id: now the verified token's user (was null until Phase 2.1 token auth).
    // tenant_id: sole-tenant constant (correct today); moves to a JWT claim at
    // multi-tenant. (decisions.md 2026-06-23 "Token auth on backend API calls".)
    // Vercel freezes the process the moment res.json() is called, so a
    // fire-and-forget write never completes. We await here to ensure the row
    // lands before the response is sent. logTranslationEvent() swallows its
    // own errors, so this cannot throw or slow down a failure path.
    await logTranslationEvent({
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

    return res.status(200).json(parsed);
  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
