# Jewelry pieces auto-poster – مجوهرات السلام

The worker sends photos of a piece to the Telegram bot. The bot answers **right away**, puts the
piece in a queue, and posts **two pieces a day** to the Facebook page at **3 PM and 10 PM Cairo time**.

It runs on **Cloudflare Workers** (free). It's completely separate from the gold price poster.
The code is in `worker/src/core.js`. The settings are at the top of that file.

## How the worker uses it

- Before each piece the bot asks **"كام صورة للبوست الجاي؟"** with buttons 1–5. The worker taps the number,
  then sends that many photos. They go out together in one post. No text is needed, but if the worker writes
  something (under a photo or as a message, like `دبل خفيفة` or `عيار 21`), Gemini must work it into the caption.
- If photos arrive before a number is chosen, the bot asks once and keeps them.
- A few seconds later the bot answers with the day and time the piece goes out, and the caption.
- Commands: `/list`, `/preview` (the next post exactly as it will look), `/postnow` or `/postnow 5`
  (post the next post, or post 5, right away after a confirm button; the 3 PM / 10 PM posts still happen), `/delete 5`, `/caption 5 new text`,
  `/cancel` (drop the photos still being collected), `/reset` (empty the whole queue, with a confirm button).

## Captions

- Gemini looks at the photos, works out what the piece is (حلق، خاتم، دبلة، غويشة، انسيال، سلسلة…) and writes the
  whole caption, sign-off line included, in the page's style.
- It learns the style from about 25 real captions from the page (`STYLE_EXAMPLES` in `core.js`). Add good ones there.
- It's told not to repeat the last few captions, and never to write a price, weight or karat.
- If Gemini doesn't work, a ready-made caption in the same style is used. A post is never skipped because of the caption.

## Logo and contact info

- Every photo gets the shop logo in the bottom-right corner (`assets/logo.png`, size and place at the top of
  `core.js`). Cloudflare Images draws it, free up to 5,000 photos a month. If it ever fails, the photo goes out without it.
- Every caption ends with the address and both WhatsApp numbers (`CONTACT` in `core.js`).
- `/preview` and the 🧪 test posts show the photos with the logo, exactly as they'll be posted.

## Alerts

From 1 PM to 11:30 PM, every hour, if there aren't enough pieces for the rest of today **and** all
of tomorrow, the bot sends "⚠️ تنبيه: مفيش بوستات جاهزة لبكرة". After each post it sends "✅ اتنشرت".

## Test mode

Until the `FB_PAGE_TOKEN` secret is added in Cloudflare, **nothing goes to Facebook**. At 3 PM and 10 PM
the bot sends the post to you on Telegram instead, marked 🧪.

## Safety

- Only the Telegram numbers in the `ALLOWED_USERS` secret can use the bot. Anyone else is told their number
  and asked to send it to Yousab.
- Telegram's messages are checked with a secret (`WEBHOOK_SECRET`), so nobody else can pretend to be Telegram.
- All keys are Cloudflare secrets, never in the code. Gemini's text is cleaned of links, phones and hashtags.

## Cloudflare secrets

`TELEGRAM_BOT_TOKEN`, `GEMINI_API_KEY`, `ALLOWED_USERS` (like `123, 456`), `USER_NAMES` (like `123:هيما, 456:يوساب`, for "الله ينور يا هيما"), `WEBHOOK_SECRET`, `FB_PAGE_ID`,
and later `FB_PAGE_TOKEN` (adding it turns off test mode).

## Changing things

- `/status` on the Worker shows whether Telegram can reach it.
- Test: `cd worker && npm test` (fake Telegram/Facebook, nothing is sent).
- Publish a change: `cd worker && npx wrangler deploy`.
- After the first deploy, open `https://pieces-poster.pieces-poster.workers.dev/setup` once to connect Telegram.
- To stop everything: Cloudflare dashboard → Workers → pieces-poster → Settings → Delete (or remove the bot token secret).
