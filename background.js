// Service worker: calls the OpenAI Decisions API on behalf of the content script.
// Videos are collected for a short time and classified in batches (one request, one question per video).
// The API key is read from chrome.storage.local and is never logged.
importScripts('shared.js');

const MAX_CONCURRENT = 4; // simultaneous API requests
const MAX_ATTEMPTS = 3;
const MAX_TITLE_CHARS = 200;
const BATCH_SIZE = 8; // videos per request
const BATCH_WAIT_MS = 150; // how long to wait for more videos before sending a partial batch

let active = 0;
const queue = [];
const inflight = new Map(); // videoId -> Promise (dedupes simultaneous requests for the same video)
let pendingItems = []; // videos waiting to be sent: { id, title, channel, resolve, reject }
let flushTimer = null;
let blockedUntil = 0; // set after an auth failure so we don't hammer the API with a bad key
const warned = new Set();

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !msg || msg.type !== 'classify') return;
  classify(msg).then(sendResponse, (err) => {
    warnOnce(err && err.message ? err.message : String(err));
    sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
  });
  return true; // keep the message channel open for the async response
});

function warnOnce(message) {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn('[YouTube Focus Filter]', message);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withStatus = (err, status) => Object.assign(err, { status });

// Limits how many API requests run at once.
function limit(task) {
  return new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    pump();
  });
}

function pump() {
  while (active < MAX_CONCURRENT && queue.length) {
    const { task, resolve, reject } = queue.shift();
    active++;
    task()
      .then(resolve, reject)
      .finally(() => {
        active--;
        pump();
      });
  }
}

async function classify({ id, title, channel }) {
  if (typeof id !== 'string' || !/^[\w-]{6,20}$/.test(id)) {
    return { ok: false, error: 'invalid video id' };
  }
  if (!inflight.has(id)) {
    const work = classifyUncached(id, title, channel).finally(() => inflight.delete(id));
    inflight.set(id, work);
  }
  return inflight.get(id);
}

async function classifyUncached(id, title, channel) {
  const cacheKey = YTFF.CACHE_PREFIX + id;
  const cached = (await chrome.storage.local.get(cacheKey))[cacheKey];
  if (cached && typeof cached.p === 'number') return { ok: true, p: cached.p };

  const { apiKey } = await chrome.storage.local.get('apiKey');
  if (!apiKey) {
    warnOnce('No OpenAI API key set. Open the extension options to add one. Videos are shown unfiltered.');
    return { ok: false, error: 'no-key' };
  }
  if (Date.now() < blockedUntil) return { ok: false, error: 'blocked' };

  const p = await enqueue({ id, title, channel });
  return { ok: true, p };
}

// --- Batching ---------------------------------------------------------------------------------

function enqueue(item) {
  return new Promise((resolve, reject) => {
    pendingItems.push({ ...item, resolve, reject });
    if (pendingItems.length >= BATCH_SIZE) flush();
    else if (flushTimer === null) flushTimer = setTimeout(flush, BATCH_WAIT_MS);
  });
}

function flush() {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  while (pendingItems.length) {
    const batch = pendingItems.splice(0, BATCH_SIZE);
    limit(() => runBatch(batch)).catch(() => {}); // runBatch settles every item itself
  }
}

// Classifies one batch and settles each item's promise with a probability, or rejects it.
async function runBatch(batch) {
  try {
    if (Date.now() < blockedUntil) throw new Error('blocked');
    const { apiKey } = await chrome.storage.local.get('apiKey');
    if (!apiKey) throw new Error('No OpenAI API key set.');
    const settings = await YTFF.getSettings();

    let probs;
    try {
      probs = await decide(apiKey, settings, batch);
    } catch (err) {
      // HTTP 400 on a multi-video request means the batched format was rejected: retry each video alone.
      if (err.status !== 400 || batch.length === 1) throw err;
      warnOnce('The batched request was rejected (HTTP 400). Falling back to one request per video.');
      probs = new Array(batch.length).fill(null);
    }

    // A video without a usable answer (missing, or refused) is retried on its own.
    if (batch.length > 1) {
      for (let i = 0; i < batch.length; i++) {
        if (probs[i] !== null) continue;
        try {
          probs[i] = (await decide(apiKey, settings, [batch[i]]))[0];
        } catch (err) {
          batch[i].reject(err);
          probs[i] = undefined; // already settled
        }
      }
    }

    const writes = {};
    batch.forEach((item, i) => {
      if (typeof probs[i] === 'number') writes[YTFF.CACHE_PREFIX + item.id] = { p: probs[i], t: Date.now() };
    });
    if (Object.keys(writes).length) await chrome.storage.local.set(writes);

    batch.forEach((item, i) => {
      if (typeof probs[i] === 'number') item.resolve(probs[i]);
      else if (probs[i] === null) item.reject(new Error('The OpenAI Decisions API returned no usable answer for a video.'));
    });
  } catch (err) {
    batch.forEach((item) => item.reject(err));
  }
}

// --- OpenAI Decisions API -----------------------------------------------------------------------

const clip = (s, n) => String(s || '').slice(0, n);

// One video: the request shape validated first (a single question about the input).
function singleBody(settings, item) {
  return {
    model: YTFF.MODEL,
    // The video text is untrusted, so it goes in `input` as data and not in the instructions.
    input: `Video title: ${clip(item.title, MAX_TITLE_CHARS)}\nChannel: ${clip(item.channel, 100)}`,
    questions: [
      {
        type: 'predicate',
        name: YTFF.QUESTION_NAME,
        instructions:
          'Return the probability that this YouTube video is about, or useful for, the following ' +
          `topics: ${settings.focus}. Judge only from the title and channel name.`,
      },
    ],
  };
}

// Several videos: one JSON list in the input, and one predicate question per video, named v1, v2, ...
function batchBody(settings, items) {
  return {
    model: YTFF.MODEL,
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
          {
            type: 'input_json',
            data: {
              videos: items.map((it, i) => ({
                ref: `v${i + 1}`,
                title: clip(it.title, MAX_TITLE_CHARS),
                channel: clip(it.channel, 100),
              })),
            },
          },
        ],
      },
    ],
    questions: items.map((_, i) => ({
      type: 'predicate',
      name: `v${i + 1}`,
      instructions:
        `For the video with ref "v${i + 1}": return the probability that this YouTube video is about, or useful for, ` +
        `the following topics: ${settings.focus}. Judge only from the title and channel name.`,
    })),
  };
}

// Returns one entry per item: a probability, or null when the answer is missing or refused.
async function decide(apiKey, settings, items) {
  const single = items.length === 1;
  const body = single ? singleBody(settings, items[0]) : batchBody(settings, items);
  const data = await post(apiKey, JSON.stringify(body));
  recordUsage(data && data.usage, items.length);
  return items.map((_, i) => probabilityOf(data, single ? YTFF.QUESTION_NAME : `v${i + 1}`));
}

// --- Usage statistics ---------------------------------------------------------------------------

// Updates run one after another, so concurrent requests don't overwrite each other's counts.
let statsChain = Promise.resolve();

function recordUsage(usage, videos) {
  const tokens = usage && typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
  statsChain = statsChain
    .then(async () => {
      const { stats } = await chrome.storage.local.get('stats');
      await chrome.storage.local.set({ stats: YTFF.addUsage(stats || YTFF.emptyStats(), tokens, videos) });
    })
    .catch((err) => warnOnce(`Could not record usage statistics: ${err.message}`));
}

function probabilityOf(data, name) {
  const answer = ((data && data.answers) || []).find((a) => a.name === name);
  if (!answer || answer.type === 'refusal' || typeof answer.probability !== 'number') return null;
  return answer.probability;
}

async function post(apiKey, body) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let resp;
    try {
      resp = await fetch(YTFF.API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body,
      });
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) throw new Error(`Network error calling OpenAI: ${err.message}`);
      await sleep(500 * 2 ** (attempt - 1));
      continue;
    }

    if (resp.ok) return resp.json();

    if (resp.status === 401 || resp.status === 403) {
      blockedUntil = Date.now() + 60_000;
      throw withStatus(
        new Error(`OpenAI rejected the API key (HTTP ${resp.status}). Check the key in the extension options.`),
        resp.status
      );
    }
    if ((resp.status === 429 || resp.status >= 500) && attempt < MAX_ATTEMPTS) {
      const retryAfter = Number(resp.headers.get('retry-after'));
      await sleep(retryAfter > 0 ? Math.min(retryAfter, 10) * 1000 : 1000 * 2 ** (attempt - 1));
      continue;
    }
    const text = await resp.text().catch(() => '');
    throw withStatus(new Error(`OpenAI HTTP ${resp.status}: ${text.slice(0, 200)}`), resp.status);
  }
  throw new Error('OpenAI request failed');
}
