"""Post photos of jewelry pieces from Telegram to the Facebook page, two pieces a day.

The worker sends the (already enhanced) photos to the Telegram bot. GitHub Actions runs this
every 15 minutes, and each run:
1. reads new messages sent to the bot: photos go into the queue, commands get an answer,
2. posts the next piece in the queue if it's posting time,
3. warns on Telegram (every 30 minutes) if there aren't enough pieces ready for tomorrow.

Photos sent together (as one album) are one piece, and go out together in one post.
Captions are written by Gemini (free API key) from the photo; if Gemini fails, a ready-made
caption is used instead. The shop address, phones and hashtags are always added by this code.
TEST MODE: until FB_PAGE_TOKEN is set, nothing is posted to Facebook. At posting time the post is
sent to the allowed Telegram users instead, exactly as it would look on the page.
"""

import base64
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

# ---------------- Settings (safe to change) ----------------
POST_HOURS = [16, 21]       # post one piece at each of these Cairo hours (4 PM and 9 PM)
LATE_LIMIT_HOURS = 2        # if GitHub runs late, still post up to this many hours after the time
ALERT_FROM = (13, 0)        # send "not enough pieces" alerts only from 1:00 PM...
ALERT_UNTIL = (23, 30)      # ...until 11:30 PM (hour, minute, Cairo time)
ALERT_EVERY_MINUTES = 30
MAX_PHOTOS_PER_POST = 10
GEMINI_MODELS = ["gemini-flash-latest", "gemini-2.5-flash"]  # tried in this order
FB_API_VERSION = "v26.0"

SHOP_NAME = "مجوهرات السلام"
# The last line of every post, same as the page's own posts. Add the address or WhatsApp here if you want them too.
FOOTER = "💛 مجوهرات السلام… الدهب اللي يليق بذوقك."

# A real post from the page. Gemini copies its style.
STYLE_EXAMPLE = (
    "✨ مش مجرد حلق دهب… دي حكاية شياكة بتتحكي من أول نظرة! 💛👑\n"
    "تفاصيل كلها رقة، ولمعة كلها فخامة، وتصميم معمول عشان يسيب بصمة في كل إطلالة 😍✨"
)

# Used when Gemini is not available. {note} is what the worker wrote under the photo (if anything).
READY_CAPTIONS = [
    "✨ مش مجرد دهب… دي لمسة شياكة بتبان من أول نظرة! 💛👑\n{note}تفاصيل كلها رقة، ولمعة كلها فخامة 😍✨",
    "👑 لما الذوق يتقابل مع الدهب… تطلع قطعة زي دي! ✨💛\n{note}تصميم شيك يكمّل إطلالتك في كل مناسبة 😍",
    "💛 قطعة تخطف العين من أول نظرة! ✨\n{note}شغل نضيف ولمعة فخمة، معمولة مخصوص علشان تفرّحك 😍👑",
    "✨ الشياكة بتبدأ من التفاصيل… والتفاصيل هنا كلها دهب! 💛\n{note}رقة في التصميم وفخامة في اللمعة 😍✨",
    "🎁 هدية تفرّح أي حد بتحبه… وتفضل معاه العمر كله! 💛✨\n{note}تصميم رقيق ولمعة تليق بكل مناسبة 👑",
    "👑 دهب بيتكلم عن نفسه! ✨\n{note}تفاصيل مشغولة بحب، وتصميم يسيب بصمة في كل إطلالة 😍💛",
]

GEMINI_PROMPT = (
    "You write Facebook captions for " + SHOP_NAME + ", a gold jewelry shop in El Qanater El Khayreya, Egypt. "
    "The photo(s) show ONE gold piece the shop is selling. Write a caption in Egyptian Arabic, exactly 2 lines, "
    "in the same style as this real post from the page:\n\n" + STYLE_EXAMPLE + "\n\n"
    "Line 1: a catchy hook about this exact piece (say what it is), with 2 emojis like ✨💛👑. "
    "Line 2: describe its details, shine and feel, with 2 emojis like 😍✨. {note}"
    "Write something new, don't copy the example. Never write a price, weight or karat unless it is in the "
    "shop's note. Do not add hashtags, phone numbers, addresses, links or the shop's name. "
    "Reply with the 2 lines only, nothing else."
)

HELP = (
    "أهلاً 👋\n"
    "ابعت صورة القطعة هنا وأنا هنزلها على صفحة الفيسبوك.\n\n"
    "• لو القطعة ليها أكتر من صورة: اختار الصور مع بعض وابعتهم مرة واحدة، وهيتنشروا في بوست واحد.\n"
    "• تقدر تكتب تحت الصورة معلومة عن القطعة (مثلاً: خاتم عيار 21).\n"
    "• كل يوم بيتنشر قطعتين: الساعة 4 العصر و9 بالليل.\n\n"
    "الأوامر:\n"
    "/list – القطع اللي مستنية دورها\n"
    "/delete 5 – امسح قطعة رقم 5\n"
    "/merge – اجمع آخر قطعتين في بوست واحد\n"
    "/caption 5 الكلام الجديد – غيّر كلام قطعة رقم 5\n"
    "/preview – شوف البوست الجاي بالظبط زي ما هيتنشر\n\n"
    "⏳ الرد بيوصل خلال ربع ساعة تقريبًا."
)
# ------------------------------------------------------------

CAIRO = ZoneInfo("Africa/Cairo")
HERE = Path(__file__).parent
ENCRYPTED_FILE = HERE / "queue.enc"   # used on GitHub (the repo is public, so the queue is encrypted)
PLAIN_FILE = HERE / "queue.json"      # used for tests on your own computer
DAYS = ["الاتنين", "التلات", "الأربع", "الخميس", "الجمعة", "السبت", "الحد"]
MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو",
          "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"]


# ---------------- Saving the queue ----------------

def new_state():
    return {"offset": 0, "day": None, "posted_hours": [], "failed_slot": None,
            "last_alert": None, "next_id": 1, "pieces": []}


def load_state():
    key = os.environ.get("QUEUE_KEY")
    if key and ENCRYPTED_FILE.exists():
        from cryptography.fernet import Fernet
        return json.loads(Fernet(key.encode()).decrypt(ENCRYPTED_FILE.read_bytes()))
    if not key and PLAIN_FILE.exists():
        return json.loads(PLAIN_FILE.read_text())
    return new_state()


def save_state(state):
    text = json.dumps(state, ensure_ascii=False, indent=1)
    key = os.environ.get("QUEUE_KEY")
    if key:
        from cryptography.fernet import Fernet
        # Encrypted text changes on every save, so only save when something really changed.
        if ENCRYPTED_FILE.exists() and Fernet(key.encode()).decrypt(ENCRYPTED_FILE.read_bytes()).decode() == text:
            return
        ENCRYPTED_FILE.write_bytes(Fernet(key.encode()).encrypt(text.encode()))
    else:
        PLAIN_FILE.write_text(text)


# ---------------- Telegram ----------------

def telegram(method, **params):
    token = os.environ["TELEGRAM_BOT_TOKEN"]
    req = urllib.request.Request(f"https://api.telegram.org/bot{token}/{method}",
                                 data=json.dumps(params).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        result = json.loads(urllib.request.urlopen(req, timeout=60).read())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Telegram {method} failed: {e.code} {e.read().decode()[:300]}") from None
    except urllib.error.URLError as e:
        raise RuntimeError(f"Telegram {method} failed: {e.reason}") from None
    return result["result"]


def download_photo(file_id):
    token = os.environ["TELEGRAM_BOT_TOKEN"]
    path = telegram("getFile", file_id=file_id)["file_path"]
    try:
        return urllib.request.urlopen(f"https://api.telegram.org/file/bot{token}/{path}", timeout=60).read()
    except urllib.error.URLError:
        raise RuntimeError("Could not download a photo from Telegram") from None


def send(chat_id, text):
    try:
        telegram("sendMessage", chat_id=chat_id, text=text[:4000])
    except RuntimeError as e:
        print(f"Could not send a Telegram message: {e}")


def allowed_users():
    return [int(x) for x in re.findall(r"\d+", os.environ.get("ALLOWED_USERS", ""))]


def tell_everyone(text):
    for user in allowed_users():
        send(user, text)


# ---------------- Captions ----------------

def image_type(data):
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def clean_caption(text):
    """Keep only plain caption lines: no links, hashtags or phone numbers from the AI."""
    text = text.strip().strip("`\"'«»").strip()
    lines = []
    for line in text.splitlines():
        line = re.sub(r"https?://\S+|www\.\S+|#\S+", "", line).strip()
        if re.search(r"\d{7,}", line.replace(" ", "")):
            continue
        lines.append(line)
    text = re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()
    if not re.search(r"[؀-ۿ]", text) or not 10 <= len(text) <= 700:
        return None
    return text


def gemini_caption(images, note):
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        return None
    note_text = f'The shop\'s note about the piece: "{note}". ' if note else ""
    parts = [{"text": GEMINI_PROMPT.format(note=note_text)}]
    for data in images[:3]:
        if image_type(data):
            parts.append({"inline_data": {"mime_type": image_type(data), "data": base64.b64encode(data).decode()}})
    body = json.dumps({"contents": [{"parts": parts}], "generationConfig": {"temperature": 0.9}}).encode()
    for model in GEMINI_MODELS:
        req = urllib.request.Request(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
            data=body, headers={"Content-Type": "application/json", "x-goog-api-key": key})
        try:
            result = json.loads(urllib.request.urlopen(req, timeout=90).read())
            text = "".join(p.get("text", "") for p in result["candidates"][0]["content"]["parts"]
                           if not p.get("thought"))
        except urllib.error.HTTPError as e:
            print(f"Gemini {model} failed: {e.code}")
            continue
        except (urllib.error.URLError, KeyError, IndexError, TimeoutError, ValueError) as e:
            print(f"Gemini {model} failed: {type(e).__name__}")
            continue
        caption = clean_caption(text)
        if caption:
            return caption
        print(f"Gemini {model} gave an unusable caption")
    return None


def ready_caption(piece):
    note = f"{piece['note']}\n" if piece.get("note") else ""
    return READY_CAPTIONS[piece["id"] % len(READY_CAPTIONS)].format(shop=SHOP_NAME, note=note)


def write_caption(piece, images):
    piece["caption"] = gemini_caption(images, piece.get("note")) or ready_caption(piece)


# ---------------- Schedule ----------------

def upcoming_slots(state, now, count):
    """The next `count` posting times, starting with what's still left today."""
    slots, day = [], now.date()
    while len(slots) < count:
        for hour in POST_HOURS:
            at = datetime(day.year, day.month, day.day, hour, tzinfo=CAIRO)
            if day == now.date() and (hour in state["posted_hours"] or now >= at + timedelta(hours=LATE_LIMIT_HOURS)):
                continue
            slots.append(at)
        day += timedelta(days=1)
    return slots[:count]


def when_text(at, now):
    if at.date() == now.date():
        day = "النهارده"
    elif at.date() == now.date() + timedelta(days=1):
        day = "بكرة"
    else:
        day = f"{DAYS[at.weekday()]} {at.day} {MONTHS[at.month - 1]}"
    hour12 = at.hour % 12 or 12
    return f"{day} الساعة {hour12} {'صباحًا' if at.hour < 12 else 'مساءً'}"


def current_slot(state, now):
    for hour in POST_HOURS:
        if hour <= now.hour < hour + LATE_LIMIT_HOURS and hour not in state["posted_hours"]:
            return hour
    return None


def piece_schedule(state, now):
    slots = upcoming_slots(state, now, max(len(state["pieces"]), 1))
    return {p["id"]: when_text(at, now) for p, at in zip(state["pieces"], slots)}


# ---------------- Reading the bot's messages ----------------

def photo_file_id(msg):
    """Return (file_id, sent_as_file) for a photo message, or (None, False)."""
    if msg.get("photo"):
        return msg["photo"][-1]["file_id"], False    # the biggest size
    doc = msg.get("document") or {}
    if doc.get("mime_type", "").startswith("image/"):
        return doc["file_id"], True                  # photo sent as a file (keeps full quality)
    return None, False


def find_piece(state, piece_id):
    return next((p for p in state["pieces"] if p["id"] == piece_id), None)


def add_photo(state, msg, file_id, as_file, touched):
    group = msg.get("media_group_id")
    piece = next((p for p in state["pieces"] if group and p.get("group") == group), None)
    if piece is None:
        piece = {"id": state["next_id"], "photos": [], "group": group, "note": "", "caption": None,
                 "added": datetime.now(CAIRO).isoformat(timespec="minutes"), "from": msg["from"]["id"]}
        state["next_id"] += 1
        state["pieces"].append(piece)
    if file_id not in piece["photos"] and len(piece["photos"]) < MAX_PHOTOS_PER_POST:
        piece["photos"].append(file_id)
        if as_file:
            piece.setdefault("files", []).append(file_id)
    if msg.get("caption") and not piece["note"]:
        piece["note"] = msg["caption"].strip()[:300]
        piece["caption"] = None                      # write it again with the note
    if piece["id"] not in touched:
        touched.append(piece["id"])


def handle_command(state, chat, text, now):
    command, _, rest = text.partition(" ")
    command = command.split("@")[0].lower()
    rest = rest.strip()
    if command in ("/start", "/help"):
        return send(chat, HELP)

    if command == "/list":
        if not state["pieces"]:
            return send(chat, "📭 مفيش قطع مستنية دلوقتي. ابعت صور القطع هنا.")
        times = piece_schedule(state, now)
        lines = [f"🗂 القطع اللي مستنية ({len(state['pieces'])}):"]
        for p in state["pieces"]:
            first = (p.get("caption") or p.get("note") or "").split("\n")[0][:50]
            lines.append(f"\nرقم {p['id']} – {len(p['photos'])} صورة – {times[p['id']]}\n{first}")
        return send(chat, "\n".join(lines))

    if command == "/delete":
        piece = find_piece(state, int(rest)) if rest.isdigit() else None
        if not piece:
            return send(chat, "اكتب رقم القطعة بعد الأمر، مثلاً: /delete 5\nشوف الأرقام بـ /list")
        state["pieces"].remove(piece)
        return send(chat, f"🗑 اتمسحت قطعة رقم {piece['id']}.")

    if command == "/merge":
        if len(state["pieces"]) < 2:
            return send(chat, "لازم يكون فيه قطعتين على الأقل علشان أجمعهم.")
        last = state["pieces"].pop()
        before = state["pieces"][-1]
        before["photos"] = (before["photos"] + last["photos"])[:MAX_PHOTOS_PER_POST]
        before["files"] = before.get("files", []) + last.get("files", [])
        before["note"] = before["note"] or last["note"]
        before["caption"] = None
        state.setdefault("recaption", []).append(before["id"])
        return send(chat, f"🔗 جمعت قطعة {last['id']} مع قطعة {before['id']} – هيتنشروا في بوست واحد "
                          f"({len(before['photos'])} صورة).")

    if command == "/caption":
        number, _, new_text = rest.partition(" ")
        piece = find_piece(state, int(number)) if number.isdigit() else None
        if not piece or not new_text.strip():
            return send(chat, "اكتبها كده: /caption 5 الكلام الجديد")
        piece["caption"] = new_text.strip()[:1500]
        return send(chat, f"✏️ اتغير كلام قطعة رقم {piece['id']}.")

    if command == "/preview":
        if not state["pieces"]:
            return send(chat, "📭 مفيش قطع مستنية دلوقتي.")
        piece = state["pieces"][0]
        if not piece.get("caption"):
            write_caption(piece, [download_photo(f) for f in piece["photos"][:3]])
        return send_preview(chat, piece, f"👀 ده البوست الجاي (قطعة رقم {piece['id']} – {piece_schedule(state, now)[piece['id']]}):")

    send(chat, "مش فاهم الأمر ده 🙂\n\n" + HELP)


def read_messages(state, now):
    updates = telegram("getUpdates", offset=state["offset"], timeout=0, allowed_updates=["message"])
    print(f"New Telegram messages: {len(updates)}")
    allowed, touched = allowed_users(), []
    for update in updates:
        state["offset"] = update["update_id"] + 1
        msg = update.get("message")
        if not msg or msg.get("chat", {}).get("type") != "private":
            continue
        user, chat = msg["from"]["id"], msg["chat"]["id"]
        if user not in allowed:
            send(chat, f"أهلاً 👋 البوت ده خاص بـ {SHOP_NAME}.\nرقمك هو: {user}\nابعته لصاحب المحل علشان يضيفك.")
            continue
        file_id, as_file = photo_file_id(msg)
        if file_id:
            add_photo(state, msg, file_id, as_file, touched)
        elif msg.get("text", "").startswith("/"):
            try:
                handle_command(state, chat, msg["text"], now)
            except (ValueError, RuntimeError) as e:
                print(f"Command failed: {type(e).__name__}")
                send(chat, "في حاجة غلط في الأمر، جرب تاني.")
        else:
            send(chat, "ابعت صورة القطعة، أو اكتب /help علشان تشوف الأوامر.")

    # Write captions for new pieces and tell the sender when each one will be posted.
    touched += [i for i in state.pop("recaption", []) if i not in touched]
    times = piece_schedule(state, now)
    for piece_id in touched:
        piece = find_piece(state, piece_id)
        if not piece:
            continue
        if piece["caption"] is None:
            try:
                write_caption(piece, [download_photo(f) for f in piece["photos"][:3]])
            except RuntimeError as e:
                print(f"Caption for piece {piece_id} will be written at posting time: {e}")
        send(piece["from"],
             f"✅ استلمت قطعة رقم {piece['id']} ({len(piece['photos'])} صورة)\n"
             f"🗓 هتتنشر {times[piece['id']]}\n\n"
             f"📝 الكلام اللي هيتكتب:\n{piece['caption'] or '(هيتكتب وقت النشر)'}\n\n"
             f"لتغييره: /caption {piece['id']} الكلام الجديد")


def send_preview(chat, piece, header):
    """Show a post on Telegram exactly as it will look on Facebook: the photos with the full caption."""
    send(chat, header)
    caption = full_caption(piece)[:1024]
    files = piece.get("files", [])
    media = [{"type": "document" if f in files else "photo", "media": f} for f in piece["photos"]]
    media[0]["caption"] = caption
    try:
        if len(media) == 1:
            method = "sendDocument" if media[0]["type"] == "document" else "sendPhoto"
            telegram(method, chat_id=chat, caption=caption, **{media[0]["type"]: media[0]["media"]})
        else:
            if len({m["type"] for m in media}) > 1:      # Telegram can't mix photos and files in one album
                for m in media:
                    m["type"] = "document"
            telegram("sendMediaGroup", chat_id=chat, media=media)
    except RuntimeError as e:
        print(f"Could not send a preview: {e}")
        send(chat, caption)


def full_caption(piece):
    return f"{piece['caption']}\n\n{FOOTER}"


# ---------------- Facebook ----------------

def facebook(path, fields, image=None):
    fields = dict(fields, access_token=os.environ["FB_PAGE_TOKEN"])
    if image is None:
        data, content_type = urllib.parse.urlencode(fields).encode(), "application/x-www-form-urlencoded"
    else:
        boundary = uuid.uuid4().hex
        parts = [f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
                 for k, v in fields.items()]
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="source"; filename="piece"\r\n'
                     f"Content-Type: {image_type(image) or 'image/jpeg'}\r\n\r\n".encode() + image + b"\r\n")
        parts.append(f"--{boundary}--\r\n".encode())
        data, content_type = b"".join(parts), f"multipart/form-data; boundary={boundary}"
    req = urllib.request.Request(f"https://graph.facebook.com/{FB_API_VERSION}/{os.environ['FB_PAGE_ID']}/{path}",
                                 data=data, headers={"Content-Type": content_type})
    try:
        return json.loads(urllib.request.urlopen(req, timeout=120).read())
    except urllib.error.HTTPError as e:
        # Print Facebook's error without ever printing the token.
        raise RuntimeError(f"Facebook refused the post: {e.code} {e.read().decode()[:500]}") from None
    except urllib.error.URLError as e:
        raise RuntimeError(f"Could not reach Facebook: {e.reason}") from None


def post_to_facebook(images, caption):
    """One photo -> photo post. Several photos -> one post with all of them. Returns the post id."""
    if len(images) == 1:
        result = facebook("photos", {"caption": caption}, images[0])
        return result.get("post_id", result["id"])
    ids = [facebook("photos", {"published": "false"}, image)["id"] for image in images]
    fields = {"message": caption}
    for i, photo_id in enumerate(ids):
        fields[f"attached_media[{i}]"] = json.dumps({"media_fbid": photo_id})
    return facebook("feed", fields)["id"]


def post_if_time(state, now):
    slot = current_slot(state, now)
    if slot is None:
        return
    slot_name = f"{now:%Y-%m-%d} {slot}"
    if not state["pieces"]:
        state["posted_hours"].append(slot)
        print(f"Nothing to post at {slot}:00")
        return tell_everyone(f"⚠️ كان المفروض يتنشر بوست الساعة {slot % 12 or 12}، بس مفيش قطع في الطابور.\n"
                             "📸 ابعت صور القطع هنا.")
    piece = state["pieces"][0]
    if not os.environ.get("FB_PAGE_TOKEN"):
        # TEST MODE: show the post on Telegram instead of posting it.
        if not piece.get("caption"):
            write_caption(piece, [download_photo(f) for f in piece["photos"][:3]])
        state["pieces"].pop(0)
        state["posted_hours"].append(slot)
        save_state(state)
        print(f"Test mode: sent piece {piece['id']} to Telegram instead of Facebook")
        for user in allowed_users():
            send_preview(user, piece, f"🧪 تجربة – ده البوست اللي كان هيتنشر دلوقتي على الصفحة "
                                      f"(قطعة رقم {piece['id']}). ما اتنشرش على الفيسبوك.")
        return
    try:
        images = [download_photo(f) for f in piece["photos"]]
        if not piece.get("caption"):
            write_caption(piece, images)
        post_id = post_to_facebook(images, full_caption(piece))
    except RuntimeError as e:
        print(f"Posting piece {piece['id']} failed: {e}")
        if state.get("failed_slot") != slot_name:     # tell people once, then keep trying quietly
            state["failed_slot"] = slot_name
            tell_everyone(f"❌ حصلت مشكلة في نشر قطعة رقم {piece['id']}. هحاول تاني كمان شوية.\n{str(e)[:200]}")
        return
    state["pieces"].pop(0)
    state["posted_hours"].append(slot)
    save_state(state)                                 # save right away, so it never posts twice
    print(f"Posted piece {piece['id']}: {post_id}")
    tell_everyone(f"✅ اتنشرت قطعة رقم {piece['id']} على الصفحة.\nفاضل في الطابور: {len(state['pieces'])} قطعة.")


# ---------------- Alerts ----------------

def alert_if_needed(state, now):
    """Warn if the queue doesn't cover what's left today plus all of tomorrow."""
    left_today = sum(1 for at in upcoming_slots(state, now, len(POST_HOURS)) if at.date() == now.date())
    missing = left_today + len(POST_HOURS) - len(state["pieces"])
    if missing <= 0 or not ALERT_FROM <= (now.hour, now.minute) <= ALERT_UNTIL:
        return
    last = state.get("last_alert")
    if last and now - datetime.fromisoformat(last) < timedelta(minutes=ALERT_EVERY_MINUTES - 5):
        return
    state["last_alert"] = now.isoformat(timespec="minutes")
    print(f"Alert: {missing} more piece(s) needed")
    tell_everyone(f"⚠️ تنبيه: مفيش بوستات جاهزة لبكرة.\n"
                  f"في الطابور {len(state['pieces'])} قطعة، ومحتاجين {missing} قطعة كمان.\n"
                  f"📸 ابعت صور القطع هنا.")


def main():
    if not os.environ.get("TELEGRAM_BOT_TOKEN"):
        return print("TEST MODE – set TELEGRAM_BOT_TOKEN to run for real. Run test_bot.py to test.")
    now = datetime.now(CAIRO)
    state = load_state()
    if state.get("day") != now.strftime("%Y-%m-%d"):
        state.update(day=now.strftime("%Y-%m-%d"), posted_hours=[], failed_slot=None)
    try:
        read_messages(state, now)
        post_if_time(state, now)
        alert_if_needed(state, now)
    finally:
        save_state(state)


if __name__ == "__main__":
    sys.exit(main())
