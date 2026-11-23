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
  // The description snippet YouTube renders inside a tile (mainly search results). Home and sidebar tiles
  // usually have none, so for those the local rules fall back to the title alone.
  const DESCRIPTION_SELECTORS = [
    '.metadata-snippet-text',
    'yt-formatted-string.metadata-snippet-text',
    '#description-text',
    '.yt-lockup-metadata-view-model__description',
    '.yt-lockup-metadata-view-model__snippet',
  ];
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
  let categorySet = new Set(); // lower-cased YouTube category names to hide

  function applySettings(s) {
    settings = s;
    allowSet = new Set((s.allowChannels || []).map(norm).filter(Boolean));
    blockSet = new Set((s.blockChannels || []).map(norm).filter(Boolean));
    keywords = (s.blockKeywords || []).map(norm).filter(Boolean);
    channelPatterns = (s.blockChannelPatterns || []).map(norm).filter(Boolean);
    studyWords = (s.studyWords || []).map(norm).filter(Boolean);
    categorySet = new Set((s.blockCategories || []).map(norm).filter(Boolean));
  }

  // Decides a video locally, without the AI. Returns { rule: 'show' | 'hide', why } or null.
  // Order: exact channel block, exact channel allow, then keyword and channel-pattern blocking.
  function localRule(info) {
    if (hiddenSet.has(info.id)) return { rule: 'hide', why: 'hidden by you' }; // an explicit choice beats every other rule
    const channel = norm(info.channel);
    if (channel) {
      if (blockSet.has(channel)) return { rule: 'hide', why: 'blocked channel' };
      if (allowSet.has(channel)) return { rule: 'show', why: 'allowed channel' };
    }
    // Title, plus description and tags (when enabled and available), are matched together.
    const title = norm(info.title);
    const extra = settings.useDescription ? [info.description, info.tags].map(norm).filter(Boolean) : [];
    const text = [title, ...extra].join('\n');
    if (YTFF.findPhrase(text, studyWords)) return null; // looks like study material, let the AI decide
    const word = YTFF.findPhrase(text, keywords);
    if (word) {
      const where = YTFF.containsPhrase(title, word) ? 'title' : YTFF.containsPhrase(norm(info.tags), word) ? 'tag' : 'description';
      return { rule: 'hide', why: `${where} keyword "${word}"` };
    }
    const category = settings.useDescription && YTFF.CATEGORIES[info.category];
    if (category && categorySet.has(norm(category))) return { rule: 'hide', why: `category "${category}"` };
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
    const meta = descCache.get(id) || {};
    const description = firstText(tile, DESCRIPTION_SELECTORS) || meta.d || '';
    return { id, title, channel: firstText(tile, CHANNEL_SELECTORS), description, tags: meta.g || '', category: meta.c || '' };
  }

  // --- Description lookup ----------------------------------------------------------------------
  // Home and sidebar tiles carry no description. For videos the title rules did not decide, the service worker
  // reads descriptions from the official YouTube Data API (batched, up to 50 per request) and caches them in
  // storage under "d:<videoId>". Without a YouTube API key, or on any error, the title alone is used.
  const descCache = new Map(); // videoId -> { d: description, g: tags (one per line), c: categoryId }

  async function loadDescriptions(items) {
    const ids = items.filter((it) => !descCache.has(it.id)).map((it) => it.id);
    if (ids.length) {
      try {
        const res = await chrome.runtime.sendMessage({ type: 'descriptions', ids });
        if (res && res.ok) {
          for (const [id, text] of Object.entries(res.map)) descCache.set(id, text);
        } else if (res && res.error) {
          warnOnce(`could not read video descriptions, matching titles only: ${res.error}`);
        }
      } catch (err) {
        if (isInvalidated(err)) return shutdown();
      }
    }
    for (const it of items) {
      const meta = descCache.get(it.id) || {};
      it.description = it.description || meta.d || '';
      it.tags = meta.g || '';
      it.category = meta.c || '';
    }
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
    document.querySelectorAll('.ytff-ui').forEach((n) => n.remove());
    document.removeEventListener('mouseover', onHover);
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

    // Look up descriptions for the local text rules before spending an AI call.
    if (settings.useDescription) {
      await loadDescriptions(items);
      if (myEpoch !== epoch || dead) return;
      items = items.filter((it) => {
        if (settings.debug) {
          console.log(`[YouTube Focus Filter] description ${it.description ? `read (${it.description.length} chars)` : 'not available'} | ${it.title}`);
        }
        const local = localRule(it);
        if (!local) return true;
        ruled.set(it.id, local.rule);
        inflight.delete(it.id);
        if (settings.debug) {
          console.log(`[YouTube Focus Filter] local rule: ${local.rule} (${local.why}) | ${it.channel} | ${it.title}`);
        }
        return false;
      });
      scheduleRender();
      if (!items.length) return;
    }

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
    if (area === 'local' && changes[YTFF.HIDDEN_KEY]) loadHidden().then(scheduleScan); // e.g. hidden in another tab
    if (area === 'local' && (changes.settings || changes.cacheEpoch)) reloadSettingsAndReset();
  });

  // --- Manual hide -------------------------------------------------------------------------------
  // A "Hide…" button appears over a shown video on hover. The panel it opens always hides that video, and can
  // also add the channel to "Always hide" and one or more keywords to the hide words. Everything is saved in
  // storage (videos under "hiddenVideos", the rest in the normal settings) and an Undo toast reverses it.
  let hiddenSet = new Set(); // ids of videos the user hid by hand

  async function loadHidden() {
    try {
      const map = (await chrome.storage.local.get(YTFF.HIDDEN_KEY))[YTFF.HIDDEN_KEY] || {};
      hiddenSet = new Set(Object.keys(map));
    } catch (err) {
      if (isInvalidated(err)) shutdown();
    }
  }

  const el = (tag, props = {}, ...kids) => {
    const node = document.createElement(tag);
    Object.assign(node, props);
    node.append(...kids);
    return node;
  };

  const PREVIEW_SELECTOR = 'ytd-video-preview, #video-preview, ytd-inline-preview-player';
  let hideBtn = null;
  let hideBtnTile = null;
  let panel = null;
  let toast = null;
  let toastTimer = null;

  function outerTile(node) {
    let tile = node.closest(TILE_SELECTOR);
    while (tile && tile.parentElement && tile.parentElement.closest(TILE_SELECTOR)) tile = tile.parentElement.closest(TILE_SELECTOR);
    return tile;
  }

  function hideButton() {
    if (hideBtn) hideBtn.style.display = 'none';
    hideBtnTile = null;
  }

  function onHover(e) {
    if (dead || panel || !settings.enabled || !inScope()) return;
    const target = e.target;
    if (!(target instanceof Element) || target.closest('.ytff-ui')) return;
    const tile = outerTile(target);
    if (!tile) {
      // YouTube's hover preview player lives outside the tile. Keep the button while the pointer is over the
      // preview, or still inside the area of the tile the button belongs to.
      const r = hideBtnTile && hideBtnTile.isConnected ? hideBtnTile.getBoundingClientRect() : null;
      const inside = r && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (inside || target.closest(PREVIEW_SELECTOR)) return;
      return hideButton();
    }
    if (tile.getAttribute(ATTR) !== 'show' || !tile.getAttribute(ATTR_ID)) return hideButton();
    const rect = tile.getBoundingClientRect();
    if (rect.width < 80 || rect.height < 40) return hideButton();
    if (!hideBtn) {
      hideBtn = el('button', { type: 'button', className: 'ytff-ui ytff-hide-btn', textContent: 'Hide…', title: 'Hide this video, its channel, or a keyword' });
      hideBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (hideBtnTile) openPanel(hideBtnTile);
      });
      document.body.appendChild(hideBtn);
    }
    hideBtnTile = tile;
    hideBtn.style.display = 'block';
    hideBtn.style.top = `${Math.max(rect.top, 0) + 6}px`;
    // Top-left: YouTube's hover preview puts mute/captions/menu buttons in the top-right corner.
    hideBtn.style.left = `${Math.max(rect.left, 0) + 6}px`;
  }

  const parseKeywords = (text) => [
    ...new Map(
      text
        .split(/[,\n]/)
        .map(clean)
        .filter((k) => k && k.length <= 60)
        .map((k) => [k.toLowerCase(), k])
    ).values(),
  ];

  function closePanel() {
    if (panel) panel.remove();
    panel = null;
  }

  function openPanel(tile) {
    const info = extract(tile);
    if (!info) return;
    closePanel();
    const anchor = hideBtn.getBoundingClientRect();

    const chosen = new Map(); // lower-case tag -> tag as shown, for the tags toggled on
    let allTags = [];
    const chanBox = el('input', { type: 'checkbox' });
    const keywordInput = el('input', { type: 'text', placeholder: 'e.g. property, प्रॉपर्टी', maxLength: 200 });
    const tagCount = el('span', { className: 'ytff-count' });
    const tagList = el('div', { className: 'ytff-chips' });
    const updateCount = () => (tagCount.textContent = allTags.length ? `${chosen.size} of ${allTags.length} selected` : '');

    const setAll = (on) => {
      chosen.clear();
      if (on) allTags.forEach((t) => chosen.set(t.toLowerCase(), t));
      tagList.querySelectorAll('.ytff-chip').forEach((c) => c.classList.toggle('on', on));
      updateCount();
    };
    const renderTags = (tags) => {
      allTags = tags;
      tagList.replaceChildren();
      if (!tags.length) {
        tagList.append(el('div', { className: 'ytff-note', textContent: 'No tags available for this video. Tags need the YouTube API key in the extension options.' }));
      }
      for (const tag of tags) {
        const chip = el('button', { type: 'button', className: 'ytff-chip', textContent: tag, title: tag });
        chip.addEventListener('click', () => {
          const key = tag.toLowerCase();
          if (chosen.has(key)) chosen.delete(key);
          else chosen.set(key, tag);
          chip.classList.toggle('on', chosen.has(key));
          updateCount();
        });
        tagList.append(chip);
      }
      updateCount();
      reposition();
    };
    const tagsOf = (meta) => (meta && meta.g ? meta.g.split('\n').map(clean).filter((t) => t && t.length <= 60) : []);

    const submit = () => {
      const keywords = [...new Map([...chosen.values(), ...parseKeywords(keywordInput.value)].map((k) => [k.toLowerCase(), k])).values()];
      closePanel();
      applyManualHide(info, { channel: chanBox.checked, keywords });
    };

    const tagBody = el('div', { className: 'ytff-section-body' },
      el('div', { className: 'ytff-links' },
        el('button', { type: 'button', className: 'ytff-link', textContent: 'Select all', onclick: () => setAll(true) }),
        el('button', { type: 'button', className: 'ytff-link', textContent: 'Clear', onclick: () => setAll(false) }),
        tagCount),
      tagList);
    const tagToggle = el('button', { type: 'button', className: 'ytff-disclosure', textContent: 'Tags to block ▾' });
    tagToggle.addEventListener('click', () => {
      const open = tagBody.style.display !== 'none';
      tagBody.style.display = open ? 'none' : 'block';
      tagToggle.textContent = open ? 'Tags to block ▸' : 'Tags to block ▾';
      reposition();
    });

    const body = [
      el('div', { className: 'ytff-head' },
        el('div', {},
          el('div', { className: 'ytff-title', textContent: info.title }),
          info.channel ? el('div', { className: 'ytff-sub', textContent: info.channel }) : ''),
        el('button', { type: 'button', className: 'ytff-x', textContent: '✕', title: 'Close', onclick: closePanel })),
      el('div', { className: 'ytff-note', textContent: 'This video will be hidden. Choose what else to block so similar videos stay away.' }),
      el('div', { className: 'ytff-section' }, tagToggle, tagBody),
    ];
    if (info.channel) {
      body.push(el('label', { className: 'ytff-check' }, chanBox, el('span', { textContent: `Also hide every video from "${info.channel}"` })));
    }
    body.push(
      el('div', { className: 'ytff-section' },
        el('label', { className: 'ytff-label', textContent: 'Other words that are not relevant to me' }),
        keywordInput,
        el('div', { className: 'ytff-note', textContent: 'Separate with commas.' })),
      el('div', { className: 'ytff-actions' },
        el('button', { type: 'button', textContent: 'Cancel', onclick: closePanel }),
        el('button', { type: 'button', className: 'ytff-primary', textContent: 'Hide', onclick: submit }))
    );

    const thisPanel = el('div', { className: 'ytff-ui ytff-panel', role: 'dialog' }, ...body);
    panel = thisPanel;
    function reposition() {
      if (panel !== thisPanel) return;
      const h = thisPanel.offsetHeight;
      const top = Math.max(8, Math.min(anchor.bottom + 6, window.innerHeight - h - 8));
      thisPanel.style.top = `${top}px`;
      thisPanel.style.left = `${Math.max(8, Math.min(anchor.right - thisPanel.offsetWidth, window.innerWidth - thisPanel.offsetWidth - 8))}px`;
    }
    // Keep YouTube's keyboard shortcuts from firing while typing here.
    for (const type of ['keydown', 'keyup', 'keypress']) thisPanel.addEventListener(type, (ev) => ev.stopPropagation());
    thisPanel.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') closePanel();
      else if (ev.key === 'Enter' && ev.target === keywordInput) submit();
    });
    document.body.appendChild(thisPanel);
    hideButton();

    // Tags come from the YouTube API cache; look them up now if this video has not been looked up yet.
    if (descCache.has(info.id)) renderTags(tagsOf(descCache.get(info.id)));
    else {
      tagList.append(el('div', { className: 'ytff-note', textContent: 'Loading tags…' }));
      loadDescriptions([{ ...info }]).then(() => {
        if (panel === thisPanel) renderTags(tagsOf(descCache.get(info.id)));
      });
    }
    reposition();
    keywordInput.focus();
  }

  function showToast(message, onUndo) {
    clearTimeout(toastTimer);
    if (toast) toast.remove();
    const undo = el('button', { type: 'button', textContent: 'Undo' });
    toast = el('div', { className: 'ytff-ui ytff-toast' }, el('span', { textContent: message }), undo);
    const dismiss = () => {
      clearTimeout(toastTimer);
      if (toast) toast.remove();
      toast = null;
    };
    undo.addEventListener('click', () => {
      dismiss();
      onUndo();
    });
    document.body.appendChild(toast);
    toastTimer = setTimeout(dismiss, 10000);
  }

  async function applyManualHide(info, { channel, keywords }) {
    const added = { channel: null, keywords: [] };
    try {
      const current = await YTFF.getSettings();
      const next = { ...current };
      if (channel && info.channel && !current.blockChannels.some((c) => norm(c) === norm(info.channel))) {
        next.blockChannels = [...current.blockChannels, info.channel];
        added.channel = info.channel;
      }
      const kws = [...current.blockKeywords];
      for (const k of keywords) {
        if (!kws.some((x) => norm(x) === norm(k))) {
          kws.push(k);
          added.keywords.push(k);
        }
      }
      next.blockKeywords = kws;

      const hidden = (await chrome.storage.local.get(YTFF.HIDDEN_KEY))[YTFF.HIDDEN_KEY] || {};
      hidden[info.id] = Date.now();
      const ids = Object.keys(hidden);
      if (ids.length > YTFF.MAX_HIDDEN) {
        ids.sort((a, b) => hidden[a] - hidden[b]).slice(0, ids.length - YTFF.MAX_HIDDEN).forEach((id) => delete hidden[id]);
      }
      const write = { [YTFF.HIDDEN_KEY]: hidden };
      if (added.channel || added.keywords.length) write.settings = next;

      hiddenSet.add(info.id);
      ruled.set(info.id, 'hide');
      scheduleRender();
      await chrome.storage.local.set(write);
    } catch (err) {
      if (isInvalidated(err)) return shutdown();
      warnOnce(`could not save the hide: ${err}`);
      return;
    }
    const parts = ['Video hidden'];
    if (added.channel) parts.push(`channel "${added.channel}"`);
    if (added.keywords.length) parts.push(`keyword${added.keywords.length > 1 ? 's' : ''} ${added.keywords.map((k) => `"${k}"`).join(', ')}`);
    showToast(parts.join(' + '), () => undoManualHide(info.id, added));
  }

  async function undoManualHide(id, added) {
    try {
      const current = await YTFF.getSettings();
      const next = {
        ...current,
        blockChannels: added.channel ? current.blockChannels.filter((c) => norm(c) !== norm(added.channel)) : current.blockChannels,
        blockKeywords: current.blockKeywords.filter((k) => !added.keywords.some((a) => norm(a) === norm(k))),
      };
      const hidden = (await chrome.storage.local.get(YTFF.HIDDEN_KEY))[YTFF.HIDDEN_KEY] || {};
      delete hidden[id];
      hiddenSet.delete(id);
      const write = { [YTFF.HIDDEN_KEY]: hidden };
      if (added.channel || added.keywords.length) write.settings = next;
      await chrome.storage.local.set(write);
    } catch (err) {
      if (isInvalidated(err)) return shutdown();
      warnOnce(`could not undo the hide: ${err}`);
      return;
    }
    resetAll();
  }

  document.addEventListener('mouseover', onHover, { passive: true });
  document.addEventListener(
    'mousedown',
    (e) => {
      if (panel && e.target instanceof Element && !e.target.closest('.ytff-ui')) closePanel();
    },
    true
  );
  window.addEventListener(
    'scroll',
    (e) => {
      // Scrolling inside the panel (the tag list) must not close it. The panel stays open when the page scrolls;
      // close it with Esc, the close button, Cancel, or a click outside.
      if (e.target instanceof Element && e.target.closest('.ytff-ui')) return;
      hideButton();
    },
    { passive: true, capture: true }
  );

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('yt-navigate-finish', scheduleScan);

  Promise.all([YTFF.getSettings(), loadHidden()]).then(([s]) => {
    applySettings(s);
    scheduleScan();
  });
})();
