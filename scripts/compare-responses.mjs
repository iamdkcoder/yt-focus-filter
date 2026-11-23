// Experiment: classify the same labeled titles three ways and compare cost, latency, and accuracy.
//
//   A  Decisions API, one request per video              (the original extension design)
//   B  Decisions API, batches of 8                        (the current extension design)
//   C  Responses API, ALL titles + ids in one string input, one system instruction,
//      structured output { results: [ { id, score } ] }   (one run per reasoning effort in EFFORTS)
//
// Usage:  node scripts/compare-responses.mjs [labeled-titles.tsv]
//   TSV format: "<show|hide|skip><TAB><title>" per line; "#" lines are comments. "skip" = ambiguous, not scored for accuracy.
//   Without a file, scripts/sample-titles.tsv is used.
// Environment:
//   OPENAI_API_KEY  required (never put it in a file)
//   REPEATS=3       how many times to repeat every method (latency and scores vary run to run)
//   EFFORTS=default,none   reasoning efforts for method C. "default" omits the parameter (API default).
//   THRESHOLD=0.6   score at or above which a video counts as "show"
import '../shared.js'; // defines globalThis.YTFF (API URL, model, default topics)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { API_URL, MODEL, DEFAULTS } = globalThis.YTFF;
const RESPONSES_URL = API_URL.replace(/\/decisions$/, '/responses');
const FOCUS = DEFAULTS.focus;
const THRESHOLD = Number(process.env.THRESHOLD) || DEFAULTS.threshold;
const REPEATS = Math.max(1, Number(process.env.REPEATS) || 3);
const EFFORTS = (process.env.EFFORTS || 'default,none').split(',').map((s) => s.trim()).filter(Boolean);
const CONCURRENCY = 4; // same cap as the extension's service worker
const BATCH_SIZE = 8;
const MAX_OUTPUT_TOKENS = 8000; // includes reasoning tokens; a truncated response is reported as a failure

// USD per 1M tokens, gpt-6-luna Standard tier, from OpenAI's pricing page. The Batch tier is exactly half of each.
// The cache-write rate used here is the 30-minute one.
const PRICE = { input: 0.1, cached: 0.01, cacheWrite: 0.125, output: 0.5 };

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error('Set OPENAI_API_KEY in this terminal session first. Do not paste it into chat or source files.');
  process.exit(1);
}

// --- Input ----------------------------------------------------------------------------------------

const file = process.argv[2] || fileURLToPath(new URL('./sample-titles.tsv', import.meta.url));
const items = readFileSync(file, 'utf8')
  .split(/\r?\n/)
  .filter((l) => l.trim() && !l.startsWith('#'))
  .map((line) => {
    const [label, ...rest] = line.split('\t');
    if (!['show', 'hide', 'skip'].includes(label) || !rest.length) throw new Error(`Bad line (expected "label<TAB>title"): ${line.slice(0, 60)}`);
    return { label, title: rest.join('\t').trim() };
  });

// Realistic 11-character YouTube-style ids (seeded, so every run uses the same ones).
function makeIds(n) {
  let s = 123456789;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  return Array.from({ length: n }, () => Array.from({ length: 11 }, () => chars[Math.floor(rnd() * 64)]).join(''));
}
makeIds(items.length).forEach((id, i) => (items[i].id = id));

// --- HTTP + usage -----------------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(url, body) {
  for (let attempt = 1; ; attempt++) {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    if (resp.ok) return resp.json();
    if ((resp.status === 429 || resp.status >= 500) && attempt < 3) {
      await sleep(1000 * 2 ** (attempt - 1));
      continue;
    }
    const err = new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    err.status = resp.status;
    throw err;
  }
}

const zeroUsage = () => ({ input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 });

function readUsage(u, charged) {
  u = u || {};
  return {
    input: u.input_tokens || 0,
    cached: u.input_tokens_details?.cached_tokens || 0,
    cacheWrite: u.input_tokens_details?.cache_write_tokens || 0,
    output: charged ? u.output_tokens || 0 : 0, // Decisions does not charge for output tokens
    reasoning: u.output_tokens_details?.reasoning_tokens || 0,
  };
}

function addUsage(total, u) {
  for (const k of Object.keys(total)) total[k] += u[k];
}

function costOf(u, batchTier = false) {
  const uncached = Math.max(0, u.input - u.cached - u.cacheWrite);
  const usd = (uncached * PRICE.input + u.cached * PRICE.cached + u.cacheWrite * PRICE.cacheWrite + u.output * PRICE.output) / 1e6;
  return batchTier ? usd / 2 : usd;
}

async function pool(list, limit, fn) {
  const out = new Array(list.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, list.length) }, async () => {
      while (next < list.length) {
        const i = next++;
        out[i] = await fn(list[i], i);
      }
    })
  );
  return out;
}

const answerOf = (data, name) => (data.answers || []).find((a) => a.name === name);
const probOf = (a) => (a && typeof a.probability === 'number' ? a.probability : null);

// --- Method A: Decisions, one request per video ------------------------------------------------------

async function methodA() {
  const usage = zeroUsage();
  const t0 = performance.now();
  const scores = await pool(items, CONCURRENCY, async (item) => {
    const data = await post(API_URL, {
      model: MODEL,
      input: `Video title: ${item.title}\nChannel: `,
      questions: [
        {
          type: 'predicate',
          name: 'relevant',
          instructions:
            'Return the probability that this YouTube video is about, or useful for, the following ' +
            `topics: ${FOCUS}. Judge only from the title and channel name.`,
        },
      ],
    });
    addUsage(usage, readUsage(data.usage, false));
    return probOf(answerOf(data, 'relevant'));
  });
  return { scores, usage, requests: items.length, ms: Math.round(performance.now() - t0), idErrors: 0 };
}

// --- Method B: Decisions, batches of 8 ---------------------------------------------------------------

async function methodB() {
  const usage = zeroUsage();
  const chunks = [];
  for (let i = 0; i < items.length; i += BATCH_SIZE) chunks.push(items.slice(i, i + BATCH_SIZE));
  const t0 = performance.now();
  const parts = await pool(chunks, CONCURRENCY, async (chunk) => {
    const list = chunk.map((it, i) => ({ ref: `v${i + 1}`, title: it.title, channel: '' }));
    const data = await post(API_URL, {
      model: MODEL,
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text:
                'Below is a list of YouTube videos. Each question asks about exactly one video, identified by its "ref". ' +
                'Judge every video independently, using only its title and channel name.',
            },
            { type: 'input_json', data: { videos: list } },
          ],
        },
      ],
      questions: list.map((v) => ({
        type: 'predicate',
        name: v.ref,
        instructions:
          `For the video with ref "${v.ref}": return the probability that this YouTube video is about, or useful for, ` +
          `the following topics: ${FOCUS}. Judge only from the title and channel name.`,
      })),
    });
    addUsage(usage, readUsage(data.usage, false));
    return list.map((v) => probOf(answerOf(data, v.ref)));
  });
  return { scores: parts.flat(), usage, requests: chunks.length, ms: Math.round(performance.now() - t0), idErrors: 0 };
}

// --- Method C: Responses API, everything in one request --------------------------------------------------

const SYSTEM_INSTRUCTION =
  `You rate YouTube videos for a viewer who only wants to see videos about: ${FOCUS}.\n` +
  'For every video in the input, give a score from 0 to 1: the probability that the video is about, or useful for, those topics. ' +
  'Judge each video independently, using only its title.\n' +
  'Return exactly one result per input line, using the id from that line. Do not add, skip, merge, or rename ids.';

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, score: { type: 'number' } },
        required: ['id', 'score'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
};

function responseText(data) {
  if (typeof data.output_text === 'string') return data.output_text;
  let text = '';
  for (const item of data.output || []) {
    if (item.type !== 'message') continue;
    for (const part of item.content || []) {
      if (part.type === 'refusal') throw new Error(`model refused: ${String(part.refusal).slice(0, 120)}`);
      if (part.type === 'output_text') text += part.text;
    }
  }
  return text;
}

async function methodC(effort) {
  const body = {
    model: MODEL,
    instructions: SYSTEM_INSTRUCTION,
    input: 'Videos, one per line as "id | title":\n' + items.map((it) => `${it.id} | ${it.title}`).join('\n'),
    text: { format: { type: 'json_schema', name: 'video_scores', strict: true, schema: OUTPUT_SCHEMA } },
    max_output_tokens: MAX_OUTPUT_TOKENS,
    store: false,
  };
  if (effort !== 'default') body.reasoning = { effort };

  const t0 = performance.now();
  const data = await post(RESPONSES_URL, body);
  const ms = Math.round(performance.now() - t0);
  const usage = readUsage(data.usage, true);
  const failed = (error) => ({ scores: items.map(() => null), usage, requests: 1, ms, idErrors: items.length, error });

  if (data.status === 'incomplete') return failed(`incomplete: ${data.incomplete_details?.reason}`);
  let parsed;
  try {
    parsed = JSON.parse(responseText(data));
  } catch (err) {
    return failed(`unparseable output: ${err.message}`);
  }
  const byId = new Map();
  let idErrors = 0;
  for (const r of parsed.results || []) {
    if (byId.has(r.id)) idErrors++; // duplicate
    else byId.set(r.id, r.score);
  }
  const known = new Set(items.map((it) => it.id));
  for (const id of byId.keys()) if (!known.has(id)) idErrors++; // invented or altered id
  const scores = items.map((it) => {
    if (!byId.has(it.id)) {
      idErrors++; // missing
      return null;
    }
    const s = byId.get(it.id);
    return typeof s === 'number' && Number.isFinite(s) ? Math.min(1, Math.max(0, s)) : null;
  });
  return { scores, usage, requests: 1, ms, idErrors };
}

// --- Run -------------------------------------------------------------------------------------------------

const methods = [
  { key: 'A', name: 'Decisions, 1 per video', run: methodA },
  { key: 'B', name: `Decisions, batches of ${BATCH_SIZE}`, run: methodB },
  ...EFFORTS.map((e) => ({ key: `C:${e}`, name: `Responses, 1 call, effort=${e}`, run: () => methodC(e) })),
];
for (const m of methods) {
  m.runs = [];
  m.unsupported = null;
}

console.log(`Model: ${MODEL} | titles: ${items.length} | repeats: ${REPEATS} | threshold: ${THRESHOLD} | file: ${file}`);
const labeled = items.filter((it) => it.label !== 'skip');
console.log(`Labeled: ${labeled.filter((i) => i.label === 'show').length} show, ${labeled.filter((i) => i.label === 'hide').length} hide, ${items.length - labeled.length} skipped (ambiguous)\n`);

for (let r = 1; r <= REPEATS; r++) {
  for (const m of methods) {
    if (m.unsupported) continue;
    try {
      const res = await m.run();
      m.runs.push(res);
      console.log(`run ${r}/${REPEATS}  ${m.name.padEnd(34)} ${String(res.ms).padStart(6)} ms${res.error ? `  FAILED: ${res.error}` : ''}`);
    } catch (err) {
      m.unsupported = err.message;
      console.log(`run ${r}/${REPEATS}  ${m.name.padEnd(34)} ERROR, skipping this method: ${err.message}`);
    }
  }
}

// --- Report ----------------------------------------------------------------------------------------------

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};
const meanScores = (m) => items.map((_, i) => mean(m.runs.map((r) => r.scores[i]).filter((s) => s !== null)));

function accuracy(scores) {
  let tp = 0, fn = 0, tn = 0, fp = 0, unscored = 0;
  items.forEach((it, i) => {
    if (it.label === 'skip') return;
    const s = scores[i];
    if (s === null || Number.isNaN(s)) return void unscored++;
    const shown = s >= THRESHOLD;
    if (it.label === 'show') shown ? tp++ : fn++;
    else shown ? fp++ : tn++;
  });
  const n = tp + fn + tn + fp + unscored; // a video with no usable score counts as a wrong answer
  return { acc: n ? (100 * (tp + tn)) / n : NaN, fn, fp, unscored };
}

const ok = methods.filter((m) => m.runs.length);
const baseline = ok.find((m) => m.key === 'A');
const baseScores = baseline ? meanScores(baseline) : null;
const f = (x, d = 4) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');

console.log('\nCost, latency, and accuracy (averages over repeats)\n');
const header = ['method', 'req', 'in tok', 'out tok', 'reason', '$/run', '$/1k titles', 'batch-tier $/1k', 'ms (median)', 'acc %', 'FN', 'FP', 'id err', '|diff| vs A'];
const rows = ok.map((m) => {
  const u = zeroUsage();
  m.runs.forEach((r) => addUsage(u, r.usage));
  const n = m.runs.length;
  const avgUsage = Object.fromEntries(Object.entries(u).map(([k, v]) => [k, v / n]));
  const perRun = costOf(avgUsage);
  const accs = m.runs.map((r) => accuracy(r.scores));
  const ms = meanScores(m);
  const diff = baseScores && m !== baseline ? mean(ms.map((s, i) => Math.abs(s - baseScores[i])).filter(Number.isFinite)) : NaN;
  return [
    m.name,
    String(Math.round(mean(m.runs.map((r) => r.requests)))),
    String(Math.round(avgUsage.input)),
    String(Math.round(avgUsage.output)),
    String(Math.round(avgUsage.reasoning)),
    f(perRun, 5),
    f((perRun / items.length) * 1000, 4),
    f((costOf(avgUsage, true) / items.length) * 1000, 4),
    String(Math.round(median(m.runs.map((r) => r.ms)))),
    f(mean(accs.map((a) => a.acc)), 1),
    f(mean(accs.map((a) => a.fn)), 1),
    f(mean(accs.map((a) => a.fp)), 1),
    f(mean(m.runs.map((r) => r.idErrors)), 1),
    f(diff, 3),
  ];
});
const widths = header.map((h, c) => Math.max(h.length, ...rows.map((r) => r[c].length)));
console.log(header.map((h, c) => h.padEnd(widths[c])).join('  '));
rows.forEach((r) => console.log(r.map((v, c) => (c === 0 ? v.padEnd(widths[c]) : v.padStart(widths[c]))).join('  ')));

console.log('\nNotes');
console.log('  FN = a "show" video that was hidden; FP = a "hide" video that was shown. Both use the threshold above.');
console.log('  A video with no usable score (missing id, bad output) counts as a wrong answer in "acc %". "id err" counts missing, duplicate, and invented ids.');
console.log('  Decisions does not charge for output tokens; Responses charges output including reasoning tokens.');
console.log('  Cost = tokens x gpt-6-luna Standard prices; "batch-tier" is half of that. The Batch API turnaround is not stated, so it is not tested.');
for (const m of methods) if (m.unsupported) console.log(`  ${m.name}: not run (${m.unsupported})`);

// Separation: how far apart the scores of "show" and "hide" videos are (positive = a threshold exists that gets all of them right).
console.log('\nSeparation of labeled videos (lowest "show" score minus highest "hide" score, from mean scores)');
for (const m of ok) {
  const ms = meanScores(m);
  const shows = items.map((it, i) => (it.label === 'show' ? ms[i] : null)).filter(Number.isFinite);
  const hides = items.map((it, i) => (it.label === 'hide' ? ms[i] : null)).filter(Number.isFinite);
  const spread = mean(items.map((_, i) => {
    const s = m.runs.map((r) => r.scores[i]).filter((x) => x !== null);
    return s.length > 1 ? Math.max(...s) - Math.min(...s) : null;
  }).filter(Number.isFinite));
  console.log(`  ${m.name.padEnd(34)} ${f(Math.min(...shows) - Math.max(...hides), 2).padStart(6)}   avg score range across repeats: ${f(spread, 3)}`);
}

// Per-title view of the mean score from each method.
console.log('\nPer-title mean scores');
console.log(['label'.padEnd(5), ...ok.map((m) => m.key.padStart(8)), 'title'].join('  '));
const allMeans = ok.map(meanScores);
items.forEach((it, i) => {
  console.log([it.label.padEnd(5), ...allMeans.map((ms) => f(ms[i], 2).padStart(8)), it.title.slice(0, 60)].join('  '));
});
