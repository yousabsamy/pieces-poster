# Jewelry pieces auto-poster – مجوهرات السلام

The worker sends photos of a piece to the Telegram bot. The bot answers **right away**, puts the
piece in a queue, and posts **two pieces a day** to the Facebook page at **4 PM and 9 PM Cairo time**.

It runs on **Cloudflare Workers** (free). It's completely separate from the gold price poster.
The code is in `worker/src/core.js`. The settings are at the top of that file.

## How the worker uses it

- Before each piece the bot asks **"كام صورة للبوست الجاي؟"** with buttons 1–5. The worker taps the number,
  then sends that many photos. They go out together in one post. No text is needed.
- If photos arrive before a number is chosen, the bot asks once and keeps them.
- A few seconds later the bot answers with the day and time the piece goes out, and the caption.
- Commands: `/list`, `/preview` (the next post exactly as it will look), `/delete 5`, `/caption 5 new text`,
  `/cancel` (drop the photos still being collected), `/reset` (empty the whole queue, with a confirm button).

## Captions

- Gemini looks at the photos, works out what the piece is (حلق، خاتم، دبلة، غويشة، انسيال، سلسلة…) and writes the
  whole caption, sign-off line included, in the page's style.
- It learns the style from about 25 real captions from the page (`STYLE_EXAMPLES` in `core.js`). Add good ones there.
- It's told not to repeat the last few captions, and never to write a price, weight or karat.
- If Gemini doesn't work, a ready-made caption in the same style is used. A post is never skipped because of the caption.

## Alerts

From 1 PM to 11:30 PM, every 30 minutes, if there aren't enough pieces for the rest of today **and** all
of tomorrow, the bot sends "⚠️ تنبيه: مفيش بوستات جاهزة لبكرة". After each post it sends "✅ اتنشرت".

## Test mode

Until the `FB_PAGE_TOKEN` secret is added in Cloudflare, **nothing goes to Facebook**. At 4 PM and 9 PM
the bot sends the post to you on Telegram instead, marked 🧪.

## Safety

- Only the Telegram numbers in the `ALLOWED_USERS` secret can use the bot. Anyone else is told their number
  and asked to send it to Yousab.
- Telegram's messages are checked with a secret (`WEBHOOK_SECRET`), so nobody else can pretend to be Telegram.
- All keys are Cloudflare secrets, never in the code. Gemini's text is cleaned of links, phones and hashtags.

## Cloudflare secrets

`TELEGRAM_BOT_TOKEN`, `GEMINI_API_KEY`, `ALLOWED_USERS` (like `123, 456`), `WEBHOOK_SECRET`, `FB_PAGE_ID`,
and later `FB_PAGE_TOKEN` (adding it turns off test mode).

## Changing things

- `/status` on the Worker shows whether Telegram can reach it.
- Test: `cd worker && npm test` (fake Telegram/Facebook, nothing is sent).
- Publish a change: `cd worker && npx wrangler deploy`.
- After the first deploy, open `https://pieces-poster.pieces-poster.workers.dev/setup` once to connect Telegram.
- To stop everything: Cloudflare dashboard → Workers → pieces-poster → Settings → Delete (or remove the bot token secret).
