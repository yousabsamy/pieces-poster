// Post photos of jewelry pieces from Telegram to the Facebook page, two pieces a day.
//
// The worker sends the (already enhanced) photos to the Telegram bot. Telegram passes every message
// to this code right away, so the bot answers in a second or two. Every 5 minutes Cloudflare also
// wakes it up to post the next piece at posting time and to send the "not enough pieces" alert.
//
// Photos sent together (as one album) are one piece, and go out together in one post.
// Captions are written by Gemini (free API key) from the photo; if Gemini fails, a ready-made
// caption in the same style is used instead.
// TEST MODE: until FB_PAGE_TOKEN is set, nothing is posted to Facebook. At posting time the post is
// sent to the allowed Telegram users instead, exactly as it would look on the page.

import { Buffer } from "node:buffer";

// ---------------- Settings (safe to change) ----------------
export const POST_HOURS = [16, 21];   // post one piece at each of these Cairo hours (4 PM and 9 PM)
const LATE_LIMIT_HOURS = 2;           // if something was down, still post up to this many hours after the time
const ALERT_FROM = [13, 0];           // send "not enough pieces" alerts only from 1:00 PM...
const ALERT_UNTIL = [23, 30];         // ...until 11:30 PM (hour, minute, Cairo time)
const ALERT_EVERY_MINUTES = 30;
const MAX_PHOTOS_PER_POST = 10;
const ALBUM_WAIT_SECONDS = 4;         // wait this long for the rest of an album before answering
const GEMINI_MODELS = ["gemini-flash-latest", "gemini-2.5-flash"];  // tried in this order
const FB_API_VERSION = "v26.0";

const SHOP_NAME = "مجوهرات السلام";
// The last line of every post, same as the page's own posts. Add the address or WhatsApp here if you want them too.
export const FOOTER = "💛 مجوهرات السلام… الدهب اللي يليق بذوقك.";

// A real post from the page. Gemini copies its style.
const STYLE_EXAMPLE =
  "✨ مش مجرد حلق دهب… دي حكاية شياكة بتتحكي من أول نظرة! 💛👑\n" +
  "تفاصيل كلها رقة، ولمعة كلها فخامة، وتصميم معمول عشان يسيب بصمة في كل إطلالة 😍✨";

// Used when Gemini is not available. {note} is what the worker wrote under the photo (if anything).
const READY_CAPTIONS = [
  "✨ مش مجرد دهب… دي لمسة شياكة بتبان من أول نظرة! 💛👑\n{note}تفاصيل كلها رقة، ولمعة كلها فخامة 😍✨",
  "👑 لما الذوق يتقابل مع الدهب… تطلع قطعة زي دي! ✨💛\n{note}تصميم شيك يكمّل إطلالتك في كل مناسبة 😍",
  "💛 قطعة تخطف العين من أول نظرة! ✨\n{note}شغل نضيف ولمعة فخمة، معمولة مخصوص علشان تفرّحك 😍👑",
  "✨ الشياكة بتبدأ من التفاصيل… والتفاصيل هنا كلها دهب! 💛\n{note}رقة في التصميم وفخامة في اللمعة 😍✨",
  "🎁 هدية تفرّح أي حد بتحبه… وتفضل معاه العمر كله! 💛✨\n{note}تصميم رقيق ولمعة تليق بكل مناسبة 👑",
  "👑 دهب بيتكلم عن نفسه! ✨\n{note}تفاصيل مشغولة بحب، وتصميم يسيب بصمة في كل إطلالة 😍💛",
];

const GEMINI_PROMPT =
  "You write Facebook captions for " + SHOP_NAME + ", a gold jewelry shop in El Qanater El Khayreya, Egypt. " +
  "The photo(s) show ONE gold piece the shop is selling. Write a caption in Egyptian Arabic, exactly 2 lines, " +
  "in the same style as this real post from the page:\n\n" + STYLE_EXAMPLE + "\n\n" +
  "Line 1: a catchy hook about this exact piece (say what it is), with 2 emojis like ✨💛👑. " +
  "Line 2: describe its details, shine and feel, with 2 emojis like 😍✨. {note}" +
  "Write something new, don't copy the example. Never write a price, weight or karat unless it is in the " +
  "shop's note. Do not add hashtags, phone numbers, addresses, links or the shop's name. " +
  "Reply with the 2 lines only, nothing else.";

const HELP =
  "أهلاً 👋\n" +
  "ابعت صورة القطعة هنا وأنا هنزلها على صفحة الفيسبوك.\n\n" +
  "• لو القطعة ليها أكتر من صورة: اختار الصور مع بعض وابعتهم مرة واحدة، وهيتنشروا في بوست واحد.\n" +
  "• تقدر تكتب تحت الصورة معلومة عن القطعة (مثلاً: خاتم عيار 21).\n" +
  "• كل يوم بيتنشر قطعتين: الساعة 4 العصر و9 بالليل.\n\n" +
  "الأوامر:\n" +
  "/list – القطع اللي مستنية دورها\n" +
  "/delete 5 – امسح قطعة رقم 5\n" +
  "/merge – اجمع آخر قطعتين في بوست واحد\n" +
  "/caption 5 الكلام الجديد – غيّر كلام قطعة رقم 5\n" +
  "/preview – شوف البوست الجاي بالظبط زي ما هيتنشر";
// ------------------------------------------------------------

const DAYS = ["الحد", "الاتنين", "التلات", "الأربع", "الخميس", "الجمعة", "السبت"];
const MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو",
  "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];

// ---------------- Cairo time ----------------

const cairoFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

export function cairoTime(ms) {
  const p = Object.fromEntries(cairoFormat.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { ms, date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) };
}

function addDays(date, days) {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function upcomingSlots(state, now, count) {
  // The next `count` posting times, starting with what's still left today.
  const slots = [];
  for (let day = 0; slots.length < count; day++) {
    const date = addDays(now.date, day);
    for (const hour of POST_HOURS) {
      if (day === 0 && (state.posted_hours.includes(hour) || now.hour >= hour + LATE_LIMIT_HOURS)) continue;
      slots.push({ date, hour });
    }
  }
  return slots.slice(0, count);
}

function whenText(slot, now) {
  let day;
  if (slot.date === now.date) day = "النهارده";
  else if (slot.date === addDays(now.date, 1)) day = "بكرة";
  else {
    const d = new Date(slot.date + "T00:00:00Z");
    day = `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  }
  return `${day} الساعة ${slot.hour % 12 || 12} ${slot.hour < 12 ? "صباحًا" : "مساءً"}`;
}

function pieceSchedule(state, now) {
  const slots = upcomingSlots(state, now, Math.max(state.pieces.length, 1));
  return Object.fromEntries(state.pieces.map((p, i) => [p.id, whenText(slots[i], now)]));
}

function currentSlot(state, now) {
  return POST_HOURS.find((h) => h <= now.hour && now.hour < h + LATE_LIMIT_HOURS && !state.posted_hours.includes(h));
}

// ---------------- Captions ----------------

function imageType(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return null;
}

export function cleanCaption(text) {
  // Keep only plain caption lines: no links, hashtags or phone numbers from the AI.
  const lines = text.trim().replace(/^[`"'«»]+|[`"'«»]+$/g, "").trim().split("\n")
    .map((line) => line.replace(/https?:\/\/\S+|www\.\S+|#\S+/g, "").trim())
    .filter((line) => !/\d{7,}/.test(line.replace(/\s/g, "")));
  const result = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!/[؀-ۿ]/.test(result) || result.length < 10 || result.length > 700) return null;
  return result;
}

function readyCaption(piece) {
  const note = piece.note ? `${piece.note}\n` : "";
  return READY_CAPTIONS[piece.id % READY_CAPTIONS.length].replace("{note}", note);
}

export function fullCaption(piece) {
  return `${piece.caption}\n\n${FOOTER}`;
}

// ---------------- The bot ----------------

function newState() {
  return { day: null, posted_hours: [], failed_slot: null, last_alert: 0, next_id: 1, pieces: [] };
}

export class BotCore {
  // storage: { get(key), put(key, value), setAlarm(ms) }. fetch and now() are passed in so tests can fake them.
  constructor(storage, env, fetchFn = fetch, nowFn = Date.now) {
    this.storage = storage;
    this.env = env;
    this.fetch = fetchFn;
    this.now = () => cairoTime(nowFn());
  }

  async load() {
    if (!this.state) this.state = (await this.storage.get("state")) || newState();
    const now = this.now();
    this.state.pending ||= [];       // pieces waiting for the rest of their album
    if (this.state.day !== now.date) Object.assign(this.state, { day: now.date, posted_hours: [], failed_slot: null });
    return this.state;
  }

  async save() {
    await this.storage.put("state", this.state);
  }

  allowedUsers() {
    return (this.env.ALLOWED_USERS || "").match(/\d+/g)?.map(Number) || [];
  }

  // ---- Telegram ----

  async telegram(method, params) {
    const res = await this.fetch(`https://api.telegram.org/bot${this.env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.description}`);
    return data.result;
  }

  async send(chat, text) {
    try {
      await this.telegram("sendMessage", { chat_id: chat, text: text.slice(0, 4000) });
    } catch (e) {
      console.log(`Could not send a Telegram message: ${e.message}`);
    }
  }

  async tellEveryone(text) {
    for (const user of this.allowedUsers()) await this.send(user, text);
  }

  async downloadPhoto(fileId) {
    const { file_path } = await this.telegram("getFile", { file_id: fileId });
    const res = await this.fetch(`https://api.telegram.org/file/bot${this.env.TELEGRAM_BOT_TOKEN}/${file_path}`);
    if (!res.ok) throw new Error("Could not download a photo from Telegram");
    return new Uint8Array(await res.arrayBuffer());
  }

  async sendPreview(chat, piece, header) {
    // Show a post on Telegram exactly as it will look on Facebook: the photos with the full caption.
    await this.send(chat, header);
    const caption = fullCaption(piece).slice(0, 1024);
    const files = piece.files || [];
    const media = piece.photos.map((f) => ({ type: files.includes(f) ? "document" : "photo", media: f }));
    try {
      if (media.length === 1) {
        const type = media[0].type;
        await this.telegram(type === "document" ? "sendDocument" : "sendPhoto",
          { chat_id: chat, caption, [type]: media[0].media });
      } else {
        // Telegram can't mix photos and files in one album
        if (new Set(media.map((m) => m.type)).size > 1) media.forEach((m) => { m.type = "document"; });
        media[0].caption = caption;
        await this.telegram("sendMediaGroup", { chat_id: chat, media });
      }
    } catch (e) {
      console.log(`Could not send a preview: ${e.message}`);
      await this.send(chat, caption);
    }
  }

  // ---- Captions ----

  async geminiCaption(images, note) {
    const key = this.env.GEMINI_API_KEY;
    if (!key) return null;
    const noteText = note ? `The shop's note about the piece: "${note}". ` : "";
    const parts = [{ text: GEMINI_PROMPT.replace("{note}", noteText) }];
    for (const bytes of images.slice(0, 3)) {
      const type = imageType(bytes);
      if (type) parts.push({ inline_data: { mime_type: type, data: Buffer.from(bytes).toString("base64") } });
    }
    const body = JSON.stringify({ contents: [{ parts }], generationConfig: { temperature: 0.9 } });
    for (const model of GEMINI_MODELS) {
      try {
        const res = await this.fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key }, body });
        if (!res.ok) {
          console.log(`Gemini ${model} failed: ${res.status}`);
          continue;
        }
        const result = await res.json();
        const text = result.candidates[0].content.parts.filter((p) => !p.thought).map((p) => p.text || "").join("");
        const caption = cleanCaption(text);
        if (caption) return caption;
        console.log(`Gemini ${model} gave an unusable caption`);
      } catch (e) {
        console.log(`Gemini ${model} failed: ${e.name}`);
      }
    }
    return null;
  }

  async writeCaption(piece, images) {
    if (!images) {
      try {
        images = await Promise.all(piece.photos.slice(0, 3).map((f) => this.downloadPhoto(f)));
      } catch (e) {
        images = [];
      }
    }
    piece.caption = (await this.geminiCaption(images, piece.note)) || readyCaption(piece);
  }

  // ---- Messages from Telegram (called right away for every message) ----

  async handleUpdate(update) {
    const state = await this.load();
    const msg = update.message;
    if (!msg || msg.chat?.type !== "private") return;
    const user = msg.from.id;
    const chat = msg.chat.id;
    if (!this.allowedUsers().includes(user)) {
      return this.send(chat, `أهلاً 👋 البوت ده خاص بـ ${SHOP_NAME}.\nرقمك هو: ${user}\nابعته ليوساب علشان يضيفك.`);
    }

    let fileId = null;
    let asFile = false;
    if (msg.photo) fileId = msg.photo[msg.photo.length - 1].file_id;      // the biggest size
    else if (msg.document?.mime_type?.startsWith("image/")) {
      fileId = msg.document.file_id;                                    // photo sent as a file (full quality)
      asFile = true;
    }

    if (fileId) {
      const piece = this.addPhoto(state, msg, fileId, asFile);
      // Wait a few seconds for the rest of the album, then answer once for the whole piece.
      if (!state.pending.includes(piece.id)) state.pending.push(piece.id);
      await this.save();
      await this.storage.setAlarm(this.now().ms + ALBUM_WAIT_SECONDS * 1000);
      return;
    }
    if ((msg.text || "").startsWith("/")) {
      try {
        await this.handleCommand(state, chat, msg.text);
      } catch (e) {
        console.log(`Command failed: ${e.message}`);
        await this.send(chat, "في حاجة غلط في الأمر، جرب تاني.");
      }
      return this.save();
    }
    return this.send(chat, "ابعت صورة القطعة، أو اكتب /help علشان تشوف الأوامر.");
  }

  addPhoto(state, msg, fileId, asFile) {
    const group = msg.media_group_id || null;
    let piece = group && state.pieces.find((p) => p.group === group);
    if (!piece) {
      piece = { id: state.next_id++, photos: [], files: [], group, note: "", caption: null, from: msg.from.id };
      state.pieces.push(piece);
    }
    if (!piece.photos.includes(fileId) && piece.photos.length < MAX_PHOTOS_PER_POST) {
      piece.photos.push(fileId);
      if (asFile) piece.files.push(fileId);
    }
    if (msg.caption && !piece.note) {
      piece.note = msg.caption.trim().slice(0, 300);
      piece.caption = null;                       // write it again with the note
    }
    return piece;
  }

  async albumDone() {
    // Called a few seconds after the last photo: write captions and tell the sender when each piece goes out.
    const state = await this.load();
    const ids = state.pending;
    state.pending = [];
    await this.save();
    for (const id of ids) {
      const piece = state.pieces.find((p) => p.id === id);
      if (!piece) continue;
      if (!piece.caption) await this.writeCaption(piece);
      await this.save();
      await this.send(piece.from,
        `✅ استلمت قطعة رقم ${piece.id} (${piece.photos.length} صورة)\n` +
        `🗓 هتتنشر ${pieceSchedule(state, this.now())[piece.id]}\n\n` +
        `📝 الكلام اللي هيتكتب:\n${piece.caption}\n\n` +
        `لتغييره: /caption ${piece.id} الكلام الجديد`);
    }
  }

  async handleCommand(state, chat, text) {
    const [rawCommand, ...words] = text.trim().split(/\s+/);
    const command = rawCommand.split("@")[0].toLowerCase();
    const rest = text.trim().slice(rawCommand.length).trim();
    const now = this.now();
    const find = (n) => state.pieces.find((p) => String(p.id) === n);

    if (command === "/start" || command === "/help") return this.send(chat, HELP);

    if (command === "/list") {
      if (!state.pieces.length) return this.send(chat, "📭 مفيش قطع مستنية دلوقتي. ابعت صور القطع هنا.");
      const times = pieceSchedule(state, now);
      const lines = [`🗂 القطع اللي مستنية (${state.pieces.length}):`];
      for (const p of state.pieces) {
        const first = (p.caption || p.note || "").split("\n")[0].slice(0, 50);
        lines.push(`\nرقم ${p.id} – ${p.photos.length} صورة – ${times[p.id]}\n${first}`);
      }
      return this.send(chat, lines.join("\n"));
    }

    if (command === "/delete") {
      const piece = find(rest);
      if (!piece) return this.send(chat, "اكتب رقم القطعة بعد الأمر، مثلاً: /delete 5\nشوف الأرقام بـ /list");
      state.pieces.splice(state.pieces.indexOf(piece), 1);
      return this.send(chat, `🗑 اتمسحت قطعة رقم ${piece.id}.`);
    }

    if (command === "/merge") {
      if (state.pieces.length < 2) return this.send(chat, "لازم يكون فيه قطعتين على الأقل علشان أجمعهم.");
      const last = state.pieces.pop();
      const before = state.pieces[state.pieces.length - 1];
      before.photos = [...before.photos, ...last.photos].slice(0, MAX_PHOTOS_PER_POST);
      before.files = [...(before.files || []), ...(last.files || [])];
      before.note = before.note || last.note;
      await this.writeCaption(before);
      return this.send(chat, `🔗 جمعت قطعة ${last.id} مع قطعة ${before.id} – هيتنشروا في بوست واحد ` +
        `(${before.photos.length} صورة).\n\n📝 الكلام الجديد:\n${before.caption}`);
    }

    if (command === "/caption") {
      const piece = find(words[0] || "");
      const newText = rest.slice((words[0] || "").length).trim();
      if (!piece || !newText) return this.send(chat, "اكتبها كده: /caption 5 الكلام الجديد");
      piece.caption = newText.slice(0, 1500);
      return this.send(chat, `✏️ اتغير كلام قطعة رقم ${piece.id}.`);
    }

    if (command === "/preview") {
      if (!state.pieces.length) return this.send(chat, "📭 مفيش قطع مستنية دلوقتي.");
      const piece = state.pieces[0];
      if (!piece.caption) await this.writeCaption(piece);
      return this.sendPreview(chat, piece,
        `👀 ده البوست الجاي (قطعة رقم ${piece.id} – ${pieceSchedule(state, now)[piece.id]}):`);
    }

    return this.send(chat, "مش فاهم الأمر ده 🙂\n\n" + HELP);
  }

  // ---- Facebook ----

  async facebook(path, fields, image) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    form.append("access_token", this.env.FB_PAGE_TOKEN);
    if (image) form.append("source", new Blob([image], { type: imageType(image) || "image/jpeg" }), "piece");
    const res = await this.fetch(`https://graph.facebook.com/${FB_API_VERSION}/${this.env.FB_PAGE_ID}/${path}`,
      { method: "POST", body: form });
    // Never print the token: only Facebook's own answer.
    if (!res.ok) throw new Error(`Facebook refused the post: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }

  async postToFacebook(images, caption) {
    // One photo -> photo post. Several photos -> one post with all of them. Returns the post id.
    if (images.length === 1) {
      const result = await this.facebook("photos", { caption }, images[0]);
      return result.post_id || result.id;
    }
    const fields = { message: caption };
    for (const [i, image] of images.entries()) {
      const { id } = await this.facebook("photos", { published: "false" }, image);
      fields[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id });
    }
    return (await this.facebook("feed", fields)).id;
  }

  // ---- Every 5 minutes ----

  async tick() {
    const state = await this.load();
    await this.postIfTime(state, this.now());
    await this.alertIfNeeded(state, this.now());
    await this.save();
  }

  async postIfTime(state, now) {
    const slot = currentSlot(state, now);
    if (slot === undefined) return;
    if (!state.pieces.length) {
      state.posted_hours.push(slot);
      await this.save();
      return this.tellEveryone(`⚠️ كان المفروض يتنشر بوست الساعة ${slot % 12 || 12}، بس مفيش قطع في الطابور.\n` +
        "📸 ابعت صور القطع هنا.");
    }
    const piece = state.pieces[0];

    if (!this.env.FB_PAGE_TOKEN) {
      // TEST MODE: show the post on Telegram instead of posting it.
      if (!piece.caption) await this.writeCaption(piece);
      state.pieces.shift();
      state.posted_hours.push(slot);
      await this.save();
      for (const user of this.allowedUsers()) {
        await this.sendPreview(user, piece,
          `🧪 تجربة – ده البوست اللي كان هيتنشر دلوقتي على الصفحة (قطعة رقم ${piece.id}). ما اتنشرش على الفيسبوك.`);
      }
      return;
    }

    let postId;
    try {
      const images = await Promise.all(piece.photos.map((f) => this.downloadPhoto(f)));
      if (!piece.caption) await this.writeCaption(piece, images);
      postId = await this.postToFacebook(images, fullCaption(piece));
    } catch (e) {
      console.log(`Posting piece ${piece.id} failed: ${e.message}`);
      const slotName = `${now.date} ${slot}`;
      if (state.failed_slot !== slotName) {          // tell people once, then keep trying quietly
        state.failed_slot = slotName;
        await this.tellEveryone(`❌ حصلت مشكلة في نشر قطعة رقم ${piece.id}. هحاول تاني كمان شوية.\n${e.message.slice(0, 200)}`);
      }
      return;
    }
    state.pieces.shift();
    state.posted_hours.push(slot);
    await this.save();                                 // save right away, so it never posts twice
    console.log(`Posted piece ${piece.id}: ${postId}`);
    await this.tellEveryone(`✅ اتنشرت قطعة رقم ${piece.id} على الصفحة.\nفاضل في الطابور: ${state.pieces.length} قطعة.`);
  }

  async alertIfNeeded(state, now) {
    // Warn if the queue doesn't cover what's left today plus all of tomorrow.
    const leftToday = upcomingSlots(state, now, POST_HOURS.length).filter((s) => s.date === now.date).length;
    const missing = leftToday + POST_HOURS.length - state.pieces.length;
    const minutes = now.hour * 60 + now.minute;
    const inHours = ALERT_FROM[0] * 60 + ALERT_FROM[1] <= minutes && minutes <= ALERT_UNTIL[0] * 60 + ALERT_UNTIL[1];
    if (missing <= 0 || !inHours) return;
    if (now.ms - (state.last_alert || 0) < (ALERT_EVERY_MINUTES - 2) * 60 * 1000) return;
    state.last_alert = now.ms;
    await this.save();
    await this.tellEveryone("⚠️ تنبيه: مفيش بوستات جاهزة لبكرة.\n" +
      `في الطابور ${state.pieces.length} قطعة، ومحتاجين ${missing} قطعة كمان.\n` +
      "📸 ابعت صور القطع هنا.");
  }
}
