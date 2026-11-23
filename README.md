# YouTube Focus Filter

A Chrome extension that hides YouTube videos that aren't about tech, software engineering, or learning. It works on the home feed, search results, and the watch-page sidebar.

Each video's title and channel are judged once by the OpenAI Decisions API, and the result is cached. Cheap local rules (keywords, channels, categories) run first, so many videos never reach the AI.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select this folder.
3. Click the extension icon, paste your **OpenAI API key**, and save.
4. Open or reload YouTube.

Optional: add a **YouTube Data API key** in the same page to match video descriptions, tags, and categories. Create one in Google Cloud, enable *YouTube Data API v3*, and restrict the key to that API.

## Use

- **Hide a video yourself:** hover over it and click **Hide…**. Pick tags or type words you don't want, optionally block the channel, and confirm. **Undo** is available for 10 seconds.
- **Tune it in the options page:** topics you want, a match threshold, channels to always show or hide, hide words, hide categories, and study words.

## How a video is decided

1. You hid it by hand: hidden.
2. Channel in *Always hide* or *Always show*: hidden or shown.
3. Title, description, or tags contain a study word (tutorial, react, python…): the AI decides.
4. Contains a hide word, or the category is blocked: hidden.
5. Otherwise the AI decides.

Words match whole words in any language, ignoring case. Turn on logging in options to see which rule fired.

## Privacy

- Titles and channel names go to OpenAI. Descriptions, tags, and categories are not sent to OpenAI.
- With a YouTube key, video IDs go to `googleapis.com`.
- Both keys are stored only in this browser (`chrome.storage.local`). Use restricted keys with low spend limits, and don't share the extension with keys inside it.
- No account, history, or cookie data is read or sent.

## Notes

- If a key is missing or an API fails, videos are shown unfiltered.
- The home feed is short when most videos are hidden. Refresh, widen your topics, or lower the threshold.
- Options show estimated OpenAI usage and cost. The OpenAI dashboard is the source of truth.
- `scripts/` holds optional experiments that compare API approaches. They read `OPENAI_API_KEY` from the environment and aren't part of the extension.

## Files

`content.js` / `content.css` (page), `background.js` (API calls), `shared.js` (settings and helpers), `options.html` / `options.js` (settings page).
