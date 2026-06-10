import { inferProfile } from '../../server/lib/inferProfile.js';

/**
 * POST /api/v1/infer-profile — Vercel serverless handler.
 *
 * Mirror of the Express route in server/index.js. The client fires-and-forgets
 * the translate response's `inferences` here, keyed by `message_id`; the server
 * derives the authoritative sender from the message row (trust boundary —
 * decisions.md 2026-06-10) and writes the sender's profile atomically.
 *
 * We AWAIT inferProfile() before res.json(): Vercel freezes the function the
 * moment the response is sent, so a write that isn't awaited never completes
 * (same lesson as the translation_events fire-and-forget bug in Spec 4b).
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { message_id, inferences, detected_language } = req.body;

    if (!message_id) {
      return res.status(400).json({ error: 'Missing message_id' });
    }

    const result = await inferProfile({
      messageId: message_id,
      inferences,
      detectedLanguage: detected_language,
    });

    return res.status(200).json(result);
  } catch (err) {
    console.error('infer-profile error:', err);
    return res.status(500).json({ error: 'Inference failed' });
  }
}
