# YouTube Focus Filter

Chrome (Manifest V3) extension that hides YouTube videos that are not software engineering, tech, or educational. It works on the home feed, search results, and the watch-page sidebar. Each video title and channel name is classified once with the OpenAI Decisions API, and the result is cached.

## Install (unpacked)
1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select this folder.
3. Click the extension's toolbar icon (or **Details > Extension options**), paste your OpenAI API key, and save.
4. Open or reload YouTube.

## How it works
- `content.js` finds video tiles and reads each video's ID, title, and channel name.
- Cached verdicts (`chrome.storage.local`, keys `v:<videoId>`) are applied immediately. Unseen videos are sent to `background.js`.
- `background.js` collects unseen videos for about 150 ms and sends them to `POST https://api.openai.com/v1/decisions` in batches of up to 8 (at most 4 requests at once). Each batch is one request with the videos as JSON input and one `predicate` question per video. The returned probability is stored per video. A video is shown if the probability is at least the threshold set in options.
- If a video's answer is missing or refused, it is retried on its own. If the API rejects the batched format (HTTP 400), the extension falls back to one request per video.
- Tiles are hidden until a verdict is available. If there is no key or the API fails, videos are shown (fail open) and a warning is written to the service worker console.

## Short home feed
The YouTube home feed ends after roughly 260 videos (measured on one account, with the extension on and off). Most are hidden by the filter, so the page can look short. Refresh for a new set, widen the topics text, or lower the threshold to see more.

## Channel allow and block lists
In the options page, list channel names to always show or always hide, one per line. Names match exactly, ignoring case and extra spaces. If a channel is in both lists, hiding wins. Videos from listed channels are decided locally and are not sent to OpenAI. Turn on the verdict logging option to see the exact channel names in the YouTube page console.

## Local keyword rules (no AI call)
Before a video goes to OpenAI, `content.js` checks it against local rules. A video decided here costs nothing and appears or disappears immediately. The order is:
1. Channel is in "Always hide": hide. 2. Channel is in "Always show": show.
3. The title contains a study word (tutorial, course, programming, react, and so on): skip the next two rules and let the AI decide.
4. The title contains a blocked word or phrase: hide. 5. The channel name contains a blocked pattern: hide.
6. Otherwise the AI decides.

Title words match whole words in any language, ignoring case ("song" hides "Best song ever" but not "songwriting"). Channel patterns match anywhere in the channel name ("vevo" hides "TaylorSwiftVEVO"). The default lists cover music, podcasts, movies and shows, comedy, and common entertainment topics such as gaming, vlogs, and sports. Edit all three lists in the options page. With verdict logging on, the page console shows which rule fired. A title with a study word is never hidden by these lists, so "Funny coding bugs" still goes to the AI. In a test on 42 sample titles, the defaults decided 12 without the AI and hid none that I had labeled as wanted.

## Experiment scripts
- `scripts/compare-batch.mjs`: Decisions API, one request per video against one batched request.
- `scripts/compare-responses.mjs`: Decisions single, Decisions batched, and the Responses API (all titles in one call with structured output). It measures cost, latency, and accuracy against labeled titles. Titles come from a TSV file of `show`, `hide`, or `skip` labels (see `scripts/sample-titles.tsv`). Set `REPEATS` and `EFFORTS` to change the repeat count and the reasoning efforts tested.

Both read the key from the `OPENAI_API_KEY` environment variable and are not part of the extension.

## Usage statistics and cost
The options page shows requests, videos sent, input tokens, and an estimated cost for today, this week (Monday to Sunday), this month, and all time. Token counts come from the `usage.input_tokens` value in each OpenAI response and are stored per day in `chrome.storage.local`, in this browser only. Daily buckets older than 400 days are dropped, and the running total is kept.

The cost is estimated as input tokens × the price per 1M tokens set in the options page (default $0.10, the gpt-6-luna uncached input price in OpenAI's Decisions guide when this was written). Output tokens are not charged for Decisions. The estimate ignores any cache discount, regional processing premium, or long-context multiplier, so treat the OpenAI dashboard as the source of truth. Runs of `scripts/compare-batch.mjs` are not counted.

## Privacy and security
- Only the video title and channel name are sent to OpenAI. No account, history, or cookie data is sent.
- The API key lives in `chrome.storage.local` on this browser only. Anyone with access to the browser profile can read it, so use a restricted key with a low monthly spend limit. This setup is for personal use. Do not share the extension with the key inside it.

## Files
`manifest.json`, `shared.js` (constants), `content.js` and `content.css` (page side), `background.js` (API calls), `options.html` and `options.js` (settings).

## Not in v1
YouTube Data API tags and category, and hiding Shorts.

## Batching and scores
Batched scores for borderline videos can differ from single-video scores (in testing, 41 of 42 show/hide decisions matched at batch size 8). Clear tech and clear non-tech videos scored the same. `scripts/compare-batch.mjs` repeats that comparison with your own titles. It reads the key from the `OPENAI_API_KEY` environment variable.
