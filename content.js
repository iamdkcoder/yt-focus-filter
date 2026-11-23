// Content script: finds video tiles on YouTube home, search, and watch pages,
// asks the service worker to classify unseen videos, and hides the ones that don't match.
(() => {
  'use strict';

  // Tile containers. YouTube changes these often, so keep every selector here.
  const TILE_SELECTOR = [
    'ytd-rich-item-renderer', // home grid
    'ytd-video-renderer', // search results
    'ytd-compact-video-renderer', // watch-page sidebar (older layout)
    'yt-lockup-view-model', // newer layout, used on watch sidebar and elsewhere
  ].join(',');
  const TITLE_SELECTORS = ['#video-title', '.yt-lockup-metadata-view-model__heading-reset', '.yt-lockup-metadata-view-model__title', 'h3'];
  const CHANNEL_SELECTORS = [
    'ytd-channel-name a',
    '#channel-name a',
    '.yt-content-metadata-view-model__metadata-text',
    '.ytd-channel-name',
    // Class names change often; channel links are more stable.
    'a[href^="/@"]',
    'a[href^="/channel/"]',
    'a[href^="/c/"]',
    'a[href^="/user/"]',
  ];

  const ATTR = 'data-ytff'; // "pending" | "show" | "hide"
  const ATTR_ID = 'data-ytff-id';

  let settings = { ...YTFF.DEFAULTS };
  let epoch = 0; // bumped on reset so late responses from an older configuration are ignored
  const probs = new Map(); // videoId -> probability that the video matches the focus topics
  const failed = new Set(); // videoIds that could not be classified; shown (fail open)
  const inflight = new Set();
  let scanTimer = null;
  let renderQueued = false;

  const inScope = () => ['/', '/results', '/watch'].includes(location.pathname);

  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const norm = (s) => clean(s).toLowerCase();

  // Channel rules: names are matched exactly, ignoring case and extra spaces.
  const ruled = new Map(); // videoId -> 'show' | 'hide' decided by a channel rule
  let allowSet = new Set();
  let blockSet = new Set();

  let keywords = [];
  let channelPatterns = [];
  let studyWords = [];

  function applySettings(s) {
    settings = s;
    allowSet = new Set((s.allowChannels || []).map(norm).filter(Boolean));
    blockSet = new Set((s.blockChannels || []).map(norm).filter(Boolean));
    keywords = (s.blockKeywords || []).map(norm).filter(Boolean);
    channelPatterns = (s.blockChannelPatterns || []).map(norm).filter(Boolean);
    studyWords = (s.studyWords || []).map(norm).filter(Boolean);
  }

  // Decides a video locally, without the AI. Returns { rule: 'show' | 'hide', why } or null.
  // Order: exact channel block, exact channel allow, then keyword and channel-pattern blocking.
  function localRule(info) {
    const channel = norm(info.channel);
    if (channel) {
      if (blockSet.has(channel)) return { rule: 'hide', why: 'blocked channel' };
      if (allowSet.has(channel)) return { rule: 'show', why: 'allowed channel' };
    }
    const title = norm(info.title);
    if (YTFF.findPhrase(title, studyWords)) return null; // looks like study material, let the AI decide
    const word = YTFF.findPhrase(title, keywords);
    if (word) return { rule: 'hide', why: `title keyword "${word}"` };
    const pattern = channel && channelPatterns.find((p) => channel.includes(p));
    if (pattern) return { rule: 'hide', why: `channel pattern "${pattern}"` };
    return null;
  }

  function firstText(root, selectors) {
    for (const sel of selectors) {
      const el = root.querySelector(sel);
      if (!el) continue;
      const text = clean(el.getAttribute('title') || el.textContent);
      if (text) return text;
    }
    return '';
  }

  function extract(tile) {
    const link = tile.querySelector('a[href*="/watch?v="]');
    if (!link) return null;
    let id;
    try {
      id = new URL(link.href, location.origin).searchParams.get('v');
    } catch {
      return null;
    }
    if (!id) return null;
    const title = firstText(tile, TITLE_SELECTORS) || clean(link.getAttribute('title') || link.getAttribute('aria-label'));
    if (!title) return null; // title not rendered yet; a later scan will pick it up
    return { id, title, channel: firstText(tile, CHANNEL_SELECTORS) };
  }

  function stateFor(id) {
    if (ruled.has(id)) return ruled.get(id);
    if (failed.has(id)) return 'show';
    if (probs.has(id)) return probs.get(id) >= settings.threshold ? 'show' : 'hide';
    return 'pending';
  }

  function applyTile(tile, id) {
    const state = stateFor(id);
    if (tile.getAttribute(ATTR) !== state) tile.setAttribute(ATTR, state);
  }

  function renderAll() {
    renderQueued = false;
    for (const tile of document.querySelectorAll(`[${ATTR_ID}]`)) {
      applyTile(tile, tile.getAttribute(ATTR_ID));
    }
  }

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(renderAll);
  }

  function stripAll() {
    for (const tile of document.querySelectorAll(`[${ATTR}], [${ATTR_ID}]`)) {
      tile.removeAttribute(ATTR);
      tile.removeAttribute(ATTR_ID);
    }
  }

  // After the extension is reloaded or updated, tabs that were already open keep running this old script,
  // and every chrome.* call throws "Extension context invalidated". Detect that and stop cleanly.
  let dead = false;
  const isInvalidated = (err) => /context invalidated/i.test(String(err));

  function shutdown() {
    if (dead) return;
    dead = true;
    observer.disconnect();
    document.removeEventListener('yt-navigate-finish', scheduleScan);
    clearTimeout(scanTimer);
    stripAll(); // show every tile again
    console.warn(
      '[YouTube Focus Filter] The extension was reloaded or updated. Refresh this tab to turn filtering back on. Videos are shown unfiltered until then.'
    );
  }

  function scan() {
    scanTimer = null;
    if (dead) return;
    if (!chrome.runtime || !chrome.runtime.id) return shutdown();
    if (!settings.enabled || !inScope()) {
      stripAll();
      return;
    }
    const need = new Map();
    for (const tile of document.querySelectorAll(TILE_SELECTOR)) {
      // A tile nested inside another tile (e.g. lockup inside a rich grid item) is handled by the outer one.
      if (tile.parentElement && tile.parentElement.closest(TILE_SELECTOR)) continue;
      // YouTube keeps previous pages (e.g. search results) in the DOM with a "hidden" attribute; skip them.
      if (tile.closest('[hidden]')) continue;
      const info = extract(tile);
      if (!info) continue;
      if (tile.getAttribute(ATTR_ID) !== info.id) tile.setAttribute(ATTR_ID, info.id); // YouTube recycles tiles
      const local = localRule(info);
      if (local && ruled.get(info.id) !== local.rule) {
        ruled.set(info.id, local.rule);
        if (settings.debug) {
          console.log(`[YouTube Focus Filter] local rule: ${local.rule} (${local.why}) | ${info.channel} | ${info.title}`);
        }
      }
      applyTile(tile, info.id);
      if (!ruled.has(info.id) && !probs.has(info.id) && !failed.has(info.id) && !inflight.has(info.id)) {
        need.set(info.id, info);
      }
    }
    if (need.size) resolve([...need.values()]);
  }

  function scheduleScan() {
    if (!dead && scanTimer === null) scanTimer = setTimeout(scan, 100);
  }

  async function resolve(items) {
    const myEpoch = epoch;
    items.forEach((it) => inflight.add(it.id));

    const keys = items.map((it) => YTFF.CACHE_PREFIX + it.id);
    let stored = {};
    try {
      stored = await chrome.storage.local.get(keys);
    } catch (err) {
      if (isInvalidated(err)) return shutdown();
      // Any other storage error: treat as a cache miss and classify.
    }
    if (myEpoch !== epoch || dead) return;

    const misses = [];
    for (const it of items) {
      const hit = stored[YTFF.CACHE_PREFIX + it.id];
      if (hit && typeof hit.p === 'number') {
        probs.set(it.id, hit.p);
        inflight.delete(it.id);
        logVerdict(it, hit.p, true);
      } else {
        misses.push(it);
      }
    }
    scheduleRender();
    await Promise.all(misses.map((it) => classify(it, myEpoch)));
  }

  async function classify(it, myEpoch) {
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'classify', id: it.id, title: it.title, channel: it.channel });
    } catch (err) {
      if (isInvalidated(err)) return shutdown();
      res = { ok: false, error: String(err) };
    }
    if (myEpoch !== epoch || dead) return;
    inflight.delete(it.id);
    if (res && res.ok && typeof res.p === 'number') {
      probs.set(it.id, res.p);
      logVerdict(it, res.p, false);
    } else {
      failed.add(it.id); // fail open: show the video, and don't cache the failure
      warnOnce(`could not classify videos, showing them unfiltered: ${(res && res.error) || 'no response'}`);
    }
    scheduleRender();
  }

  const warned = new Set();
  function warnOnce(message) {
    if (warned.has(message)) return;
    warned.add(message);
    console.warn('[YouTube Focus Filter]', message);
  }

  function logVerdict(it, p, cached) {
    if (!settings.debug) return;
    const verdict = p >= settings.threshold ? 'show' : 'hide';
    console.log(`[YouTube Focus Filter] ${p.toFixed(2)} ${verdict}${cached ? ' (cached)' : ''} | ${it.channel} | ${it.title}`);
  }

  function resetAll() {
    epoch++;
    ruled.clear();
    probs.clear();
    failed.clear();
    inflight.clear();
    stripAll();
    scheduleScan();
  }

  async function reloadSettingsAndReset() {
    applySettings(await YTFF.getSettings());
    resetAll();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.settings || changes.cacheEpoch)) reloadSettingsAndReset();
  });

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('yt-navigate-finish', scheduleScan);

  YTFF.getSettings().then((s) => {
    applySettings(s);
    scheduleScan();
  });
})();
