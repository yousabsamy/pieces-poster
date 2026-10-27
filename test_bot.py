"""Test bot.py with a fake Telegram and a fake Facebook. Nothing is sent anywhere.

Run: python3 test_bot.py
"""

import os
import tempfile
from datetime import datetime
from pathlib import Path

import bot

WORKER, STRANGER = 111, 999
JPEG = b"\xff\xd8\xff" + b"0" * 100
sent, fb_calls, inbox = [], [], []
fb_should_fail = False


def fake_telegram(method, **params):
    if method == "getUpdates":
        updates = [u for u in inbox if u["update_id"] >= params["offset"]]
        return updates
    if method == "sendMessage":
        sent.append((params["chat_id"], params["text"]))
        return {}
    raise AssertionError(method)


def fake_facebook(path, fields, image=None):
    if fb_should_fail:
        raise RuntimeError("Facebook refused the post: 500 test")
    fb_calls.append((path, fields, image is not None))
    return {"id": f"id{len(fb_calls)}", "post_id": f"post{len(fb_calls)}"}


def message(user, update_id, photo=None, text=None, caption=None, group=None):
    msg = {"message_id": update_id, "from": {"id": user}, "chat": {"id": user, "type": "private"}}
    if photo:
        msg["photo"] = [{"file_id": photo + "-small"}, {"file_id": photo}]
    if text:
        msg["text"] = text
    if caption:
        msg["caption"] = caption
    if group:
        msg["media_group_id"] = group
    inbox.append({"update_id": update_id, "message": msg})


def at(hour, minute=0, day=28):
    return datetime(2026, 10, day, hour, minute, tzinfo=bot.CAIRO)


def run(state, now):
    if state.get("day") != now.strftime("%Y-%m-%d"):
        state.update(day=now.strftime("%Y-%m-%d"), posted_hours=[], failed_slot=None)
    bot.read_messages(state, now)
    bot.post_if_time(state, now)
    bot.alert_if_needed(state, now)


def texts_to(user):
    return [t for u, t in sent if u == user]


def main():
    global fb_should_fail
    tmp = Path(tempfile.mkdtemp())
    bot.PLAIN_FILE, bot.ENCRYPTED_FILE = tmp / "queue.json", tmp / "queue.enc"
    bot.telegram, bot.facebook = fake_telegram, fake_facebook
    bot.download_photo = lambda file_id: JPEG
    os.environ.update(ALLOWED_USERS=str(WORKER), FB_PAGE_TOKEN="x", FB_PAGE_ID="1")
    os.environ.pop("GEMINI_API_KEY", None)
    os.environ.pop("QUEUE_KEY", None)
    state = bot.new_state()

    # 1. A stranger is not let in, and is told their number.
    message(STRANGER, 1, photo="s1")
    run(state, at(9))
    assert not state["pieces"] and "999" in texts_to(STRANGER)[0]

    # 2. Album of 2 photos (with a note) = 1 piece; a single photo = 1 more piece.
    message(WORKER, 2, photo="a1", caption="حلق عيار 21", group="G1")
    message(WORKER, 3, photo="a2", group="G1")
    message(WORKER, 4, photo="b1")
    sent.clear()
    run(state, at(9, 15))
    assert [len(p["photos"]) for p in state["pieces"]] == [2, 1]
    assert state["pieces"][0]["note"] == "حلق عيار 21"
    assert "حلق عيار 21" in state["pieces"][0]["caption"]
    replies = texts_to(WORKER)
    assert len([r for r in replies if r.startswith("✅ استلمت")]) == 2
    assert "النهارده الساعة 4 مساءً" in replies[0] and "النهارده الساعة 9 مساءً" in replies[1]
    print("Reply to the worker:\n" + replies[0] + "\n")

    # 3. A late photo from the same album (next run) joins the same piece.
    message(WORKER, 5, photo="a3", group="G1")
    run(state, at(9, 30))
    assert [len(p["photos"]) for p in state["pieces"]] == [3, 1]

    # 4. Commands.
    message(WORKER, 6, photo="c1")
    message(WORKER, 7, photo="c2")
    message(WORKER, 8, text="/merge")
    message(WORKER, 9, text="/caption 2 كلام جديد")
    message(WORKER, 10, text="/list")
    message(WORKER, 11, photo="d1")
    message(WORKER, 12, text="/delete 5")
    sent.clear()
    run(state, at(9, 45))
    assert [p["id"] for p in state["pieces"]] == [1, 2, 3]
    assert state["pieces"][2]["photos"] == ["c1", "c2"]
    assert state["pieces"][1]["caption"] == "كلام جديد"
    listing = next(t for t in texts_to(WORKER) if t.startswith("🗂"))
    assert "بكرة الساعة 4 مساءً" in listing
    print("/list:\n" + listing + "\n")

    # 5. Alerts: 3 pieces, but today (2) + tomorrow (2) need 4 -> alert, then only every 30 minutes.
    def alerts():
        return [t for t in texts_to(WORKER) if t.startswith("⚠️ تنبيه")]
    sent.clear()
    run(state, at(12, 45))                    # too early: alerts start at 1 PM
    assert len(alerts()) == 0
    run(state, at(13))
    assert len(alerts()) == 1, alerts()
    print("Alert:\n" + alerts()[0] + "\n")
    run(state, at(13, 15))
    assert len(alerts()) == 1
    run(state, at(13, 31))
    assert len(alerts()) == 2

    # 6. Posting: 4 PM posts piece 1 (3 photos in one post), and never twice.
    sent.clear()
    run(state, at(16, 5))
    assert [c[0] for c in fb_calls] == ["photos", "photos", "photos", "feed"]
    feed = fb_calls[-1][1]
    assert "attached_media[2]" in feed and feed["message"].endswith(bot.FOOTER)
    print("Facebook post text:\n" + feed["message"] + "\n")
    run(state, at(16, 20))
    assert len(fb_calls) == 4 and [p["id"] for p in state["pieces"]] == [2, 3]

    # 7. A Facebook error: told once, piece kept, then it works on the next try.
    fb_should_fail = True
    sent.clear()
    run(state, at(21, 5))
    run(state, at(21, 20))
    assert len([t for t in texts_to(WORKER) if t.startswith("❌")]) == 1
    assert [p["id"] for p in state["pieces"]] == [2, 3]
    fb_should_fail = False
    run(state, at(21, 35))
    assert fb_calls[-1][0] == "photos" and fb_calls[-1][1]["caption"].startswith("كلام جديد")
    assert [p["id"] for p in state["pieces"]] == [3]
    before = len(alerts())
    run(state, at(23, 20))                    # still alerts at 11:20 PM
    assert len(alerts()) == before + 1
    run(state, at(23, 55))                    # quiet after 11:30 PM
    assert len(alerts()) == before + 1

    # 8. Next day: piece 3 posts at 4 PM, then nothing is left for 9 PM -> warning, slot closed.
    run(state, at(16, 5, day=29))
    sent.clear()
    run(state, at(21, 5, day=29))
    run(state, at(21, 20, day=29))
    assert len([t for t in texts_to(WORKER) if "مفيش قطع في الطابور" in t]) == 1

    # 9. The saved queue is encrypted when QUEUE_KEY is set.
    from cryptography.fernet import Fernet
    os.environ["QUEUE_KEY"] = Fernet.generate_key().decode()
    bot.save_state(state)
    assert "pieces" not in bot.ENCRYPTED_FILE.read_bytes().decode()
    assert bot.load_state() == state
    os.environ.pop("QUEUE_KEY")

    # 10. AI captions are cleaned of links, phones and hashtags.
    assert bot.clean_caption("✨ حلق شيك 💛\nكلمنا 01012087660\nhttps://x.com #دهب") == "✨ حلق شيك 💛"
    assert bot.clean_caption("hello") is None

    print("All tests passed ✅")


if __name__ == "__main__":
    main()
