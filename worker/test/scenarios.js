// Every scenario we could think of, each on a fresh bot with a fake Telegram, Facebook, Gemini and clock.
// Nothing is sent anywhere. Run: node test/scenarios.js
// Unlike test.js, a failing scenario doesn't stop the rest: you get a full list at the end.

import assert from "node:assert/strict";
import { BotCore, CONTACT, arabicCommand, cairoTime, cleanCaption } from "../src/core.js";

const OWNER = 111, HEMA = 222, STRANGER = 999;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]);
const GOOD = "✨ حلق دهب رقيق 💛\nتفاصيل ناعمة ولمعة فخمة 😍\nمجوهرات السلام — ذوقك له بريقه";

function makeBot({ facebook = true, names = true } = {}) {
  const w = {
    sent: [], media: [], fb: [], prompts: [], assistantPrompts: [], store: new Map(), alarm: false, clock: 0, updateId: 0,
    assistant: [null],       // the assistant's answers ({reply, actions}); null = Gemini down -> text becomes a note
    gemini: [GOOD],          // answers in order; the last one repeats. null = busy (503), "BAD" = unusable text
    fbFail: false, fbFailPath: null,
  };
  const json = (data, status = 200) => ({ ok: status < 400, status, json: async () => data, text: async () => JSON.stringify(data) });
  async function fetchFn(url, options = {}) {
    if (url.includes("api.telegram.org/file/")) return { ok: true, arrayBuffer: async () => JPEG.buffer };
    if (url.includes("api.telegram.org")) {
      const method = url.split("/").pop();
      const p = options.body instanceof FormData
        ? Object.fromEntries([...options.body.entries()].map(([k, v]) => [k, k === "media" ? JSON.parse(v) : v]))
        : JSON.parse(options.body);
      if (method === "sendMessage") w.sent.push({ chat: p.chat_id, text: p.text,
        buttons: p.reply_markup?.inline_keyboard?.flat() || [], menu: p.reply_markup?.keyboard?.flat().map((b) => b.text) });
      else if (method === "getFile") return json({ ok: true, result: { file_path: "p.jpg" } });
      else w.media.push({ method, p });
      return json({ ok: true, result: {} });
    }
    if (url.includes("generativelanguage")) {
      const body = JSON.parse(options.body);
      if (body.generationConfig?.responseMimeType === "application/json") {    // the assistant
        w.assistantPrompts.push(body.contents[0].parts[0].text);
        const a = w.assistant.length > 1 ? w.assistant.shift() : w.assistant[0];
        if (a === null) return json({ error: "busy" }, 503);
        return json({ candidates: [{ content: { parts: [{ text: JSON.stringify(a) }] } }] });
      }
      w.prompts.push(body.contents[0].parts[0].text);
      const answer = w.gemini.length > 1 ? w.gemini.shift() : w.gemini[0];
      if (answer === null) return json({ error: "busy" }, 503);
      return json({ candidates: [{ content: { parts: [{ text: answer }] } }] });
    }
    if (url.includes("graph.facebook.com")) {
      if (!options.method || options.method === "GET") return json({ name: "مجوهرات السلام - Al-Salam Jewelry" });
      if (options.method === "DELETE") return json({ success: true });
      const path = url.split("/").pop();
      if (w.fbFail || w.fbFailPath === path) return json({ error: "test" }, 500);
      const fields = Object.fromEntries([...options.body.entries()].filter(([k]) => k !== "source"));
      w.fb.push({ path, fields });
      return json({ id: `id${w.fb.length}`, post_id: `post${w.fb.length}` });
    }
    throw new Error("unexpected fetch " + url);
  }
  const storage = {
    get: async (k) => structuredClone(w.store.get(k)),
    put: async (k, v) => w.store.set(k, structuredClone(v)),
    setAlarm: async () => { w.alarm = true; },
  };
  w.env = { ALLOWED_USERS: `${OWNER}, ${HEMA}`, TELEGRAM_BOT_TOKEN: "t", GEMINI_API_KEY: "g", FB_PAGE_ID: "1" };
  if (names) w.env.USER_NAMES = `${OWNER}:يوساب, ${HEMA}:هيما`;
  if (facebook) w.env.FB_PAGE_TOKEN = "x";
  w.bot = new BotCore(storage, w.env, fetchFn, () => w.clock);
  w.bot.geminiWaits = [0];
  // Set the clock to a Cairo time (handles summer time).
  w.at = (hour, minute = 0, day = 28) => {
    w.clock = Date.UTC(2026, 9, day, hour, minute);
    for (let i = 0; i < 3; i++) w.clock -= (((cairoTime(w.clock).hour - hour + 36) % 24) - 12) * 3600 * 1000;
  };
  w.at(10);
  w.background = async () => { while (w.alarm) { w.alarm = false; await w.bot.backgroundWork(); } };
  w.msg = async (user, m = {}, chatType = "private") => {
    const message = { message_id: ++w.updateId, from: { id: user }, chat: { id: user, type: chatType } };
    if (m.photo) message.photo = [{ file_id: m.photo + "-small" }, { file_id: m.photo }];
    if (m.doc) message.document = m.doc;
    for (const k of ["text", "caption"]) if (m[k] !== undefined) message[k] = m[k];
    await w.bot.handleUpdate({ update_id: w.updateId, message });
    await w.background();
  };
  w.tap = async (user, data) => {
    await w.bot.handleUpdate({ update_id: ++w.updateId, callback_query: {
      id: "q" + w.updateId, from: { id: user }, data, message: { message_id: 1, chat: { id: user } } } });
    await w.background();
  };
  w.tick = async () => { await w.bot.tick(); await w.background(); };
  w.texts = (user) => w.sent.filter((s) => s.chat === user).map((s) => s.text);
  w.has = (user, part) => w.texts(user).some((t) => t.includes(part));
  w.count = (user, part) => w.texts(user).filter((t) => t.includes(part)).length;
  w.pieces = () => w.bot.state.pieces;
  w.addPiece = async (user = HEMA, n = 1, prefix = "x" + Math.random().toString(36).slice(2, 6)) => {
    await w.tap(user, `count:${n}`);
    for (let i = 0; i < n; i++) await w.msg(user, { photo: `${prefix}${i}` });
    return w.pieces().at(-1);
  };
  return w;
}

const results = [];
async function scenario(name, fn) {
  try {
    await fn();
    results.push([true, name]);
  } catch (e) {
    results.push([false, name, e.message.split("\n").slice(0, 3).join(" ")]);
  }
}

// ---------------- Who can use the bot ----------------

await scenario("A stranger's photo, text, command and button are all refused, and he's told his number", async () => {
  const w = makeBot();
  await w.msg(STRANGER, { photo: "s" });
  await w.msg(STRANGER, { text: "hi" });
  await w.msg(STRANGER, { text: "/reset" });
  await w.tap(STRANGER, "count:2");
  await w.tap(STRANGER, "reset:yes");
  assert.equal(w.pieces().length, 0);
  assert.equal(w.bot.state.open, null);
  assert.equal(w.count(STRANGER, "رقمك هو: 999"), 3);
  assert.ok(w.has(STRANGER, "يوساب"));
});

await scenario("Messages in groups are ignored, even from Hema", async () => {
  const w = makeBot();
  await w.msg(HEMA, { photo: "g" }, "group");
  assert.equal(w.sent.length, 0);
  assert.equal(w.bot.state?.open ?? null, null);
});

await scenario("ALLOWED_USERS works with spaces, commas or new lines", async () => {
  const w = makeBot();
  w.env.ALLOWED_USERS = ` ${OWNER}\n${HEMA} ,`;
  await w.addPiece(HEMA);
  assert.equal(w.pieces().length, 1);
});

await scenario("Updates that aren't messages or buttons (edited messages) are ignored", async () => {
  const w = makeBot();
  await w.bot.handleUpdate({ update_id: 1, edited_message: { text: "x" } });
  assert.equal(w.sent.length, 0);
});

// ---------------- The "how many photos?" flow ----------------

await scenario("/start shows the help and the 1–5 buttons", async () => {
  const w = makeBot();
  await w.msg(HEMA, { text: "/start" });
  const ask = w.sent.find((s) => s.text.includes("كام صورة للبوست الجاي"));
  assert.ok(w.has(HEMA, "اكتبها عادي بالعربي"));
  assert.deepEqual(ask.buttons.map((b) => b.text), ["1", "2", "3", "4", "5"]);
});

await scenario("Tap 2, send 2 photos → one post with both, cheer with his name, then it asks again", async () => {
  const w = makeBot();
  const piece = await w.addPiece(HEMA, 2, "a");
  assert.deepEqual(piece.photos, ["a0", "a1"]);
  assert.equal(piece.caption, GOOD);
  assert.ok(w.has(HEMA, "الله ينور يا هيما"));
  assert.ok(w.has(HEMA, "✅ بوست رقم 1 جاهز (2 صورة)"));
  assert.ok(w.texts(HEMA).at(-1).includes("كام صورة للبوست الجاي"));
});

await scenario("No 'ready' message until the last photo arrives", async () => {
  const w = makeBot();
  await w.tap(HEMA, "count:3");
  await w.msg(HEMA, { photo: "p1" });
  await w.msg(HEMA, { photo: "p2" });
  assert.equal(w.pieces().length, 0);
  assert.ok(!w.has(HEMA, "جاهز"));
  await w.msg(HEMA, { photo: "p3" });
  assert.equal(w.pieces()[0].photos.length, 3);
});

await scenario("Photos before choosing: asks once for a 3-photo album, then tapping 3 finishes it", async () => {
  const w = makeBot();
  for (const p of ["b1", "b2", "b3"]) await w.msg(HEMA, { photo: p });
  assert.equal(w.count(HEMA, "البوست ده كام صورة"), 1);
  await w.tap(HEMA, "count:3");
  assert.deepEqual(w.pieces()[0].photos, ["b1", "b2", "b3"]);
});

await scenario("Tapping a number when some photos already came says how many are left", async () => {
  const w = makeBot();
  await w.msg(HEMA, { photo: "c1" });
  await w.tap(HEMA, "count:3");
  assert.ok(w.has(HEMA, "فاضل 2 صورة"));
});

await scenario("More photos than chosen: the extra one starts the next post and the bot asks about it", async () => {
  const w = makeBot();
  await w.tap(HEMA, "count:1");
  await w.msg(HEMA, { photo: "d1" });
  await w.msg(HEMA, { photo: "d2" });
  assert.deepEqual(w.pieces().map((p) => p.photos), [["d1"]]);
  assert.deepEqual(w.bot.state.open.photos, ["d2"]);
  assert.ok(w.has(HEMA, "البوست ده كام صورة"));
});

await scenario("Choosing a smaller number after sending more photos splits them correctly", async () => {
  const w = makeBot();
  for (const p of ["e1", "e2", "e3"]) await w.msg(HEMA, { photo: p });
  await w.tap(HEMA, "count:2");
  assert.deepEqual(w.pieces()[0].photos, ["e1", "e2"]);
  assert.deepEqual(w.bot.state.open.photos, ["e3"]);
});

await scenario("Changing the number in the middle (2 → 3) waits for the 3rd photo", async () => {
  const w = makeBot();
  await w.tap(HEMA, "count:2");
  await w.msg(HEMA, { photo: "f1" });
  await w.tap(HEMA, "count:3");
  await w.msg(HEMA, { photo: "f2" });
  assert.equal(w.pieces().length, 0);
  await w.msg(HEMA, { photo: "f3" });
  assert.equal(w.pieces()[0].photos.length, 3);
});

await scenario("/cancel drops the half-sent post and asks again", async () => {
  const w = makeBot();
  await w.tap(HEMA, "count:3");
  await w.msg(HEMA, { photo: "g1" });
  await w.msg(HEMA, { text: "/cancel" });
  assert.equal(w.bot.state.open, null);
  assert.equal(w.pieces().length, 0);
  assert.ok(w.texts(HEMA).at(-1).includes("كام صورة"));
});

await scenario("Telegram sends the same photo twice (retry) → counted once", async () => {
  const w = makeBot();
  await w.tap(HEMA, "count:2");
  await w.msg(HEMA, { photo: "h1" });
  await w.msg(HEMA, { photo: "h1" });
  assert.equal(w.pieces().length, 0);
  assert.deepEqual(w.bot.state.open.photos, ["h1"]);
});

await scenario("A photo sent as a file (HD original) is accepted; a PDF is not", async () => {
  const w = makeBot();
  await w.tap(HEMA, "count:1");
  await w.msg(HEMA, { doc: { file_id: "pdf", mime_type: "application/pdf" } });
  assert.equal(w.pieces().length, 0);
  await w.msg(HEMA, { doc: { file_id: "file1", mime_type: "image/jpeg" } });
  assert.deepEqual(w.pieces()[0].photos, ["file1"]);
});

await scenario("Two people send at the same time: their photos don't mix into one finished post", async () => {
  const w = makeBot();
  await w.tap(HEMA, "count:1");
  await w.msg(HEMA, { photo: "hema1" });
  await w.tap(OWNER, "count:1");
  await w.msg(OWNER, { photo: "owner1" });
  assert.deepEqual(w.pieces().map((p) => p.photos), [["hema1"], ["owner1"]]);
});

await scenario("Photos arriving at the exact same moment (album) still make one post", async () => {
  const w = makeBot();
  await w.tap(HEMA, "count:3");
  const send = (p) => w.bot.handleUpdate({ update_id: ++w.updateId, message: {
    message_id: w.updateId, from: { id: HEMA }, chat: { id: HEMA, type: "private" }, photo: [{ file_id: p }] } });
  await Promise.all([send("al1"), send("al2"), send("al3")]);
  await w.background();
  assert.equal(w.pieces().length, 1);
  assert.equal(w.pieces()[0].photos.length, 3);
});

// ---------------- Notes from the worker ----------------

await scenario("Text under the photo goes to Gemini as a must-use note", async () => {
  const w = makeBot();
  await w.tap(HEMA, "count:1");
  await w.msg(HEMA, { photo: "n1", caption: "دبل خفيفه" });
  assert.equal(w.pieces()[0].note, "دبل خفيفه");
  assert.match(w.prompts.at(-1), /wrote this about the piece: "دبل خفيفه"\. You MUST include/);
});

await scenario("A text message before the photos is used for that post, and he's told so", async () => {
  const w = makeBot();
  await w.msg(HEMA, { text: "عيار 21" });
  assert.ok(w.has(HEMA, 'هضيف "عيار 21"'));
  await w.tap(HEMA, "count:1");
  await w.msg(HEMA, { photo: "n2" });
  assert.equal(w.pieces()[0].note, "عيار 21");
});

await scenario("Two notes are joined; the same note twice is kept once", async () => {
  const w = makeBot();
  await w.msg(HEMA, { text: "خاتم" });
  await w.msg(HEMA, { text: "خاتم" });
  await w.msg(HEMA, { text: "وزن 3 جرام" });
  await w.tap(HEMA, "count:1");
  await w.msg(HEMA, { photo: "n3" });
  assert.equal(w.pieces()[0].note, "خاتم – وزن 3 جرام");
});

await scenario("A very long note is cut to 300 letters; spaces-only text is ignored", async () => {
  const w = makeBot();
  await w.msg(HEMA, { text: "   " });
  assert.equal(w.bot.state.open, null);
  await w.msg(HEMA, { text: "ا".repeat(500) });
  assert.equal(w.bot.state.open.note.length, 300);
});

await scenario("The note of one post doesn't leak into the next post", async () => {
  const w = makeBot();
  await w.tap(HEMA, "count:1");
  await w.msg(HEMA, { photo: "q1", caption: "سلسلة" });
  await w.addPiece(HEMA, 1, "q2");
  assert.equal(w.pieces()[1].note, "");
});

// ---------------- Gemini ----------------

await scenario("Gemini busy once → tries the next model and still gets a real caption", async () => {
  const w = makeBot();
  w.gemini = [null, GOOD];
  const piece = await w.addPiece();
  assert.equal(piece.caption, GOOD);
});

await scenario("Gemini down for a while → 'busy' said once, retried later, then a ready-made caption", async () => {
  const w = makeBot();
  w.gemini = [null];
  await w.tap(HEMA, "count:1");
  await w.msg(HEMA, { photo: "z" });
  // background() keeps running the retries the alarm would do every 3 minutes
  assert.ok(w.pieces()[0].caption);
  assert.notEqual(w.pieces()[0].caption, GOOD);
  assert.equal(w.count(HEMA, "Gemini مشغول"), 1);
  assert.equal(w.count(HEMA, "جاهز"), 1);
});

await scenario("Gemini comes back on the 2nd retry → real caption, not ready-made", async () => {
  const w = makeBot();
  const models = 5;
  w.gemini = [...Array(models).fill(null), GOOD];
  const piece = await w.addPiece();
  assert.equal(piece.caption, GOOD);
});

await scenario("Gemini's links, hashtags and phone numbers are removed", async () => {
  const w = makeBot();
  w.gemini = ["✨ خاتم شيك 💛\nكلمنا 01012087660\nhttps://x.com #دهب\nمجوهرات السلام"];
  const piece = await w.addPiece();
  assert.equal(piece.caption, "✨ خاتم شيك 💛\nمجوهرات السلام");
});

await scenario("Gemini answers in English or with nothing → next model is used", async () => {
  const w = makeBot();
  w.gemini = ["Sorry, I can't help", "", GOOD];
  const piece = await w.addPiece();
  assert.equal(piece.caption, GOOD);
});

await scenario("Gemini is told the last captions so it doesn't repeat them", async () => {
  const w = makeBot();
  await w.addPiece();
  await w.addPiece();
  assert.ok(w.prompts.at(-1).includes(GOOD));
});

await scenario("The prompt includes the page's real captions and the piece types", async () => {
  const w = makeBot();
  await w.addPiece();
  assert.ok(w.prompts[0].includes("مش مجرد حلق دهب"));
  assert.ok(w.prompts[0].includes("غويشة"));
  assert.ok(w.prompts[0].includes("Never write a price"));
});

await scenario("cleanCaption keeps good Arabic captions and rejects junk", async () => {
  assert.equal(cleanCaption(GOOD), GOOD);
  assert.equal(cleanCaption("ok"), null);
  assert.equal(cleanCaption("```\n✨ سلسلة رقيقة جدا\n```"), "✨ سلسلة رقيقة جدا");
});

// ---------------- Commands ----------------

await scenario("/list with nothing, then with posts in the right order and times", async () => {
  const w = makeBot();
  await w.msg(HEMA, { text: "/list" });
  assert.ok(w.has(HEMA, "مفيش بوستات مستنية"));
  await w.addPiece(); await w.addPiece(); await w.addPiece();
  w.sent = [];
  await w.msg(HEMA, { text: "/list" });
  const list = w.texts(HEMA)[0];
  assert.ok(list.indexOf("رقم 1") < list.indexOf("رقم 2"));
  assert.match(list, /رقم 1 – 1 صورة – النهارده الساعة 3 مساءً/);
  assert.match(list, /رقم 2 – 1 صورة – النهارده الساعة 10 مساءً/);
  assert.match(list, /رقم 3 – 1 صورة – بكرة الساعة 3 مساءً/);
});

await scenario("After 10 PM's post time has passed, new posts are scheduled for tomorrow", async () => {
  const w = makeBot();
  w.at(22); await w.tick();          // 10 PM check ran with nothing to post
  w.at(23, 59);
  await w.addPiece();
  assert.ok(w.has(HEMA, "بكرة الساعة 3 مساءً"));
});

await scenario("Schedule more than 2 days ahead shows the day name and date", async () => {
  const w = makeBot();
  for (let i = 0; i < 5; i++) await w.addPiece();
  w.sent = [];
  await w.msg(HEMA, { text: "/list" });
  assert.match(w.texts(HEMA)[0], /رقم 5 – 1 صورة – \S+ 30 أكتوبر الساعة 3 مساءً/);
});

await scenario("/delete: wrong number, then a real one", async () => {
  const w = makeBot();
  await w.addPiece();
  await w.msg(HEMA, { text: "/delete 9" });
  await w.msg(HEMA, { text: "/delete abc" });
  assert.equal(w.pieces().length, 1);
  await w.msg(HEMA, { text: "/delete 1" });
  assert.equal(w.pieces().length, 0);
  assert.ok(w.has(HEMA, "اتمسح بوست رقم 1"));
});

await scenario("/caption: changes the text; missing text or number is refused; very long text is cut", async () => {
  const w = makeBot();
  await w.addPiece();
  await w.msg(HEMA, { text: "/caption 1" });
  await w.msg(HEMA, { text: "/caption" });
  assert.equal(w.pieces()[0].caption, GOOD);
  await w.msg(HEMA, { text: "/caption 1 كلام جديد خالص" });
  assert.equal(w.pieces()[0].caption, "كلام جديد خالص");
  await w.msg(HEMA, { text: "/caption 1 " + "ب".repeat(3000) });
  assert.equal(w.pieces()[0].caption.length, 1500);
});

await scenario("/rewrite and the 🔄 button give a new caption; if Gemini is down the old one stays", async () => {
  const w = makeBot();
  await w.addPiece();
  w.gemini = ["✨ كلام تاني جميل 💛\nمجوهرات السلام"];
  await w.tap(HEMA, "rewrite:1");
  assert.equal(w.pieces()[0].caption, "✨ كلام تاني جميل 💛\nمجوهرات السلام");
  assert.ok(w.has(HEMA, "🔄 ده كلام جديد"));
  w.gemini = [null];
  await w.msg(HEMA, { text: "/rewrite 1" });
  assert.equal(w.pieces()[0].caption, "✨ كلام تاني جميل 💛\nمجوهرات السلام");
  await w.msg(HEMA, { text: "/rewrite 7" });
  assert.ok(w.has(HEMA, "مفيش بوست رقم 7"));
});

await scenario("After a 🔄/🪄 rewrite the whole post is shown again (photos + new caption)", async () => {
  const w = makeBot();
  await w.addPiece();
  w.media = [];
  await w.tap(HEMA, "rewrite:1");
  assert.ok(w.media.some((m) => m.method === "sendPhoto" && m.p.caption.startsWith(GOOD)));
});

await scenario("/preview: empty, then the first post with photos and full caption (logo + contact)", async () => {
  const w = makeBot();
  await w.msg(HEMA, { text: "/preview" });
  assert.ok(w.has(HEMA, "مفيش بوستات"));
  await w.addPiece(HEMA, 2);
  await w.msg(HEMA, { text: "/preview" });
  const group = w.media.find((m) => m.method === "sendMediaGroup");
  assert.ok(group.p.media[0].caption.endsWith(CONTACT));
  assert.equal(w.pieces().length, 1);          // preview doesn't use it up
});

await scenario("/preview of a post whose caption isn't written yet → writes it first", async () => {
  const w = makeBot();
  w.gemini = [null];
  await w.tap(HEMA, "count:1");
  w.bot.storage.setAlarm = async () => {};      // keep it caption-less for this test
  await w.msg(HEMA, { photo: "pv" });
  assert.equal(w.pieces()[0].caption, null);
  await w.msg(HEMA, { text: "/preview" });
  assert.ok(w.has(HEMA, "بكتب كلام البوست ده"));
});

await scenario("/postnow: asks first, posts on the button, the queue moves on; wrong numbers are refused", async () => {
  const w = makeBot();
  await w.msg(HEMA, { text: "/postnow" });
  assert.ok(w.has(HEMA, "مفيش بوستات مستنية"));
  await w.addPiece(); await w.addPiece();
  await w.msg(HEMA, { text: "/postnow 9" });
  assert.ok(w.has(HEMA, "مفيش بوست بالرقم ده"));
  await w.msg(HEMA, { text: "/postnow 2" });
  assert.equal(w.fb.length, 0);
  await w.tap(HEMA, "postnow:2");
  assert.equal(w.fb.length, 1);
  assert.deepEqual(w.pieces().map((p) => p.id), [1]);
  assert.ok(w.has(OWNER, "✅ اتنشر بوست رقم 2"));     // the owner is told too
});

await scenario("Pressing the post-now button twice posts only once", async () => {
  const w = makeBot();
  await w.addPiece();
  await w.tap(HEMA, "postnow:1");
  await w.tap(HEMA, "postnow:1");
  assert.equal(w.fb.filter((f) => f.path === "photos").length, 1);
  assert.ok(w.has(HEMA, "مفيش بوست رقم 1"));
});

await scenario("/postnow doesn't take away the 3 PM post", async () => {
  const w = makeBot();
  await w.addPiece(); await w.addPiece();
  await w.tap(HEMA, "postnow:1");
  w.at(15, 5); await w.tick();
  assert.equal(w.fb.filter((f) => f.path === "photos" && f.fields.caption).length, 2);
});

await scenario("/reset asks first; only the button empties the queue; numbering starts again at 1", async () => {
  const w = makeBot();
  await w.addPiece(); await w.addPiece();
  await w.msg(OWNER, { text: "/reset" });
  assert.equal(w.pieces().length, 2);
  await w.tap(OWNER, "reset:yes");
  assert.equal(w.pieces().length, 0);
  const p = await w.addPiece();
  assert.equal(p.id, 1);
});

await scenario("Unknown command → help; bad button data → nothing happens", async () => {
  const w = makeBot();
  await w.msg(HEMA, { text: "/blabla" });
  assert.ok(w.has(HEMA, "مش فاهم ده"));
  await w.tap(HEMA, "count:99");
  await w.tap(HEMA, "count:abc");
  await w.tap(HEMA, "");
  assert.equal(w.bot.state.open, null);
});

await scenario("Commands work with the bot's name after them (/list@Bot) and in capitals", async () => {
  const w = makeBot();
  await w.msg(HEMA, { text: "/LIST@ElsalamPiecesBot" });
  assert.ok(w.has(HEMA, "مفيش بوستات مستنية"));
});

// ---------------- Arabic buttons and words ----------------

await scenario("The Arabic buttons are sent once to each person, at the bottom of the chat", async () => {
  const w = makeBot();
  await w.msg(HEMA, { text: "دبل" });
  await w.msg(HEMA, { text: "خفيفه" });
  const menus = w.sent.filter((s) => s.chat === HEMA && s.menu);
  assert.equal(menus.length, 1);
  assert.deepEqual(menus[0].menu, ["📋 البوستات", "👀 البوست الجاي", "❓ مساعدة"]);
});

await scenario("Arabic words become commands; notes like 'دبل خفيفه' stay notes", async () => {
  const cases = {
    "📋 البوستات": "/list", "👀 البوست الجاي": "/preview", "🚀 انشر دلوقتي": "/postnow", "❌ الغي الصور": "/cancel",
    "❓ مساعدة": "/help", "انشر ٣": "/postnow 3", "امسح 2": "/delete 2", "امسح البوست رقم 4": "/delete 4",
    "كلام جديد 1": "/rewrite 1", "كلام تاني": "/rewrite", "شوف 3": "/preview 3", "امسح الكل": "/reset",
    "إلغاء": "/cancel", "مساعدة": "/help", "البوستات اللي مستنية": "/list",
    "دبل خفيفه": null, "حلق عيار 21": null, "امسح": null, "وزن 3 جرام": null, "انشر بكرة": null,
  };
  for (const [text, expected] of Object.entries(cases)) assert.equal(arabicCommand(text), expected, text);
});

await scenario("📋 البوستات: one 👀 button per post; it shows the post with ⬆️ 🚀 🪄 🗑 options", async () => {
  const w = makeBot();
  await w.addPiece(); await w.addPiece();
  await w.msg(HEMA, { text: "📋 البوستات" });
  const list = w.sent.find((s) => s.text.startsWith("🗂"));
  assert.deepEqual(list.buttons.map((b) => b.callback_data), ["preview:1", "preview:2"]);
  await w.tap(HEMA, "preview:2");
  const options = w.sent.find((s) => s.text.includes("تحب تعمل إيه"));
  assert.deepEqual(options.buttons.map((b) => b.callback_data), ["first:2", "postask:2", "guide:2", "delete:2"]);
});

await scenario("✏️ then sending text replaces the caption (and isn't taken as a note)", async () => {
  const w = makeBot();
  await w.addPiece();
  await w.tap(HEMA, "edit:1");
  assert.ok(w.has(HEMA, "ابعت الكلام الجديد لبوست رقم 1"));
  await w.msg(HEMA, { text: "خاتم دهب جديد ✨" });
  assert.equal(w.pieces()[0].caption, "خاتم دهب جديد ✨");
  assert.equal(w.bot.state.open, null);
  assert.equal(w.bot.state.editing, null);
});

await scenario("✏️ then ❌ الغي keeps the old caption", async () => {
  const w = makeBot();
  await w.addPiece();
  await w.tap(HEMA, "edit:1");
  await w.msg(HEMA, { text: "❌ الغي الصور" });
  assert.equal(w.pieces()[0].caption, GOOD);
  assert.equal(w.bot.state.editing, null);
});

await scenario("While Hema edits, the owner's text is still a note (editing belongs to one person)", async () => {
  const w = makeBot();
  await w.addPiece();
  await w.tap(HEMA, "edit:1");
  await w.msg(OWNER, { text: "عيار 18" });
  assert.equal(w.pieces()[0].caption, GOOD);
  assert.equal(w.bot.state.open.note, "عيار 18");
});

await scenario("🗑 asks first; 'أيوه امسحه' deletes; pressing it again says it's gone", async () => {
  const w = makeBot();
  await w.addPiece();
  await w.tap(HEMA, "delete:1");
  assert.equal(w.pieces().length, 1);
  await w.tap(HEMA, "delyes:1");
  assert.equal(w.pieces().length, 0);
  await w.tap(HEMA, "delyes:1");
  assert.ok(w.has(HEMA, "مفيش بوست رقم 1"));
});

await scenario("🚀 under a post asks, then the confirm button posts that post", async () => {
  const w = makeBot();
  await w.addPiece(); await w.addPiece();
  await w.tap(HEMA, "postask:2");
  assert.ok(w.has(HEMA, "تنشر بوست رقم 2"));
  assert.equal(w.fb.length, 0);
  await w.tap(HEMA, "postnow:2");
  assert.deepEqual(w.pieces().map((p) => p.id), [1]);
});

await scenario("Typed Arabic works end to end: 'انشر 1', 'امسح 2', 'شوف 3', 'كلام جديد 3'", async () => {
  const w = makeBot();
  await w.addPiece(); await w.addPiece(); await w.addPiece();
  await w.msg(HEMA, { text: "انشر 1" });
  assert.ok(w.has(HEMA, "تنشر بوست رقم 1"));
  await w.msg(HEMA, { text: "امسح 2" });
  assert.deepEqual(w.pieces().map((p) => p.id), [1, 3]);
  await w.msg(HEMA, { text: "شوف 3" });
  assert.ok(w.media.some((m) => m.method === "sendPhoto"));
  w.gemini = ["✨ كلام مختلف خالص 💛\nمجوهرات السلام"];
  await w.msg(HEMA, { text: "كلام جديد 3" });
  assert.equal(w.pieces()[1].caption, "✨ كلام مختلف خالص 💛\nمجوهرات السلام");
});

await scenario("The ready message is simple: the caption, one 👀 button, and 'just write it'", async () => {
  const w = makeBot();
  await w.addPiece();
  const ready = w.sent.find((s) => s.text.includes("جاهز"));
  assert.deepEqual(ready.buttons.map((b) => b.callback_data), ["preview:1"]);
  assert.ok(ready.text.includes("اكتبها عادي"));
});

await scenario("No message to the worker mentions a / command anymore", async () => {
  const w = makeBot();
  await w.msg(HEMA, { text: "/start" });
  await w.addPiece();
  await w.msg(HEMA, { text: "📋 البوستات" });
  await w.msg(HEMA, { text: "امسح 9" });
  await w.msg(HEMA, { text: "/caption" });
  await w.msg(HEMA, { text: "شوف 9" });
  for (const t of w.texts(HEMA)) assert.ok(!/\/(list|preview|caption|delete|rewrite|postnow|help)/.test(t), t);
});

await scenario("🪄 then a note: Gemini gets the current caption + the change, and the new caption replaces it", async () => {
  const w = makeBot();
  await w.addPiece();
  await w.tap(HEMA, "guide:1");
  assert.ok(w.has(HEMA, "قول لـ Gemini يغير إيه"));
  w.gemini = ["✨ هدية تفرّح أي حد 🎁\nمجوهرات السلام"];
  await w.msg(HEMA, { text: "اذكر إنه هدية" });
  const prompt = w.prompts.at(-1);
  assert.ok(prompt.includes("EDIT REQUEST") && prompt.includes(GOOD) && prompt.includes("اذكر إنه هدية"));
  assert.equal(w.pieces()[0].caption, "✨ هدية تفرّح أي حد 🎁\nمجوهرات السلام");
  assert.ok(w.has(HEMA, "🪄 عدلته زي ما قلت"));
  assert.equal(w.bot.state.open, null);           // the note wasn't taken as a piece note
});

await scenario("🪄 with Gemini down keeps the old caption", async () => {
  const w = makeBot();
  await w.addPiece();
  w.gemini = [null];
  await w.tap(HEMA, "guide:1");
  await w.msg(HEMA, { text: "خليه أقصر" });
  assert.equal(w.pieces()[0].caption, GOOD);
});

await scenario("Typing 'عدل 1' opens the same 🪄 flow; ❌ cancels it", async () => {
  const w = makeBot();
  await w.addPiece();
  await w.msg(HEMA, { text: "عدل 1" });
  assert.ok(w.has(HEMA, "قول لـ Gemini يغير إيه"));
  await w.msg(HEMA, { text: "❌ الغي الصور" });
  assert.equal(w.bot.state.guiding, null);
  assert.equal(w.pieces()[0].caption, GOOD);
});

await scenario("An edit note may ask for a price/karat (allowed), and recent captions aren't blocked", async () => {
  const w = makeBot();
  await w.addPiece();
  await w.tap(HEMA, "guide:1");
  await w.msg(HEMA, { text: "اكتب إنه عيار 21" });
  const prompt = w.prompts.at(-1);
  assert.ok(prompt.includes("Follow the request even if it asks to mention a price, weight, karat"));
  assert.ok(prompt.includes("don't repeat these recent captions:\n(none)"));
});

// ---------------- The assistant (Gemini understands what they write) ----------------

await scenario("Assistant: 'خلي بوست الخاتم يتنشر الجاي' moves it first and shows the new order", async () => {
  const w = makeBot();
  await w.addPiece(); await w.addPiece(); await w.addPiece();
  w.assistant = [{ reply: "تمام، هخلي بوست الخاتم هو الجاي 👍", actions: [{ type: "move", post: 3, position: 1 }] }];
  await w.msg(HEMA, { text: "خلي بوست الخاتم يتنشر الجاي" });
  assert.deepEqual(w.pieces().map((p) => p.id), [3, 1, 2]);
  assert.ok(w.has(HEMA, "هخلي بوست الخاتم"));
  const order = w.texts(HEMA).find((t) => t.startsWith("🗓 تمام، ده الترتيب الجديد"));
  assert.match(order, /1\. بوست 3 – النهارده الساعة 3 مساءً/);
});

await scenario("Assistant: 'بكرة الساعة 10' → position 4; the prompt lists posting times and posts", async () => {
  const w = makeBot();
  for (let i = 0; i < 4; i++) await w.addPiece();
  w.assistant = [{ reply: "تمام", actions: [{ type: "move", post: 1, position: 4 }] }];
  await w.msg(HEMA, { text: "خلي بوست 1 يتنشر بكرة الساعة 10" });
  assert.deepEqual(w.pieces().map((p) => p.id), [2, 3, 4, 1]);
  const prompt = w.assistantPrompts.at(-1);
  assert.ok(prompt.includes("4: بكرة الساعة 10 مساءً"));
  assert.ok(prompt.includes("1. بوست 1 – 1 صورة"));
  assert.ok(prompt.includes("«خلي بوست 1 يتنشر بكرة الساعة 10»"));
});

await scenario("Assistant: 'انشر بوست الحلق دلوقتي' only asks to confirm; nothing is posted yet", async () => {
  const w = makeBot();
  await w.addPiece(); await w.addPiece();
  w.assistant = [{ reply: "حاضر", actions: [{ type: "post_now", post: 2 }] }];
  await w.msg(HEMA, { text: "انشر بوست الحلق دلوقتي" });
  assert.ok(w.has(HEMA, "تنشر بوست رقم 2"));
  assert.equal(w.fb.length, 0);
  assert.equal(w.pieces().length, 2);
});

await scenario("Assistant: 'امسح بوست الحلق' only asks to confirm; nothing is deleted yet", async () => {
  const w = makeBot();
  await w.addPiece();
  w.assistant = [{ reply: "", actions: [{ type: "delete", post: 1 }] }];
  await w.msg(HEMA, { text: "امسح بوست الحلق" });
  assert.ok(w.has(HEMA, "تمسح بوست رقم 1"));
  assert.equal(w.pieces().length, 1);
});

await scenario("Assistant: 'غير كلام البوست الجاي وخليه أقصر' → Gemini edits it and the post is shown", async () => {
  const w = makeBot();
  await w.addPiece();
  w.assistant = [{ reply: "حاضر، هخليه أقصر", actions: [{ type: "rewrite", post: 1, text: "خليه أقصر" }] }];
  w.gemini = ["✨ حلق رقيق 💛\nمجوهرات السلام"];
  w.media = [];
  await w.msg(HEMA, { text: "غير كلام البوست الجاي وخليه أقصر" });
  assert.equal(w.pieces()[0].caption, "✨ حلق رقيق 💛\nمجوهرات السلام");
  assert.ok(w.prompts.at(-1).includes("خليه أقصر"));
  assert.ok(w.media.some((m) => m.method === "sendPhoto"));
});

await scenario("Assistant: 'دبل خفيفه' is understood as a note for the photos being sent", async () => {
  const w = makeBot();
  w.assistant = [{ reply: "تمام، هكتب إنها دبل خفيفة ✍️", actions: [{ type: "note", text: "دبل خفيفه" }] }];
  await w.msg(HEMA, { text: "دبل خفيفه" });
  await w.tap(HEMA, "count:1");
  await w.msg(HEMA, { photo: "nn" });
  assert.equal(w.pieces()[0].note, "دبل خفيفه");
});

await scenario("Assistant: questions get an answer and nothing changes", async () => {
  const w = makeBot();
  await w.addPiece();
  w.assistant = [{ reply: "فاضل بوست واحد بس، هيتنشر النهارده الساعة 3", actions: [{ type: "none" }] }];
  await w.msg(OWNER, { text: "كام بوست فاضل؟" });
  assert.ok(w.has(OWNER, "فاضل بوست واحد"));
  assert.equal(w.pieces().length, 1);
  assert.equal(w.bot.state.open, null);
});

await scenario("Assistant: a post number that doesn't exist is reported, nothing breaks", async () => {
  const w = makeBot();
  await w.addPiece();
  w.assistant = [{ reply: "", actions: [{ type: "move", post: 9, position: 1 }, { type: "preview" }] }];
  await w.msg(HEMA, { text: "خلي بوست 9 الأول" });
  assert.ok(w.has(HEMA, "مش لاقي بوست رقم 9"));
  assert.ok(w.has(HEMA, "مش متأكد قصدك أنهي بوست"));
  assert.deepEqual(w.pieces().map((p) => p.id), [1]);
});

await scenario("Assistant: set_caption replaces the caption and shows the post", async () => {
  const w = makeBot();
  await w.addPiece();
  w.assistant = [{ reply: "", actions: [{ type: "set_caption", post: 1, text: "سلسلة دهب رقيقة ✨" }] }];
  w.media = [];
  await w.msg(HEMA, { text: "خلي كلام بوست 1: سلسلة دهب رقيقة ✨" });
  assert.equal(w.pieces()[0].caption, "سلسلة دهب رقيقة ✨");
  assert.ok(w.media.length > 0);
});

await scenario("Assistant: a position way too big or 0 is kept inside the list", async () => {
  const w = makeBot();
  await w.addPiece(); await w.addPiece();
  w.assistant = [{ reply: "", actions: [{ type: "move", post: 1, position: 99 }] }];
  await w.msg(HEMA, { text: "خلي بوست 1 الآخر" });
  assert.deepEqual(w.pieces().map((p) => p.id), [2, 1]);
  w.assistant = [{ reply: "", actions: [{ type: "move", post: 1, position: 0 }] }];
  await w.msg(HEMA, { text: "خلي بوست 1 الأول" });
  assert.deepEqual(w.pieces().map((p) => p.id), [1, 2]);
});

await scenario("Assistant: never deletes everything without the confirm button", async () => {
  const w = makeBot();
  await w.addPiece(); await w.addPiece();
  w.assistant = [{ reply: "", actions: [{ type: "reset" }, { type: "delete", post: 1 }, { type: "delete", post: 2 }] }];
  await w.msg(HEMA, { text: "امسح كل حاجة" });
  assert.equal(w.pieces().length, 2);
  assert.ok(w.has(HEMA, "متأكد إنك عايز تمسح كل البوستات"));
});

await scenario("Assistant down (Gemini busy) → the text is kept as a note, like before", async () => {
  const w = makeBot();
  w.assistant = [null];
  await w.msg(HEMA, { text: "حلق خفيف" });
  assert.ok(w.has(HEMA, 'هضيف "حلق خفيف"'));
  assert.equal(w.bot.state.open.note, "حلق خفيف");
});

await scenario("Assistant answer that isn't valid JSON → treated as a note", async () => {
  const w = makeBot();
  w.assistant = ["not json"];
  await w.msg(HEMA, { text: "خاتم" });
  assert.equal(w.bot.state.open.note, "خاتم");
});

await scenario("Assistant: a swap ('بوست 2 الساعة 3 والأول بالليل') works whatever order the moves come in", async () => {
  for (const actions of [
    [{ type: "move", post: 2, position: 1 }, { type: "move", post: 1, position: 2 }],
    [{ type: "move", post: 1, position: 2 }, { type: "move", post: 2, position: 1 }],
  ]) {
    const w = makeBot();
    await w.addPiece(); await w.addPiece(); await w.addPiece();
    w.assistant = [{ reply: "تمام", actions }];
    await w.msg(HEMA, { text: "خلي بوست 2 يتنشر الساعة 3 والأول بالليل" });
    assert.deepEqual(w.pieces().map((p) => p.id), [2, 1, 3]);
  }
});

await scenario("Assistant: moving 3 posts at once to new places", async () => {
  const w = makeBot();
  for (let i = 0; i < 5; i++) await w.addPiece();
  w.assistant = [{ reply: "", actions: [{ type: "move", post: 5, position: 1 }, { type: "move", post: 4, position: 2 },
    { type: "move", post: 1, position: 5 }] }];
  await w.msg(HEMA, { text: "رتبهم" });
  assert.deepEqual(w.pieces().map((p) => p.id), [5, 4, 2, 3, 1]);
});

await scenario("⬆️ خليه الجاي under a post moves it first and shows the order", async () => {
  const w = makeBot();
  await w.addPiece(); await w.addPiece(); await w.addPiece();
  await w.tap(HEMA, "first:3");
  assert.deepEqual(w.pieces().map((p) => p.id), [3, 1, 2]);
  assert.ok(w.has(HEMA, "بوست رقم 3 هو اللي هيتنشر الجاي"));
});

await scenario("After moving, the 3 PM post is the moved one", async () => {
  const w = makeBot();
  await w.addPiece(HEMA, 1, "first"); await w.addPiece(HEMA, 1, "second");
  await w.tap(HEMA, "first:2");
  w.at(15); await w.tick();
  assert.ok(w.fb[0].fields.caption);
  assert.deepEqual(w.pieces().map((p) => p.id), [1]);
});

await scenario("'اختبر الفيسبوك': hidden photo uploaded then deleted, page name shown; nothing in the queue changes", async () => {
  const w = makeBot();
  await w.addPiece();
  await w.msg(OWNER, { text: "اختبر الفيسبوك" });
  assert.ok(w.has(OWNER, "✅ الفيسبوك شغال"));
  assert.equal(w.fb.at(-1).fields.published, "false");
  assert.equal(w.pieces().length, 1);
  const w2 = makeBot({ facebook: false });
  await w2.msg(OWNER, { text: "اختبر الفيسبوك" });
  assert.ok(w2.has(OWNER, "لسه مفيش مفتاح فيسبوك"));
});

// ---------------- Posting on time ----------------

await scenario("3 PM: posts the first post; 3:05 again does nothing; 10 PM posts the next", async () => {
  const w = makeBot();
  await w.addPiece(HEMA, 2); await w.addPiece();
  w.at(15, 0); await w.tick();
  w.at(15, 5); await w.tick();
  assert.deepEqual(w.fb.map((f) => f.path), ["photos", "photos", "feed"]);
  w.at(22, 0); await w.tick();
  assert.equal(w.fb.at(-1).path, "photos");
  assert.equal(w.pieces().length, 0);
});

await scenario("Before 3 PM nothing is posted", async () => {
  const w = makeBot();
  await w.addPiece();
  w.at(14, 55); await w.tick();
  assert.equal(w.fb.length, 0);
});

await scenario("If Cloudflare was late, it still posts until 4:59 PM, but not at 5 PM", async () => {
  const w = makeBot();
  await w.addPiece();
  w.at(16, 59); await w.tick();
  assert.equal(w.fb.length, 1);
  const w2 = makeBot();
  await w2.addPiece();
  w2.at(17, 0); await w2.tick();
  assert.equal(w2.fb.length, 0);
});

await scenario("Multi-photo post: photos uploaded hidden, then one post with all of them + contact info", async () => {
  const w = makeBot();
  await w.addPiece(HEMA, 3);
  w.at(15); await w.tick();
  assert.deepEqual(w.fb.slice(0, 3).map((f) => f.fields.published), ["false", "false", "false"]);
  const feed = w.fb[3];
  assert.equal(feed.path, "feed");
  assert.ok("attached_media[2]" in feed.fields);
  assert.ok(feed.fields.message.startsWith(GOOD) && feed.fields.message.endsWith(CONTACT));
});

await scenario("One-photo post: posted as a photo with the caption", async () => {
  const w = makeBot();
  await w.addPiece();
  w.at(15); await w.tick();
  assert.equal(w.fb[0].path, "photos");
  assert.ok(w.fb[0].fields.caption.endsWith(CONTACT));
});

await scenario("Nothing in the queue at 3 PM → one warning, not one every 5 minutes", async () => {
  const w = makeBot();
  w.at(15); await w.tick();
  w.at(15, 5); await w.tick();
  w.at(15, 10); await w.tick();
  assert.equal(w.count(OWNER, "بس مفيش بوستات جاهزة"), 1);
  assert.equal(w.count(HEMA, "بس مفيش بوستات جاهزة"), 1);
});

await scenario("Facebook error: told once, the post stays, it retries and succeeds", async () => {
  const w = makeBot();
  await w.addPiece();
  w.fbFail = true;
  w.at(15); await w.tick();
  w.at(15, 5); await w.tick();
  assert.equal(w.count(OWNER, "❌ حصلت مشكلة"), 1);
  assert.equal(w.pieces().length, 1);
  w.fbFail = false;
  w.at(15, 10); await w.tick();
  assert.equal(w.pieces().length, 0);
  assert.ok(w.has(OWNER, "✅ اتنشر"));
});

await scenario("A failed post at 3 PM doesn't post twice at 10 PM", async () => {
  const w = makeBot();
  await w.addPiece(); await w.addPiece();
  w.fbFail = true;
  for (const m of [0, 30]) { w.at(15, m); await w.tick(); w.at(16, m); await w.tick(); }
  w.fbFail = false;
  w.at(22); await w.tick();
  assert.equal(w.fb.length, 1);
  assert.equal(w.pieces().length, 1);
});

await scenario("New day: the 3 PM post happens again tomorrow", async () => {
  const w = makeBot();
  await w.addPiece(); await w.addPiece(); await w.addPiece();
  w.at(15); await w.tick();
  w.at(15, 0, 29); await w.tick();
  assert.equal(w.fb.length, 2);
});

await scenario("Egypt's summer time ends (Oct 29→30): posts still go out at 3 PM Cairo time", async () => {
  const w = makeBot();
  await w.addPiece(); await w.addPiece();
  w.at(15, 0, 30); await w.tick();
  assert.equal(w.fb.length, 1);
  assert.equal(cairoTime(w.clock).hour, 15);
});

await scenario("TEST MODE: nothing goes to Facebook; both people get the 🧪 preview", async () => {
  const w = makeBot({ facebook: false });
  await w.addPiece();
  w.at(15); await w.tick();
  assert.equal(w.fb.length, 0);
  assert.ok(w.has(OWNER, "🧪 تجربة") && w.has(HEMA, "🧪 تجربة"));
  assert.equal(w.pieces().length, 0);
});

await scenario("A post that somehow has no caption at posting time still gets one", async () => {
  const w = makeBot();
  w.gemini = [null];
  await w.tap(HEMA, "count:1");
  w.bot.storage.setAlarm = async () => {};
  await w.msg(HEMA, { photo: "nc" });
  w.gemini = [GOOD];
  w.at(15); await w.bot.postIfTime(w.bot.state, w.bot.now());
  assert.ok(w.fb[0].fields.caption.startsWith(GOOD));
});

await scenario("Safety net: a post left without a caption is picked up by the 5-minute check", async () => {
  const w = makeBot();
  w.gemini = [null];
  await w.tap(HEMA, "count:1");
  w.bot.storage.setAlarm = async () => {};
  await w.msg(HEMA, { photo: "sn" });
  w.bot.state.to_caption = [];
  w.gemini = [GOOD];
  w.bot.storage.setAlarm = async () => { w.alarm = true; };
  await w.tick();
  assert.equal(w.pieces()[0].caption, GOOD);
});

// ---------------- Alerts ----------------

await scenario("Alerts: none before 1 PM, then every hour, still at 11:30 PM, none at 11:31 PM", async () => {
  const w = makeBot();
  w.at(12, 55); await w.tick();
  assert.equal(w.count(OWNER, "⚠️ تنبيه"), 0);
  w.at(13); await w.tick();
  w.at(13, 30); await w.tick();
  assert.equal(w.count(OWNER, "⚠️ تنبيه"), 1);
  w.at(14); await w.tick();
  assert.equal(w.count(OWNER, "⚠️ تنبيه"), 2);
  w.at(23, 30); await w.tick();
  assert.equal(w.count(OWNER, "⚠️ تنبيه"), 3);
  const w2 = makeBot();
  w2.at(23, 31); await w2.tick();
  assert.equal(w2.count(OWNER, "⚠️ تنبيه"), 0);
});

await scenario("Alerts go to both people and count posts, not pieces", async () => {
  const w = makeBot();
  await w.addPiece(HEMA, 3);
  w.at(13); await w.tick();
  const alert = w.texts(HEMA).find((t) => t.startsWith("⚠️ تنبيه"));
  assert.match(alert, /جاهز 1 بوست بس، ومحتاجين 3 بوست كمان/);
  assert.ok(w.has(OWNER, "⚠️ تنبيه"));
});

await scenario("No alert when there are enough posts for today and tomorrow", async () => {
  const w = makeBot();
  for (let i = 0; i < 4; i++) await w.addPiece();
  w.at(13); await w.tick();
  assert.equal(w.count(OWNER, "⚠️ تنبيه"), 0);
});

await scenario("At 11 PM (today's posts done) only tomorrow's 2 count", async () => {
  const w = makeBot();
  await w.addPiece(); await w.addPiece();
  w.at(15); await w.tick();
  w.at(22); await w.tick();
  await w.addPiece(); await w.addPiece();
  w.sent = [];
  w.at(23); await w.tick();
  assert.equal(w.count(OWNER, "⚠️ تنبيه"), 0);
});

// ---------------- Names, logo, saving ----------------

await scenario("Cheers: Hema → 'يا هيما'; someone without a name → just 'الله ينور'", async () => {
  const w = makeBot({ names: false });
  await w.addPiece();
  assert.ok(w.has(HEMA, "الله ينور!") && !w.has(HEMA, "يا {name}"));
  const cheers = new Set();
  const w2 = makeBot();
  for (let i = 0; i < 12; i++) { await w2.addPiece(); }
  for (const t of w2.texts(HEMA)) if (t.includes("الله ينور")) cheers.add(t.split("\n")[0]);
  for (const c of cheers) assert.ok(!/كمّل كده|مستنيين|جامد/.test(c), c);
});

await scenario("Logo: drawn when Cloudflare Images is there; the photo is kept as is if it fails", async () => {
  const w = makeBot();
  const bot = new BotCore(w.bot.storage, w.env, () => {}, () => 0, new Uint8Array([1]));
  assert.deepEqual(await bot.addLogo(JPEG), JPEG);              // no Images binding
  w.env.IMAGES = { info: async () => { throw new Error("down"); } };
  assert.deepEqual(await bot.addLogo(JPEG), JPEG);
  delete w.env.IMAGES;
});

await scenario("The queue (and a half-sent post) survive a Cloudflare restart", async () => {
  const w = makeBot();
  await w.addPiece();
  await w.tap(HEMA, "count:2");
  await w.msg(HEMA, { photo: "half" });
  const fresh = new BotCore(w.bot.storage, w.env, () => {}, () => w.clock);
  await fresh.load();
  assert.equal(fresh.state.pieces.length, 1);
  assert.deepEqual(fresh.state.open.photos, ["half"]);
});

await scenario("The full caption always ends with the address and both WhatsApp numbers", async () => {
  assert.ok(CONTACT.includes("القناطر الخيرية") && CONTACT.includes("01012087660") && CONTACT.includes("01092091391"));
});

// ---------------- Report ----------------

const failed = results.filter(([ok]) => !ok);
for (const [ok, name, why] of results) console.log(`${ok ? "✅" : "❌"} ${name}${ok ? "" : `\n     → ${why}`}`);
console.log(`\n${results.length - failed.length} of ${results.length} scenarios passed`);
process.exit(failed.length ? 1 : 0);
