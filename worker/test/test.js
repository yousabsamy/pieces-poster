// Test the bot with a fake Telegram, Facebook and Gemini. Nothing is sent anywhere.
// Run: npm test

import assert from "node:assert/strict";
import { BotCore, FOOTER, cairoTime, cleanCaption } from "../src/core.js";

const WORKER = 111, STRANGER = 999;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]);
let sent = [], previews = [], fb = [], fbFail = false, geminiText = "✨ حلق دهب رقيق بيلمع 💛👑\nتفاصيل ناعمة ولمعة فخمة 😍✨";
let clock = 0, alarm = null;

async function fakeFetch(url, options = {}) {
  const json = (data, status = 200) => ({ ok: status < 400, status, json: async () => data, text: async () => JSON.stringify(data) });
  if (url.includes("api.telegram.org/file/")) return { ok: true, arrayBuffer: async () => JPEG.buffer };
  if (url.includes("api.telegram.org")) {
    const method = url.split("/").pop();
    const params = JSON.parse(options.body);
    if (method === "sendMessage") sent.push([params.chat_id, params.text]);
    else if (method === "getFile") return json({ ok: true, result: { file_path: "p.jpg" } });
    else previews.push([method, params]);
    return json({ ok: true, result: {} });
  }
  if (url.includes("generativelanguage")) {
    return geminiText ? json({ candidates: [{ content: { parts: [{ text: geminiText }] } }] }) : json({}, 429);
  }
  if (url.includes("graph.facebook.com")) {
    if (fbFail) return json({ error: "test" }, 500);
    const fields = Object.fromEntries([...options.body.entries()].filter(([k]) => k !== "source"));
    fb.push([url.split("/").pop(), fields]);
    return json({ id: `id${fb.length}`, post_id: `post${fb.length}` });
  }
  throw new Error(url);
}

const store = new Map();
const storage = {
  get: async (k) => structuredClone(store.get(k)),
  put: async (k, v) => store.set(k, structuredClone(v)),
  setAlarm: async (ms) => { alarm = ms; },
};
const env = { ALLOWED_USERS: String(WORKER), TELEGRAM_BOT_TOKEN: "t", GEMINI_API_KEY: "g", FB_PAGE_ID: "1", FB_PAGE_TOKEN: "x" };
const bot = new BotCore(storage, env, fakeFetch, () => clock);

// Set the fake clock to this Cairo time (works with or without Egypt's summer time).
const at = (hour, minute = 0, day = 28) => {
  clock = Date.UTC(2026, 9, day, hour, minute);
  for (let i = 0; i < 3; i++) clock -= (((cairoTime(clock).hour - hour + 36) % 24) - 12) * 3600 * 1000;
  assert.equal(cairoTime(clock).hour, hour);
};
let updateId = 0;
function msg(user, { photo, text, caption, group, document } = {}) {
  const m = { message_id: ++updateId, from: { id: user }, chat: { id: user, type: "private" } };
  if (photo) m.photo = [{ file_id: photo + "-small" }, { file_id: photo }];
  if (document) m.document = document;
  if (text) m.text = text;
  if (caption) m.caption = caption;
  if (group) m.media_group_id = group;
  return bot.handleUpdate({ update_id: updateId, message: m });
}
const to = (user) => sent.filter(([u]) => u === user).map(([, t]) => t);
const alerts = () => to(WORKER).filter((t) => t.startsWith("⚠️ تنبيه"));

// 1. A stranger is not let in, and is told their number.
at(9);
await msg(STRANGER, { photo: "s1" });
assert.equal(bot.state.pieces.length, 0);
assert.match(to(STRANGER)[0], /999[\s\S]*يوساب/);

// 2. An album of 2 photos (with a note) = 1 piece, answered once after the album is complete.
await msg(WORKER, { photo: "a1", caption: "حلق عيار 21", group: "G1" });
await msg(WORKER, { photo: "a2", group: "G1" });
await msg(WORKER, { photo: "b1" });
assert.equal(to(WORKER).length, 0);          // no answer yet, waiting for the rest of the album
assert.ok(alarm);
await bot.albumDone();
assert.deepEqual(bot.state.pieces.map((p) => p.photos.length), [2, 1]);
assert.equal(bot.state.pieces[0].note, "حلق عيار 21");
const replies = to(WORKER);
assert.equal(replies.length, 2);
assert.match(replies[0], /النهارده الساعة 4 مساءً/);
assert.match(replies[1], /النهارده الساعة 9 مساءً/);
console.log("Reply to the worker:\n" + replies[0] + "\n");

// 3. Commands.
await msg(WORKER, { photo: "c1" });
await msg(WORKER, { photo: "c2" });
await bot.albumDone();
await msg(WORKER, { text: "/merge" });
await msg(WORKER, { text: "/caption 2 كلام جديد" });
await msg(WORKER, { photo: "d1" });
await bot.albumDone();
await msg(WORKER, { text: "/delete 5" });
sent = [];
await msg(WORKER, { text: "/list" });
assert.deepEqual(bot.state.pieces.map((p) => p.id), [1, 2, 3]);
assert.deepEqual(bot.state.pieces[2].photos, ["c1", "c2"]);
assert.equal(bot.state.pieces[1].caption, "كلام جديد");
assert.match(to(WORKER)[0], /بكرة الساعة 4 مساءً/);
console.log("/list:\n" + to(WORKER)[0] + "\n");

// 4. Alerts: 3 pieces, but today (2) + tomorrow (2) need 4 -> alert from 1 PM, every 30 minutes, until 11:30 PM.
sent = [];
at(12, 45); await bot.tick();
assert.equal(alerts().length, 0);
at(13); await bot.tick();
assert.equal(alerts().length, 1);
at(13, 15); await bot.tick();
assert.equal(alerts().length, 1);
at(13, 30); await bot.tick();
assert.equal(alerts().length, 2);

// 5. 4 PM posts piece 1 (2 photos in one post), never twice.
at(16, 5); await bot.tick();
assert.deepEqual(fb.map((c) => c[0]), ["photos", "photos", "feed"]);
assert.ok(fb[2][1].message.endsWith(FOOTER) && "attached_media[1]" in fb[2][1]);
console.log("Facebook post:\n" + fb[2][1].message + "\n");
at(16, 10); await bot.tick();
assert.equal(fb.length, 3);

// 6. A Facebook error: told once, piece kept, works on the next try.
fbFail = true; sent = [];
at(21, 5); await bot.tick();
at(21, 10); await bot.tick();
assert.equal(to(WORKER).filter((t) => t.startsWith("❌")).length, 1);
fbFail = false;
at(21, 15); await bot.tick();
assert.equal(fb.at(-1)[0], "photos");
assert.ok(fb.at(-1)[1].caption.startsWith("كلام جديد"));
assert.deepEqual(bot.state.pieces.map((p) => p.id), [3]);
sent = [];
at(23, 20); await bot.tick();
assert.equal(alerts().length, 1);         // still alerts at 11:20 PM
at(23, 55); await bot.tick();
assert.equal(alerts().length, 1);         // quiet after 11:30 PM

// 7. Next day: piece 3 at 4 PM; nothing left at 9 PM -> one warning.
at(16, 5, 29); await bot.tick();
sent = [];
at(21, 5, 29); await bot.tick();
at(21, 10, 29); await bot.tick();
assert.equal(to(WORKER).filter((t) => t.includes("مفيش قطع في الطابور")).length, 1);

// 8. TEST MODE (no Facebook key): the post goes to Telegram, never to Facebook.
delete env.FB_PAGE_TOKEN;
geminiText = null;                        // Gemini down -> ready-made caption
at(10, 0, 30);
await msg(WORKER, { photo: "e1", caption: "سلسلة", group: "G9" });
await msg(WORKER, { photo: "e2", group: "G9" });
await bot.albumDone();
assert.match(bot.state.pieces[0].caption, /سلسلة/);
await msg(WORKER, { text: "/preview" });
assert.equal(previews.at(-1)[0], "sendMediaGroup");
assert.equal(bot.state.pieces.length, 1);  // /preview doesn't use up the piece
const fbBefore = fb.length;
sent = [];
at(16, 5, 30); await bot.tick();
assert.equal(fb.length, fbBefore);
assert.ok(to(WORKER).some((t) => t.startsWith("🧪 تجربة")));
assert.ok(previews.at(-1)[1].media[0].caption.endsWith(FOOTER));
await msg(WORKER, { document: { file_id: "f1", mime_type: "image/jpeg" } });
await bot.albumDone();
at(21, 5, 30); await bot.tick();
assert.equal(previews.at(-1)[0], "sendDocument");

// 9. The saved queue survives a restart.
const fresh = new BotCore(storage, env, fakeFetch, () => clock);
await fresh.load();
assert.deepEqual(fresh.state.pieces, bot.state.pieces);

// 10. AI captions are cleaned of links, phones and hashtags.
assert.equal(cleanCaption("✨ حلق شيك 💛\nكلمنا 01012087660\nhttps://x.com #دهب"), "✨ حلق شيك 💛");
assert.equal(cleanCaption("hello"), null);

console.log("All tests passed ✅");
