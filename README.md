# Jewelry pieces auto-poster – مجوهرات السلام

The worker sends photos of a piece to the Telegram bot. The bot puts them in a queue and posts
**two pieces a day** to the Facebook page, at **4 PM and 9 PM Cairo time**.

This is completely separate from the gold price poster. It has its own GitHub repository and never touches it.

## How the worker uses it

- Send the photo of the piece to the bot.
- If a piece has 2 photos (or more), select them **together** and send them at once. They go out in one post.
- You can write a note under the photo, for example `حلق عيار 21`. It goes into the caption.
- The bot answers within about 15 minutes. It says when the piece will be posted and shows the caption.
- Commands:
  - `/list` shows the pieces waiting
  - `/delete 5` deletes piece number 5
  - `/merge` puts the last two pieces into one post (if 2 photos of the same piece were sent separately)
  - `/caption 5 new text` changes the caption of piece 5

## Captions

- Gemini looks at the photo and writes 2 lines in the page's own style (like the earrings post).
- Every post ends with: `💛 مجوهرات السلام… الدهب اللي يليق بذوقك.` To change it, edit `FOOTER` in `bot.py`.
- If Gemini doesn't work, the bot uses one of its ready-made captions in the same style. A post is never skipped because of the caption.
- Gemini uses a **free** API key from Google AI Studio. Your Gemini Pro subscription isn't needed for this.

## Alerts

From 1 PM to 11:30 PM, every 30 minutes, if there aren't enough pieces for the rest of today **and** all
of tomorrow, the bot sends a Telegram message: "⚠️ تنبيه: مفيش بوستات جاهزة لبكرة".
After each post it also sends "✅ اتنشرت". If a post fails, it says so once and keeps trying.

## Settings (top of `bot.py`)

- `POST_HOURS = [16, 21]` – posting times (Cairo)
- `ALERT_FROM = (13, 0)` and `ALERT_UNTIL = (23, 30)` – alerts only from 1 PM to 11:30 PM
- `ALERT_EVERY_MINUTES = 30`

## Safety

- Only the Telegram users listed in the `ALLOWED_USERS` secret can use the bot. Anyone else gets a polite "this bot is private" message with their number.
- The repository is **public** so its GitHub run minutes are free and never use up the gold poster's minutes.
  Because it's public, the queue is saved **encrypted** (`queue.enc`), and the logs only show counts and piece numbers.
- All keys are kept in GitHub Secrets, never in the code.
- Gemini's text is cleaned: links, phone numbers and hashtags are removed.

## GitHub Secrets

| Secret | What it is |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | from @BotFather |
| `ALLOWED_USERS` | Telegram numbers of the worker and the owner, like `12345, 67890` |
| `QUEUE_KEY` | the key that encrypts the queue |
| `GEMINI_API_KEY` | free key from aistudio.google.com |
| `FB_PAGE_ID`, `FB_PAGE_TOKEN` | same Page ID and Page key as the gold poster |

## Good to know

- To stop it: **Actions → Post jewelry pieces → ⋯ → Disable workflow**.
- **Run workflow** on that page checks Telegram right away (it posts only at posting time).
- Test on your computer, without sending anything: `python3 test_bot.py`.
