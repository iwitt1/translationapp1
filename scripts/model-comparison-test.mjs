#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS, IN PLAIN ENGLISH
 * ═══════════════════════════════════════════════════════════════════════════
 * This script helps us choose which AI model should power Jistchat's
 * translations. In July 2026 we upgraded to a smarter model (gpt-5.4) and
 * translation quality got much better, but each translation started taking
 * 7–10 seconds — too slow for a live chat.
 *
 * To pick the right balance of quality, speed, and cost, this script takes a
 * fixed set of 23 test messages (8 from a real test conversation, plus 15
 * "probes" designed to trigger specific known mistakes: wrong capitalization,
 * wrong gender endings in Spanish, losing formality, missing context from
 * earlier messages, mistranslating idioms and food names, and handling
 * Japanese/Chinese) and sends every one of them to six different model
 * configurations. It then prints a side-by-side table of what each model
 * produced, how long it took, and what it cost.
 *
 * A human reads the tables and judges quality; the script only measures what
 * a machine can measure (speed and price). It talks to OpenAI directly using
 * the exact same instructions ("prompt") the live app uses, so results are
 * faithful — but it never touches the app, the database, or any user data,
 * so there's nothing to log into and no email rate limits.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * TECHNICAL NOTES
 *
 * Purpose: roadmap "Next up — translate model selection" (2026-07-05).
 * Imports buildMessages from lib/translatePrompt.js — the same prompt builder
 * production uses, so the prompt is byte-identical to the live API.
 *
 * Usage:
 *   OPENAI_API_KEY must be set (reads .env at repo root via dotenv).
 *
 *     node scripts/model-comparison-test.mjs                 # full matrix
 *     node scripts/model-comparison-test.mjs --only gpt-5.4:low,gpt-4o-mini
 *     node scripts/model-comparison-test.mjs --cases 3,9,18  # subset of cases
 *     node scripts/model-comparison-test.mjs --repeat 3      # stability check
 *
 * Output:
 *   - Progress + per-case tables to stdout.
 *   - Full results to scripts/model-comparison-results.md (overwritten each run).
 *   - Besides the translation, each row shows the model's self-reported
 *     inference flags (register, gender, ambiguity) — these are part of the
 *     API contract we'd sell in Phase 2, so they're graded too.
 *
 * The test set is FROZEN by design: cases 1–8 are the real Peter↔Diego
 * staging conversation (2026-07-07 export), each with the same 3-message
 * history window the app sends (ConversationView.jsx i-3..i). Cases 9–23 are
 * targeted probes, 2 per known failure type, one per direction where a rule
 * cuts both ways; 22–23 are novel referent probes the prompt has never quoted
 * (anti-memorization checks for v2.1.0's rule 2). Don't edit existing cases
 * (comparisons across runs break); append new ones.
 *
 * Candidates and prices are hardcoded below — update PRICES if OpenAI changes
 * pricing (as of 2026-07-05, per developers.openai.com/api/docs/models).
 * NOT wired into CI or the app.
 */

import dotenv from 'dotenv';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildMessages, PROMPT_VERSION } from '../lib/translatePrompt.js';

// The OpenAI key lives in server/.env (the dev server's env file); also try
// the repo root .env. Paths are resolved relative to this script, so the
// command works from any directory.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: join(repoRoot, 'server', '.env') });
dotenv.config({ path: join(repoRoot, '.env') });

const API_KEY = process.env.OPENAI_API_KEY;
if (!API_KEY) {
  console.error('OPENAI_API_KEY not set (checked env + .env). Aborting.');
  process.exit(1);
}

// ── Candidates ────────────────────────────────────────────────────────────────
// label: display name; model: API id; reasoningEffort: null = param omitted;
// temperature: only sent when non-null (reasoning models reject it).
const CANDIDATES = [
  { label: 'gpt-5.4:medium',      model: 'gpt-5.4',      reasoningEffort: 'medium', temperature: null }, // current prod config
  { label: 'gpt-5.4:low',         model: 'gpt-5.4',      reasoningEffort: 'low',    temperature: null },
  { label: 'gpt-5.4:none',        model: 'gpt-5.4',      reasoningEffort: 'none',   temperature: null },
  { label: 'gpt-5.4-mini:medium', model: 'gpt-5.4-mini', reasoningEffort: 'medium', temperature: null },
  { label: 'gpt-5.4-mini:low',    model: 'gpt-5.4-mini', reasoningEffort: 'low',    temperature: null },
  { label: 'gpt-4o-mini (old)',   model: 'gpt-4o-mini',  reasoningEffort: null,     temperature: 0 },    // pre-2026-07-05 floor
];

// USD per 1M tokens. Reasoning tokens bill as output.
const PRICES = {
  'gpt-5.4':      { in: 2.50, out: 15.00 },
  'gpt-5.4-mini': { in: 0.75, out: 3.00 },  // VERIFY: output price assumed; check pricing page
  'gpt-4o-mini':  { in: 0.15, out: 0.60 },
};

// ── Speaker profiles (mirror what MessageBubble.jsx assembles) ───────────────
const DIEGO  = { user: { dialect: 'es-MX', formality: 'casual', known_languages: ['es'] } };
const PETER  = { user: { dialect: 'en-US', formality: 'casual', known_languages: ['en'] } };
const MARIA  = { user: { dialect: 'en-US', formality: 'casual', gender: 'feminine', known_languages: ['en'] } };
const NOGEN  = { user: { dialect: 'en-US', formality: 'casual', known_languages: ['en'] } }; // gender absent on purpose

// ── Frozen test set ───────────────────────────────────────────────────────────
// Cases 1–8: real Peter↔Diego staging conversation. 9–21: targeted probes.
const CONVO = [
  { sender: 'diego', text: 'Güey ya llegué al restaurante y no hay NADIE jajaja', lang: 'es' },
  { sender: 'peter', text: "No shot you're actually early for once lol", lang: 'en' },
  { sender: 'diego', text: 'Una vez en la vida!! No seas payaso 😂', lang: 'es' },
  { sender: 'peter', text: "Ok ok I'm 10 min out. Order me whatever, you know what I like", lang: 'en' },
  { sender: 'diego', text: 'Te pedí los tacos de canasta, confía', lang: 'es' },
  { sender: 'peter', text: "That's why we're friends. Save me a seat by the window?", lang: 'en' },
  { sender: 'diego', text: 'Ya te la aparté, pero si tardas más de 10 min me como tus tacos eh', lang: 'es' },
  { sender: 'peter', text: 'Fair enough lol', lang: 'en' },
];

function historyFor(i) {
  return CONVO.slice(Math.max(0, i - 3), i).map((m) => ({
    sender_id: m.sender,
    original_text: m.text,
    source_language: m.lang,
  }));
}

const CASES = [
  // ── 1–8: the real conversation (integration test) ──────────────────────────
  ...CONVO.map((m, i) => ({
    id: i + 1,
    name: `convo #${i + 1} (${m.sender} → ${m.lang === 'es' ? 'en' : 'es'})`,
    text: m.text,
    targetLanguage: m.lang === 'es' ? 'en' : 'es',
    context: m.sender === 'diego' ? DIEGO : PETER,
    contextType: 'casual',
    history: historyFor(i),
    watchFor:
      i === 0 ? 'v2.0.0 lowercased this despite proper caps ("dude i got...")' :
      i === 2 ? 'CONTEXT: refers to Peter being early — "once in a lifetime / for once in YOUR life", not "my life"' :
      i === 4 ? 'must keep "tacos de canasta" untranslated' :
      i === 6 ? 'v2.0.0 lowercased + "i\'m"; "eh" pragmatics' :
      'general nuance + casing fidelity',
  })),

  // ── Casing (both directions of the mirror rule) ─────────────────────────────
  {
    id: 9,
    name: 'casing A: proper caps + heavy slang (en → es)',
    text: "Bro I can't even lie, that concert was INSANE. I'm still deaf lol",
    targetLanguage: 'es', context: PETER, contextType: 'casual', history: [],
    watchFor: 'sender capitalizes properly — output must too, despite slang density',
  },
  {
    id: 10,
    name: 'casing B: all-lowercase sender stays lowercase (en → es)',
    text: 'yo whats up, we still on for tonight or nah',
    targetLanguage: 'es', context: PETER, contextType: 'casual', history: [],
    watchFor: 'sender writes all-lowercase — output must NOT be corrected to proper caps',
  },

  // ── Gender agreement ────────────────────────────────────────────────────────
  {
    id: 11,
    name: 'gender A: feminine speaker, adjective agreement (en → es)',
    text: "I'm exhausted after today, I'm just glad it's over",
    targetLanguage: 'es', context: MARIA, contextType: 'casual', history: [],
    watchFor: 'profile says feminine → "cansada/agotada", never "cansado/agotado"',
  },
  {
    id: 12,
    name: 'gender B: unknown gender, agreement forced (en → es)',
    text: "I'm so excited for tomorrow",
    targetLanguage: 'es', context: NOGEN, contextType: 'casual', history: [],
    watchFor: 'no gender in profile — does it default masculine ("emocionado") or find neutral phrasing ("me emociona mucho")? masculine default = product bug',
  },

  // ── Register / formality ────────────────────────────────────────────────────
  {
    id: 13,
    name: 'register A: formal message from casual-profile user (en → es)',
    text: 'Good evening, I wanted to confirm our meeting tomorrow at 3 PM. Please let me know if that still works.',
    targetLanguage: 'es', context: PETER, contextType: 'casual', history: [],
    watchFor: 'formal message must STAY formal (usted register) even though profile says casual',
  },
  {
    id: 14,
    name: 'register B: professional context type, T-V choice (en → es)',
    text: 'Can you send over the report when you get a chance? No rush.',
    targetLanguage: 'es', context: PETER, contextType: 'professional', history: [],
    watchFor: 'contextType=professional (first non-casual test of the modifier path) → usted forms, workplace tone kept',
  },

  // ── Context / history resolution ────────────────────────────────────────────
  {
    id: 15,
    name: 'context A: reaction needing history (es → en)',
    text: 'Jajaja no lo puedo creer, hasta que por fin',
    targetLanguage: 'en', context: DIEGO, contextType: 'casual',
    history: [
      { sender_id: 'peter', original_text: 'Guess who finally got the promotion', source_language: 'en' },
    ],
    watchFor: '"hasta que por fin" = "finally!/about time" reacting to Peter\'s news — needs history',
  },
  {
    id: 16,
    name: 'context B: pronoun referent from history (en → es)',
    text: "She's going to love it, trust me",
    targetLanguage: 'es', context: PETER, contextType: 'casual',
    history: [
      { sender_id: 'peter', original_text: 'I finally bought my mom that necklace she kept looking at', source_language: 'en' },
    ],
    watchFor: '"she" = the mom from history → "le va a encantar" with correct referent, no invented subject',
  },

  // ── Idiom (incoming direction) ──────────────────────────────────────────────
  {
    id: 17,
    name: 'idiom: "crudo" = hungover, not raw (es → en)',
    text: 'No mames, estoy bien crudo, anoche fue demasiado',
    targetLanguage: 'en', context: DIEGO, contextType: 'casual', history: [],
    watchFor: '"crudo" (MX) = hungover — "raw" is the literal-translation failure; "no mames" energy kept',
  },

  // ── Ambiguity flag ──────────────────────────────────────────────────────────
  {
    id: 18,
    name: 'ambiguity: "that\'s sick" — cool vs ill (en → es)',
    text: "That's sick man",
    targetLanguage: 'es', context: PETER, contextType: 'casual', history: [],
    watchFor: 'genuinely ambiguous with no history — ambiguity.detected should fire with both readings in alternatives',
  },

  // ── Novel referent probes (added 2026-07-07 with prompt v2.1.0) ────────────
  // Rule 2 of v2.1.0 quotes cases 3 and 16 as examples, so those two can no
  // longer prove the rule generalizes (the model may match them verbatim).
  // These two use the same failure pattern with wording the prompt has never
  // seen. If 3/16 pass but 22/23 fail, the rule memorized, not generalized.
  {
    id: 22,
    name: 'referent (novel) A: elliptical "her" from history (en → es)',
    text: "Tell her I said hi! Can't wait to finally meet her",
    targetLanguage: 'es', context: PETER, contextType: 'casual',
    history: [
      { sender_id: 'diego', original_text: 'Mi hermana llega mañana de Madrid', source_language: 'es' },
    ],
    watchFor: '"her" = Diego\'s sister from history → "dile que..." with correct referent, no invented subject',
  },
  {
    id: 23,
    name: 'referent (novel) B: reaction about the OTHER speaker (es → en)',
    text: 'Ya era hora!! Si llevas años hablando de eso',
    targetLanguage: 'en', context: DIEGO, contextType: 'casual',
    history: [
      { sender_id: 'peter', original_text: 'Guys. I finally adopted a dog', source_language: 'en' },
    ],
    watchFor: '"About time!! YOU\'ve been talking about it for years" — about Peter, not rewritten as if about the sender ("I\'ve been...")',
  },

  // ── CJK block (coverage signal; Claude judges, native speaker later) ────────
  {
    id: 19,
    name: 'CJK A: casual Japanese + laughter conversion (en → ja)',
    text: "lmaooo no way you actually did that",
    targetLanguage: 'ja', context: PETER, contextType: 'casual', history: [],
    watchFor: 'casual register (no です/ます), laughter → 笑/w/ｗ, not a stiff textbook sentence',
  },
  {
    id: 20,
    name: 'CJK B: formal Japanese keigo (en → ja)',
    text: 'Good evening, I wanted to confirm our meeting tomorrow at 3 PM. Please let me know if that still works.',
    targetLanguage: 'ja', context: PETER, contextType: 'professional', history: [],
    watchFor: 'proper keigo (です/ます minimum, ideally 確認させていただきたい register) — the hardest formality test in the set',
  },
  {
    id: 21,
    name: 'CJK C: casual Chinese + cultural item (en → zh)',
    text: "hahaha ok I'm coming over, save me some tamales",
    targetLanguage: 'zh', context: PETER, contextType: 'casual', history: [],
    watchFor: 'laughter → 哈哈哈, "tamales" kept (transliterated or named, not literally glossed), casual tone',
  },
];

// ── Arg parsing ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const argVal = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
const onlyArg = argVal('--only');
const casesArg = argVal('--cases');
const repeat = Math.max(1, parseInt(argVal('--repeat') ?? '1', 10) || 1);

const candidates = onlyArg
  ? CANDIDATES.filter((c) => onlyArg.split(',').includes(c.label) || onlyArg.split(',').includes(c.model))
  : CANDIDATES;
const cases = casesArg
  ? CASES.filter((c) => casesArg.split(',').map(Number).includes(c.id))
  : CASES;

// ── OpenAI call ───────────────────────────────────────────────────────────────
async function translateWith(candidate, testCase) {
  const messages = buildMessages({
    mode: 'translate',
    text: testCase.text,
    targetLanguage: testCase.targetLanguage,
    contextType: testCase.contextType ?? 'casual',
    context: testCase.context,
    history: testCase.history,
  });

  const body = {
    model: candidate.model,
    messages,
    response_format: { type: 'json_object' },
  };
  if (candidate.reasoningEffort !== null) body.reasoning_effort = candidate.reasoningEffort;
  if (candidate.temperature !== null) body.temperature = candidate.temperature;

  const start = Date.now();
  let res, data;
  try {
    res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify(body),
    });
    data = await res.json();
  } catch (err) {
    return { error: `network: ${err.message}`, latencyMs: Date.now() - start };
  }
  const latencyMs = Date.now() - start;

  if (!res.ok) {
    return { error: data?.error?.message ?? `HTTP ${res.status}`, latencyMs };
  }

  let parsed = null;
  try {
    parsed = JSON.parse(data.choices[0].message.content);
  } catch {
    return { error: 'unparseable JSON', latencyMs, raw: data.choices[0]?.message?.content };
  }

  const inTok = data.usage?.prompt_tokens ?? 0;
  const outTok = data.usage?.completion_tokens ?? 0; // includes reasoning tokens
  const price = PRICES[candidate.model] ?? { in: 0, out: 0 };
  const costUsd = (inTok * price.in + outTok * price.out) / 1e6;

  // Inference flags — part of the API contract, graded alongside the text.
  const inf = parsed.inferences ?? {};
  const amb = parsed.ambiguity ?? {};
  const flags = [
    inf.detected_register ? `reg:${inf.detected_register}` : null,
    inf.gender_signal ? `gen:${inf.gender_signal}` : null,
    amb.detected ? `amb:✓(${(amb.alternatives ?? []).length} alts)` : 'amb:—',
  ].filter(Boolean).join(' ');

  return {
    translation: parsed.translated_text ?? '(missing translated_text)',
    flags,
    latencyMs,
    inTok,
    outTok,
    reasoningTok: data.usage?.completion_tokens_details?.reasoning_tokens ?? null,
    costUsd,
  };
}

// ── Run ───────────────────────────────────────────────────────────────────────
const md = [];
md.push(`# Model comparison run — ${new Date().toISOString()}`);
md.push(`Prompt version: ${PROMPT_VERSION} (via lib/translatePrompt.js — identical to production). Repeat: ${repeat}×\n`);

const summary = {}; // label -> { totalLatency, totalCost, n, errors }

for (const testCase of cases) {
  const header = `## Case ${testCase.id}: ${testCase.name}`;
  console.log(`\n${header}`);
  console.log(`   original:  ${testCase.text}`);
  console.log(`   watch for: ${testCase.watchFor}`);
  md.push(header);
  md.push(`**Original:** \`${testCase.text}\`  `);
  md.push(`**Watch for:** ${testCase.watchFor}\n`);
  md.push('| candidate | translation | flags | latency | out tok (reasoning) | cost |');
  md.push('|---|---|---|---|---|---|');

  for (const candidate of candidates) {
    for (let run = 1; run <= repeat; run++) {
      const r = await translateWith(candidate, testCase);
      const runLabel = repeat > 1 ? `${candidate.label} (run ${run})` : candidate.label;
      summary[candidate.label] ??= { totalLatency: 0, totalCost: 0, n: 0, errors: 0 };
      const s = summary[candidate.label];

      if (r.error) {
        s.errors += 1;
        console.log(`   ${runLabel.padEnd(26)} ERROR: ${r.error}`);
        md.push(`| ${runLabel} | ⚠️ ERROR: ${r.error} | — | ${r.latencyMs} ms | — | — |`);
      } else {
        s.totalLatency += r.latencyMs;
        s.totalCost += r.costUsd;
        s.n += 1;
        const reason = r.reasoningTok !== null ? ` (${r.reasoningTok})` : '';
        console.log(`   ${runLabel.padEnd(26)} ${r.latencyMs}ms  $${r.costUsd.toFixed(5)}  [${r.flags}]  ${r.translation}`);
        md.push(`| ${runLabel} | ${r.translation.replace(/\|/g, '\\|')} | ${r.flags} | ${r.latencyMs} ms | ${r.outTok}${reason} | $${r.costUsd.toFixed(5)} |`);
      }
    }
  }
  md.push('');
}

// ── Summary ───────────────────────────────────────────────────────────────────
md.push('## Summary (averages over successful calls)');
md.push('| candidate | avg latency | avg cost/call | est. cost/1k msgs | errors |');
md.push('|---|---|---|---|---|');
console.log('\n=== SUMMARY ===');
for (const [label, s] of Object.entries(summary)) {
  const avgLat = s.n ? Math.round(s.totalLatency / s.n) : 0;
  const avgCost = s.n ? s.totalCost / s.n : 0;
  const line = `${label.padEnd(20)} avg ${avgLat}ms  $${avgCost.toFixed(5)}/call  ~$${(avgCost * 1000).toFixed(2)}/1k msgs  errors:${s.errors}`;
  console.log(line);
  md.push(`| ${label} | ${avgLat} ms | $${avgCost.toFixed(5)} | ~$${(avgCost * 1000).toFixed(2)} | ${s.errors} |`);
}

// Timestamped filename so successive runs (e.g. prompt v2.0.0 vs v2.1.0) sit
// side by side instead of overwriting each other.
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outPath = join(
  dirname(fileURLToPath(import.meta.url)),
  `model-comparison-results-${stamp}-prompt${PROMPT_VERSION}.md`
);
writeFileSync(outPath, md.join('\n'));
console.log(`\nFull results written to ${outPath}`);
