// Compares one-request-per-video Decisions calls with a single batched request on the same titles.
// Run this before changing the extension, to check the batched approach is accurate and works at all.
//
// Usage:  node scripts/compare-batch.mjs [titles.txt]
//   titles.txt: one video title per line. Without it, a small built-in sample is used.
//   The API key is read from the OPENAI_API_KEY environment variable. Never put it in this file.
import '../shared.js'; // defines globalThis.YTFF (API URL, model, default topics)
import { readFileSync } from 'node:fs';

const { API_URL, MODEL, DEFAULTS } = globalThis.YTFF;
const THRESHOLD = DEFAULTS.threshold;
const CONCURRENCY = 4;

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error('Set OPENAI_API_KEY in this terminal session first. Do not paste it into chat or source files.');
  process.exit(1);
}

const SAMPLE_TITLES = [
  'ICPC FINALIST on Competitive Programming Mindset, Discipline & Sacrifice',
  'How to mod a calculator to communicate with AI (with camera)',
  'Build Ola AI Data Agent | End-To-End Agentic AI Project For Beginners',
  'Master Microservices in 8 Hours | Java, Spring Boot, Docker',
  'Next.js 15 Tutorial - Beginner to Advanced',
  'Funny guy makes Royal Guard Laugh at Buckingham Palace',
  'Scared Man Goes Paragliding',
  'Every Type of Coffee Explained in (Hindi)',
  "Maharashtra's Water Masterplan Explained | River Links, Irrigation & Drought",
  'Ancient Humans दिन भर क्या करते थे?',
  'The Right Time for a Tetanus Injection | Dharmendra Sir',
  'Best & easiest Biriyani / Pulao type recipe ever !! Chicken Garlic Rice Recipe',
];

const titles = process.argv[2]
  ? readFileSync(process.argv[2], 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  : SAMPLE_TITLES;
const items = titles.map((title, i) => ({ ref: `v${i + 1}`, title, channel: '' }));

async function decide(body) {
  const t0 = performance.now();
  const resp = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  const ms = Math.round(performance.now() - t0);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 400)}`);
  return { data: await resp.json(), ms };
}

const answerOf = (data, name) => (data.answers || []).find((a) => a.name === name);

// Same request the extension sends today: one title per request.
async function runSingle(item) {
  const { data, ms } = await decide({
    model: MODEL,
    input: `Video title: ${item.title}\nChannel: ${item.channel}`,
    questions: [
      {
        type: 'predicate',
        name: 'relevant',
        instructions:
          'Return the probability that this YouTube video is about, or useful for, the following ' +
          `topics: ${DEFAULTS.focus}. Judge only from the title and channel name.`,
      },
    ],
  });
  const a = answerOf(data, 'relevant');
  return { p: a && typeof a.probability === 'number' ? a.probability : null, ms, tokens: data.usage?.input_tokens ?? 0 };
}

// Proposed request: all titles in one input, one predicate question per title.
// BATCH_STYLE=shared (default): topics appear once in the input, with short per-question instructions.
// BATCH_STYLE=per-question: each question repeats the exact instruction text used by the single request.
const BATCH_STYLE = process.env.BATCH_STYLE === 'per-question' ? 'per-question' : 'shared';

async function runBatch(list) {
  const perQuestion = BATCH_STYLE === 'per-question';
  const { data, ms } = await decide({
    model: MODEL,
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text:
              (perQuestion ? '' : `Viewer interests: ${DEFAULTS.focus}.\n\n`) +
              'Below is a list of YouTube videos. Each question asks about exactly one video, identified by its "ref". ' +
              'Judge every video independently, using only its title and channel name.',
          },
          { type: 'input_json', data: { videos: list } },
        ],
      },
    ],
    questions: list.map((it) => ({
      type: 'predicate',
      name: it.ref,
      instructions: perQuestion
        ? `For the video with ref "${it.ref}": return the probability that this YouTube video is about, or useful for, ` +
          `the following topics: ${DEFAULTS.focus}. Judge only from the title and channel name.`
        : `Return the probability that the video with ref "${it.ref}" is about, or useful for, ` +
          "the viewer's interests described in the input.",
    })),
  });
  const byRef = {};
  for (const it of list) {
    const a = answerOf(data, it.ref);
    byRef[it.ref] = a && typeof a.probability === 'number' ? a.probability : null;
  }
  return { byRef, ms, tokens: data.usage?.input_tokens ?? 0, answerCount: (data.answers || []).length };
}

async function pool(list, limit, fn) {
  const out = new Array(list.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, list.length) }, async () => {
      while (next < list.length) {
        const i = next++;
        out[i] = await fn(list[i]);
      }
    })
  );
  return out;
}

console.log(`Model: ${MODEL} | videos: ${items.length} | threshold: ${THRESHOLD} | batch style: ${BATCH_STYLE}\n`);

const tSingles = performance.now();
const singles = await pool(items, CONCURRENCY, runSingle);
const singlesWallMs = Math.round(performance.now() - tSingles);

// BATCH_SIZE=<n> splits the titles into several batch requests of at most n titles (default: one request).
const BATCH_SIZE = Number(process.env.BATCH_SIZE) || items.length;
const chunks = [];
for (let i = 0; i < items.length; i += BATCH_SIZE) chunks.push(items.slice(i, i + BATCH_SIZE));
const tBatch = performance.now();
const parts = await Promise.all(chunks.map(runBatch));
const batch = {
  byRef: Object.assign({}, ...parts.map((p) => p.byRef)),
  ms: Math.round(performance.now() - tBatch),
  tokens: parts.reduce((a, p) => a + p.tokens, 0),
  answerCount: parts.reduce((a, p) => a + p.answerCount, 0),
};

const fmt = (p) => (p === null ? ' n/a ' : p.toFixed(2).padStart(5));
console.log('single  batch   diff  title');
const diffs = [];
let agree = 0;
let compared = 0;
items.forEach((it, i) => {
  const s = singles[i].p;
  const b = batch.byRef[it.ref];
  let diff = '';
  if (s !== null && b !== null) {
    const d = Math.abs(s - b);
    diffs.push(d);
    compared++;
    if (s >= THRESHOLD === b >= THRESHOLD) agree++;
    diff = d.toFixed(2).padStart(5);
  }
  console.log(`${fmt(s)}  ${fmt(b)}  ${diff.padEnd(5)}  ${it.title.slice(0, 70)}`);
});

const mean = diffs.length ? diffs.reduce((a, b) => a + b, 0) / diffs.length : NaN;
console.log('\nSummary');
console.log(`  answers returned in batch: ${batch.answerCount} of ${items.length}`);
console.log(`  same show/hide decision:   ${agree} of ${compared}`);
console.log(`  mean / max probability gap: ${mean.toFixed(3)} / ${diffs.length ? Math.max(...diffs).toFixed(3) : 'n/a'}`);
console.log(`  requests:     ${items.length} single vs ${chunks.length} batch (size ${BATCH_SIZE})`);
console.log(`  input tokens: ${singles.reduce((a, s) => a + s.tokens, 0)} single total vs ${batch.tokens} batch`);
console.log(`  time:         ${singlesWallMs} ms for singles (${CONCURRENCY} at a time) vs ${batch.ms} ms for the batch`);
