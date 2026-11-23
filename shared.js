// Constants and helpers shared by the content script, service worker, and options page.
globalThis.YTFF = {
  API_URL: 'https://api.openai.com/v1/decisions',
  MODEL: 'gpt-6-luna',
  QUESTION_NAME: 'relevant',
  CACHE_PREFIX: 'v:', // per-video cache entries are stored as "v:<videoId>" -> { p, t }
  STATS_KEEP_DAYS: 400, // daily usage buckets older than this are dropped (the running total is kept)

  DEFAULTS: {
    enabled: true,
    debug: true, // log each verdict (probability, title) to the page console, for tuning
    threshold: 0.6,
    allowChannels: [], // channel names whose videos are always shown
    blockChannels: [], // channel names whose videos are always hidden (wins over allow)
    // Local rules that hide a video without calling the AI. Phrases match whole words in the title (any language),
    // ignoring case. Channel patterns match anywhere inside the channel name. A video whose title contains a study
    // word is never hidden by these rules (the AI decides instead), and "Always show" channels override them.
    blockKeywords: [
      // music
      'official video', 'official music video', 'official audio', 'lyric video', 'lyrical', 'lyrics', 'music video',
      'full song', 'video song', 'song', 'songs', 'music', 'remix', 'jukebox', 'mashup', 'album', 'karaoke', 'concert',
      'bgm', 'dj', 'mix –', 'mix -', 'my mix', 'गाना', 'गाने', 'गीत', 'गाणे', 'गाणी',
      // podcasts
      'podcast', 'podcasts',
      // movies and shows
      'movie', 'movies', 'full movie', 'film', 'short film', 'trailer', 'teaser', 'web series', 'webseries', 'tv serial',
      'tv show', 'full episode', 'bollywood', 'hollywood', 'netflix', 'box office', 'bigg boss', 'फिल्म', 'मूवी', 'चित्रपट',
      // comedy
      'comedy', 'comedian', 'standup', 'stand-up', 'stand up', 'funny', 'prank', 'pranks', 'roast', 'meme', 'memes',
      'jokes', 'sketch', 'कॉमेडी',
      // other things that pull attention away from studying
      'gameplay', "let's play", 'minecraft', 'gta', 'pubg', 'bgmi', 'free fire', 'vlog', 'vlogs', 'reaction', 'asmr',
      'recipe', 'cricket', 'ipl', 'football', 'highlights', 'wwe', 'celebrity', 'gossip', 'viral', 'challenge', 'horror',
      'scary', 'satisfying', 'tiktok', 'horoscope', 'रेसिपी',
    ],
    blockChannelPatterns: [
      'vevo', '- topic', 'records', 'music', 't-series', 'saregama', 'tips official', 'comedy', 'standup', 'podcast',
    ],
    studyWords: [
      'tutorial', 'course', 'lecture', 'learn', 'programming', 'coding', 'software', 'developer', 'algorithm',
      'algorithms', 'data structures', 'system design', 'computer science', 'machine learning', 'leetcode', 'javascript',
      'python', 'java', 'react', 'sql', 'docker', 'kubernetes', 'linux', 'api', 'ai', 'llm', 'devops', 'engineer',
      'engineering', 'aws', 'cloud', 'database', 'backend', 'frontend', 'cybersecurity', 'tech', 'technology', 'computer',
      'git', 'github', 'typescript', 'rust', 'golang', 'c++', 'math', 'mathematics', 'physics', 'science',
    ],
    // USD per 1M input tokens, used for the cost estimate. Update it if OpenAI changes its pricing.
    inputPricePerMillion: 0.1,
    focus:
      'software engineering, programming, computer science, developer tools, ' +
      'technology news and analysis, and educational or tutorial content',
  },

  async getSettings() {
    const { settings } = await chrome.storage.local.get('settings');
    return { ...YTFF.DEFAULTS, ...(settings || {}) };
  },

  // --- Local text rules ---------------------------------------------------------------------

  // True if `phrase` appears in `text` as a whole word or phrase. Works for any script (JavaScript's \b only
  // understands ASCII), so "song" matches "Best song ever" but not "songwriting".
  // Both arguments must already be lower-cased.
  containsPhrase(text, phrase) {
    if (!phrase) return false;
    const isWord = (ch) => !!ch && /[\p{L}\p{N}\p{M}_]/u.test(ch);
    const needStart = isWord(phrase[0]);
    const needEnd = isWord(phrase[phrase.length - 1]);
    let from = 0;
    for (;;) {
      const i = text.indexOf(phrase, from);
      if (i === -1) return false;
      const startOk = !needStart || !isWord(text[i - 1]);
      const endOk = !needEnd || !isWord(text[i + phrase.length]);
      if (startOk && endOk) return true;
      from = i + 1;
    }
  },

  // Returns the first matching phrase, or null. `phrases` must already be lower-cased.
  findPhrase(text, phrases) {
    for (const p of phrases) if (YTFF.containsPhrase(text, p)) return p;
    return null;
  },

  // --- Usage statistics ---------------------------------------------------------------------
  // Stored under "stats" as { total: {tokens, requests, videos}, days: { "YYYY-MM-DD": {...} } }.
  // Days use the browser's local time zone. Only input tokens are tracked, because the Decisions API
  // does not charge for output tokens.

  dayKey(date = new Date()) {
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${mm}-${dd}`;
  },

  emptyStats() {
    return { total: { tokens: 0, requests: 0, videos: 0 }, days: {} };
  },

  // Adds one API request to the stats (mutates and returns them).
  addUsage(stats, tokens, videos, date = new Date()) {
    const add = (bucket) => {
      bucket.tokens += tokens;
      bucket.requests += 1;
      bucket.videos += videos;
    };
    const key = YTFF.dayKey(date);
    add(stats.total);
    add((stats.days[key] = stats.days[key] || { tokens: 0, requests: 0, videos: 0 }));

    const cutoff = YTFF.dayKey(new Date(date.getFullYear(), date.getMonth(), date.getDate() - YTFF.STATS_KEEP_DAYS));
    for (const k of Object.keys(stats.days)) if (k < cutoff) delete stats.days[k];
    return stats;
  },

  // Totals for today, this calendar week (Monday to Sunday), this calendar month, and all time.
  summarize(stats, now = new Date()) {
    const zero = () => ({ tokens: 0, requests: 0, videos: 0 });
    const out = { today: zero(), week: zero(), month: zero(), total: { ...stats.total } };
    const todayKey = YTFF.dayKey(now);
    const daysSinceMonday = (now.getDay() + 6) % 7;
    const weekStartKey = YTFF.dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysSinceMonday));
    const monthPrefix = todayKey.slice(0, 7);
    const addTo = (target, day) => {
      target.tokens += day.tokens;
      target.requests += day.requests;
      target.videos += day.videos;
    };
    for (const [key, day] of Object.entries(stats.days)) {
      if (key === todayKey) addTo(out.today, day);
      if (key >= weekStartKey && key <= todayKey) addTo(out.week, day);
      if (key.startsWith(monthPrefix) && key <= todayKey) addTo(out.month, day);
    }
    return out;
  },

  estimateCost(tokens, pricePerMillion) {
    return (tokens / 1_000_000) * pricePerMillion;
  },
};
