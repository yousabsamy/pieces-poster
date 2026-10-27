# Jewelry pieces auto-poster – مجوهرات السلام

The worker sends photos of a piece to the Telegram bot. The bot answers **right away**, puts the
piece in a queue, and posts **two pieces a day** to the Facebook page at **4 PM and 9 PM Cairo time**.

It runs on **Cloudflare Workers** (free). It's completely separate from the gold price poster.
The code is in `worker/src/core.js`. The settings are at the top of that file.

## How the worker uses it

- Send the photo of the piece to the bot.
- If a piece has 2 photos (or more), select them **together** and send them at once. They go out in one post.
- You can write a note under the photo, for example `حلق عيار 21`. It goes into the caption.
- The bot answers within a few seconds with the day and time the piece goes out, and the caption.
- Commands: `/list`, `/delete 5`, `/merge` (last two pieces → one post), `/caption 5 new text`,
  `/preview` (see the next post exactly as it will look).

## Captions

- Gemini looks at the photo and writes 2 lines in the page's own style (like the earrings post).
- Every post ends with `💛 مجوهرات السلام… الدهب اللي يليق بذوقك.` (`FOOTER` in `core.js`).
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

- Test: `cd worker && npm test` (fake Telegram/Facebook, nothing is sent).
- Publish a change: `cd worker && npx wrangler deploy`.
- After the first deploy, open `https://pieces-poster.pieces-poster.workers.dev/setup` once to connect Telegram.
- To stop everything: Cloudflare dashboard → Workers → pieces-poster → Settings → Delete (or remove the bot token secret).
