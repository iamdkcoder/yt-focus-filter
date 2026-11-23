const $ = (id) => document.getElementById(id);

function setStatus(message, isError = false) {
  const el = $('status');
  el.textContent = message;
  el.className = isError ? 'err' : '';
}

// One entry per line; trims, drops blanks, and removes case-insensitive duplicates.
function parseList(text) {
  const seen = new Set();
  const out = [];
  for (const line of text.split('\n')) {
    const name = line.replace(/\s+/g, ' ').trim();
    const key = name.toLowerCase();
    if (name && !seen.has(key)) {
      seen.add(key);
      out.push(name);
    }
  }
  return out;
}

async function load() {
  const settings = await YTFF.getSettings();
  const { apiKey } = await chrome.storage.local.get('apiKey');
  $('enabled').checked = settings.enabled;
  $('debug').checked = settings.debug;
  $('focus').value = settings.focus;
  $('allowChannels').value = settings.allowChannels.join('\n');
  $('blockChannels').value = settings.blockChannels.join('\n');
  $('blockKeywords').value = settings.blockKeywords.join('\n');
  $('blockChannelPatterns').value = settings.blockChannelPatterns.join('\n');
  $('studyWords').value = settings.studyWords.join('\n');
  $('threshold').value = settings.threshold;
  $('thresholdValue').textContent = settings.threshold;
  $('price').value = settings.inputPricePerMillion;
  $('keyHint').textContent = apiKey ? 'A key is saved. Leave the field empty to keep it.' : 'No key saved yet.';
}

async function clearCache() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(YTFF.CACHE_PREFIX));
  if (keys.length) await chrome.storage.local.remove(keys);
  return keys.length;
}

$('threshold').addEventListener('input', (e) => {
  $('thresholdValue').textContent = e.target.value;
});

$('save').addEventListener('click', async () => {
  const focus = $('focus').value.trim();
  if (!focus) return setStatus('The topics field cannot be empty.', true);

  const previous = await YTFF.getSettings();
  const price = $('price').value === '' ? NaN : Number($('price').value);
  const settings = {
    enabled: $('enabled').checked,
    debug: $('debug').checked,
    allowChannels: parseList($('allowChannels').value),
    blockChannels: parseList($('blockChannels').value),
    blockKeywords: parseList($('blockKeywords').value),
    blockChannelPatterns: parseList($('blockChannelPatterns').value),
    studyWords: parseList($('studyWords').value),
    focus,
    threshold: Math.min(0.95, Math.max(0.05, Number($('threshold').value))),
    inputPricePerMillion: Number.isFinite(price) && price >= 0 ? price : YTFF.DEFAULTS.inputPricePerMillion,
  };

  // Cached probabilities depend on the focus text, so drop them if it changed.
  if (focus !== previous.focus) await clearCache();

  const newKey = $('apiKey').value.trim();
  if (newKey) await chrome.storage.local.set({ apiKey: newKey });
  $('apiKey').value = '';

  await chrome.storage.local.set({ settings, cacheEpoch: Date.now() });
  await load();
  setStatus('Saved. Open YouTube tabs update automatically.');
});

const fmtInt = (n) => n.toLocaleString();

function fmtCost(cost) {
  if (cost === 0) return '$0.00';
  if (cost < 0.0001) return '<$0.0001';
  return cost < 1 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
}

async function renderUsage() {
  const [{ stats }, settings] = await Promise.all([chrome.storage.local.get('stats'), YTFF.getSettings()]);
  const summary = YTFF.summarize(stats || YTFF.emptyStats());
  const rows = [
    ['Today', summary.today],
    ['This week', summary.week],
    ['This month', summary.month],
    ['Total', summary.total],
  ];
  const body = $('usageBody');
  body.replaceChildren(
    ...rows.map(([label, v]) => {
      const tr = document.createElement('tr');
      const cost = YTFF.estimateCost(v.tokens, settings.inputPricePerMillion);
      for (const text of [label, fmtInt(v.requests), fmtInt(v.videos), fmtInt(v.tokens), fmtCost(cost)]) {
        const td = document.createElement('td');
        td.textContent = text;
        tr.appendChild(td);
      }
      return tr;
    })
  );
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.stats || changes.settings)) renderUsage();
});

$('resetUsage').addEventListener('click', async () => {
  if (!confirm('Reset all usage statistics? This only clears the counters in this browser.')) return;
  await chrome.storage.local.remove('stats');
  setStatus('Usage statistics reset.');
});

$('restoreWords').addEventListener('click', () => {
  $('blockKeywords').value = YTFF.DEFAULTS.blockKeywords.join('\n');
  $('blockChannelPatterns').value = YTFF.DEFAULTS.blockChannelPatterns.join('\n');
  $('studyWords').value = YTFF.DEFAULTS.studyWords.join('\n');
  setStatus('Default lists loaded into the boxes. Press Save to apply them.');
});

$('clearCache').addEventListener('click', async () => {
  const removed = await clearCache();
  await chrome.storage.local.set({ cacheEpoch: Date.now() });
  setStatus(`Cleared ${removed} cached verdicts.`);
});

load();
renderUsage();
