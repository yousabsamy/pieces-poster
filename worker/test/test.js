// Test the bot with a fake Telegram, Facebook and Gemini. Nothing is sent anywhere.
// Run: npm test

import assert from "node:assert/strict";
import { BotCore, CONTACT, cairoTime, cleanCaption } from "../src/core.js";
// Stories are off for now, so the story checks are skipped (they passed when Stories were on).

const WORKER = 111, STRANGER = 999;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]);
let sent = [], previews = [], fb = [], fbFail = false, geminiText = "✨ حلق دهب رقيق بيلمع 💛👑\nتفاصيل ناعمة ولمعة فخمة 😍✨\nمجوهرات السلام — ذوقك له بريقه";
let clock = 0, alarmSet = false;

async function fakeFetch(url, options = {}) {
  const json = (data, status = 200) => ({ ok: status < 400, status, json: async () => data, text: async () => JSON.stringify(data) });
  if (url.includes("api.telegram.org/file/")) return { ok: true, arrayBuffer: async () => JPEG.buffer };
  if (url.includes("api.telegram.org")) {
    const method = url.split("/").pop();
    const params = options.body instanceof FormData
      ? Object.fromEntries([...options.body.entries()].map(([k, v]) => [k, k === "media" ? JSON.parse(v) : v]))
      : JSON.parse(options.body);
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
  setAlarm: async () => { alarmSet = true; },
};
const env = { ALLOWED_USERS: String(WORKER), USER_NAMES: `${WORKER}:هيما`, TELEGRAM_BOT_TOKEN: "t", GEMINI_API_KEY: "g", FB_PAGE_ID: "1", FB_PAGE_TOKEN: "x" };
const bot = new BotCore(storage, env, fakeFetch, () => clock);
bot.geminiWaits = [0, 0];   // retry without real waiting in tests

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
  return bot.handleUpdate({ update_id: updateId, message: m }).then(background);
}
async function background() {   // what the Durable Object alarm does right after
  if (alarmSet) { alarmSet = false; await bot.backgroundWork(); }
}
function tap(user, count) {   // the worker taps a number button
  return bot.handleUpdate({ update_id: ++updateId, callback_query: {
    id: "q" + updateId, from: { id: user }, data: `count:${count}`, message: { message_id: 1, chat: { id: user } } } })
    .then(background);
}
const asks = () => sent.filter(([, t]) => t.startsWith("📸") && t.includes("كام صورة")).length;
const to = (user) => sent.filter(([u]) => u === user).map(([, t]) => t);
const alerts = () => to(WORKER).filter((t) => t.startsWith("⚠️ تنبيه"));

// 1. A stranger is not let in, and is told their number.
at(9);
await msg(STRANGER, { photo: "s1" });
assert.equal(bot.state.pieces.length, 0);
assert.match(to(STRANGER)[0], /999[\s\S]*يوساب/);

// 2. /start asks how many photos. Tap 2, send 2 photos -> 1 piece with 2 photos, then it asks again.
await msg(WORKER, { text: "/start" });
assert.equal(asks(), 1);
await tap(WORKER, 2);
await msg(WORKER, { photo: "a1" });
assert.equal(bot.state.pieces.length, 0);    // still waiting for the 2nd photo
await msg(WORKER, { photo: "a2" });
assert.deepEqual(bot.state.pieces.map((p) => p.photos), [["a1", "a2"]]);
assert.equal(asks(), 2);
const ready = to(WORKER).find((t) => t.includes("✅ بوست رقم 1"));
assert.match(ready, /الله ينور يا هيما/);
assert.match(ready, /النهارده الساعة 3 مساءً/);
console.log("Reply to the worker:\n" + ready + "\n");

// 3. Photos sent BEFORE choosing: the bot asks once, then the number finishes the piece.
await msg(WORKER, { photo: "b1" });
assert.equal(asks(), 3);
await tap(WORKER, 1);
assert.deepEqual(bot.state.pieces.at(-1).photos, ["b1"]);
// More photos than chosen: the extra one starts the next piece and the bot asks about it.
await tap(WORKER, 1);
await msg(WORKER, { photo: "c1" });
await msg(WORKER, { photo: "c2" });
assert.deepEqual(bot.state.pieces.at(-1).photos, ["c1"]);
assert.deepEqual(bot.state.open.photos, ["c2"]);
await msg(WORKER, { text: "/cancel" });
assert.equal(bot.state.open, null);
await tap(WORKER, 2);
await msg(WORKER, { photo: "d1" });
await msg(WORKER, { photo: "d2" });

// Commands.
await msg(WORKER, { text: "/caption 2 كلام جديد" });
await msg(WORKER, { text: "/delete 3" });
sent = [];
await msg(WORKER, { text: "/list" });
assert.deepEqual(bot.state.pieces.map((p) => p.id), [1, 2, 4]);
assert.deepEqual(bot.state.pieces[2].photos, ["d1", "d2"]);
assert.equal(bot.state.pieces[1].caption, "كلام جديد");
assert.match(to(WORKER)[0], /بكرة الساعة 3 مساءً/);
console.log("/list:\n" + to(WORKER)[0] + "\n");
// A stranger can't press the buttons.
await tap(STRANGER, 3);
assert.equal(bot.state.open, null);

// 4. Alerts: 3 posts, but today (2) + tomorrow (2) need 4 -> alert from 1 PM, every hour, until 11:30 PM.
sent = [];
at(12, 45); await bot.tick();
assert.equal(alerts().length, 0);
at(13); await bot.tick();
assert.equal(alerts().length, 1);
at(13, 30); await bot.tick();
assert.equal(alerts().length, 1);         // not again after only 30 minutes
at(14); await bot.tick();
assert.equal(alerts().length, 2);

// 5. 4 PM posts piece 1 (2 photos in one post), never twice. Then its 2 photos go up as stories.
at(15, 5); await bot.tick();
assert.deepEqual(fb.map((c) => c[0]), ["photos", "photos", "feed"]);
assert.ok(fb[2][1].message.includes("مجوهرات السلام — ذوقك له بريقه") && "attached_media[1]" in fb[2][1]);
assert.ok(fb[2][1].message.endsWith(CONTACT));
console.log("Facebook post:\n" + fb[2][1].message + "\n");
at(15, 10); await bot.tick();
assert.equal(fb.length, 3);

// 6. A Facebook error: told once, piece kept, works on the next try.
fbFail = true; sent = [];
at(22, 5); await bot.tick();
at(22, 10); await bot.tick();
assert.equal(to(WORKER).filter((t) => t.startsWith("❌")).length, 1);
fbFail = false;
at(22, 15); await bot.tick();
const single = fb.filter((c) => c[0] === "photos" && c[1].caption).at(-1);
assert.ok(single[1].caption.startsWith("كلام جديد"));
assert.equal(fb.at(-1)[0], "photos");
assert.deepEqual(bot.state.pieces.map((p) => p.id), [4]);
sent = [];
at(23, 20); await bot.tick();
assert.equal(alerts().length, 1);         // still alerts at 11:20 PM
at(23, 55); await bot.tick();
assert.equal(alerts().length, 1);         // quiet after 11:30 PM

// 7. Next day: piece 3 at 4 PM; nothing left at 9 PM -> one warning.
at(15, 5, 29); await bot.tick();
sent = [];
at(22, 5, 29); await bot.tick();
at(22, 10, 29); await bot.tick();
assert.equal(to(WORKER).filter((t) => t.includes("بس مفيش بوستات جاهزة")).length, 1);

// 8. TEST MODE (no Facebook key): the post goes to Telegram, never to Facebook.
delete env.FB_PAGE_TOKEN;
geminiText = null;                        // Gemini down -> it waits and retries, then a ready-made caption
at(10, 0, 30);
sent = [];
await tap(WORKER, 2);
await msg(WORKER, { photo: "e1", caption: "سلسلة" });
await msg(WORKER, { photo: "e2" });
assert.equal(bot.state.pieces[0].caption, null);           // not given up yet
assert.equal(to(WORKER).filter((t) => t.includes("Gemini مشغول")).length, 1);
for (let i = 0; i < 5; i++) await bot.backgroundWork();     // the retries, 3 minutes apart on Cloudflare
assert.match(bot.state.pieces[0].caption, /سلسلة/);
assert.equal(bot.state.to_caption.length, 0);
assert.equal(to(WORKER).filter((t) => t.includes("Gemini مشغول")).length, 1);   // said only once
await msg(WORKER, { text: "/preview" });
assert.equal(previews.at(-1)[0], "sendMediaGroup");
assert.equal(bot.state.pieces.length, 1);  // /preview doesn't use up the piece
const fbBefore = fb.length;
sent = [];
at(15, 5, 30); await bot.tick();
assert.equal(fb.length, fbBefore);
assert.ok(to(WORKER).some((t) => t.startsWith("🧪 تجربة")));

assert.match(previews.filter(([m]) => m === "sendMediaGroup").at(-1)[1].media[0].caption, /مجوهرات السلام/);
await tap(WORKER, 1);
await msg(WORKER, { document: { file_id: "f1", mime_type: "image/jpeg" } });
at(22, 5, 30); await bot.tick();
assert.equal(previews.at(-1)[0], "sendPhoto");      // previews always show photos (with the logo)

// 9c. Text from the worker goes into the piece's note and into Gemini's instructions.
let lastPrompt = "";
const realFetch = bot.fetch;
bot.fetch = async (url, options) => {
  if (url.includes("generativelanguage")) lastPrompt = JSON.parse(options.body).contents[0].parts[0].text;
  return realFetch(url, options);
};
geminiText = "✨ دبل خفيفة وشيك 💛\nمجوهرات السلام — ذوق يليق بيكم";
await msg(WORKER, { text: "دبل خفيفه" });
await tap(WORKER, 1);
await msg(WORKER, { photo: "n1" });
assert.equal(bot.state.pieces.at(-1).note, "دبل خفيفه");
assert.match(lastPrompt, /wrote this about the piece: "دبل خفيفه". You MUST include/);
await tap(WORKER, 1);
await msg(WORKER, { photo: "n2", caption: "عيار 21" });
assert.equal(bot.state.pieces.at(-1).note, "عيار 21");

// 9f. /postnow 2 asks first; the button posts piece 2 right away (test mode -> Telegram), the queue moves on.
env.FB_PAGE_TOKEN = "x";
const fbCount = fb.length;
await tap(WORKER, 1); await msg(WORKER, { photo: "p1" });
await tap(WORKER, 1); await msg(WORKER, { photo: "p2" });
const ids = bot.state.pieces.map((p) => p.id);
sent = [];
await msg(WORKER, { text: `/postnow ${ids.at(-1)}` });
assert.equal(fb.length, fbCount);                 // nothing yet, only the question
await bot.handleUpdate({ update_id: ++updateId, callback_query: { id: "pn", from: { id: WORKER },
  data: `postnow:${ids.at(-1)}`, message: { message_id: 1, chat: { id: WORKER } } } }).then(background);
assert.equal(fb.at(-1)[0], "photos");
assert.ok(!bot.state.pieces.some((p) => p.id === ids.at(-1)));
assert.ok(bot.state.pieces.some((p) => p.id === ids.at(-2)));
assert.ok(to(WORKER).some((t) => t.startsWith("✅ اتنشر بوست رقم")));
delete env.FB_PAGE_TOKEN;

// 9g. If the story fails, the post still counts and people are told.
env.FB_PAGE_TOKEN = "x";
const realFb = bot.fetch;
bot.fetch = async (url, options) => url.includes("photo_stories")
  ? { ok: false, status: 400, json: async () => ({}), text: async () => "no" } : realFb(url, options);
await tap(WORKER, 1); await msg(WORKER, { photo: "s9" });
sent = [];
await bot.publish(bot.state, bot.state.pieces.at(-1));
assert.ok(!to(WORKER).some((t) => t.includes("الستوري")));      // Stories are off
bot.fetch = realFb;
delete env.FB_PAGE_TOKEN;

// 9h. "New caption" button: Gemini writes a different caption for the same post.
geminiText = "✨ كلام أول 💛\nمجوهرات السلام — أ";
await tap(WORKER, 1); await msg(WORKER, { photo: "r1" });
const rw = bot.state.pieces.at(-1);
assert.equal(rw.caption, geminiText);
geminiText = "✨ كلام تاني 💛\nمجوهرات السلام — ب";
sent = [];
await bot.handleUpdate({ update_id: ++updateId, callback_query: { id: "rw", from: { id: WORKER },
  data: `rewrite:${rw.id}`, message: { message_id: 1, chat: { id: WORKER } } } }).then(background);
assert.equal(bot.state.pieces.at(-1).caption, geminiText);
assert.ok(to(WORKER).some((t) => t.startsWith("🔄 ده كلام جديد")));
// If Gemini stays down during a rewrite, the old caption is kept.
geminiText = null;
await msg(WORKER, { text: `/rewrite ${rw.id}` });
for (let i = 0; i < 6; i++) await bot.backgroundWork();
assert.equal(bot.state.pieces.at(-1).caption, "✨ كلام تاني 💛\nمجوهرات السلام — ب");
geminiText = "✨ سلسلة 💛\nمجوهرات السلام";

// 9b. /reset only empties the queue after the confirm button.
await tap(WORKER, 1);
await msg(WORKER, { photo: "z1" });
await msg(WORKER, { text: "/reset" });
assert.ok(bot.state.pieces.length > 0);
await bot.handleUpdate({ update_id: ++updateId, callback_query: {
  id: "r", from: { id: WORKER }, data: "reset:yes", message: { message_id: 1, chat: { id: WORKER } } } });
assert.equal(bot.state.pieces.length, 0);
assert.equal(bot.state.next_id, 1);

// 9. The saved queue survives a restart.
const fresh = new BotCore(storage, env, fakeFetch, () => clock);
await fresh.load();
assert.deepEqual(fresh.state.pieces, bot.state.pieces);

// 9d. Gemini busy once (429) -> it tries again and still gets a real caption.
let busyOnce = true;
const fetchBefore = bot.fetch;
bot.fetch = async (url, options) => {
  if (url.includes("generativelanguage") && busyOnce) {
    busyOnce = false;
    return { ok: false, status: 429, json: async () => ({}), text: async () => "" };
  }
  return fetchBefore(url, options);
};
geminiText = "✨ سلسلة رقيقة 💛\nمجوهرات السلام — لمعة تليق بيكي";
assert.equal(await bot.geminiCaption([JPEG], ""), geminiText);

// 9e. The logo is drawn bottom-right at 16% of the photo width; if Cloudflare Images fails, the photo is kept.
let drawn = null;
env.IMAGES = {
  info: async () => ({ width: 2000, height: 2500 }),
  input: () => ({
    transform: (o) => ({ logoWidth: o.width }),
    draw: (logo, opts) => { drawn = { ...opts, logoWidth: logo.logoWidth }; return {
      output: async () => ({ response: () => new Response(new Uint8Array([9, 9])) }) }; },
  }),
};
const logoBot = new BotCore(storage, env, fakeFetch, () => clock, new Uint8Array([1]));
assert.deepEqual([...await logoBot.addLogo(JPEG)], [9, 9]);
assert.deepEqual(drawn, { bottom: 60, right: 60, opacity: 0.95, logoWidth: 320 });
env.IMAGES = { info: async () => { throw new Error("down"); } };
assert.deepEqual(await logoBot.addLogo(JPEG), JPEG);
delete env.IMAGES;

// 10. AI captions are cleaned of links, phones and hashtags.
assert.equal(cleanCaption("✨ حلق شيك 💛\nكلمنا 01012087660\nhttps://x.com #دهب"), "✨ حلق شيك 💛");
assert.equal(cleanCaption("hello"), null);

console.log("All tests passed ✅");
