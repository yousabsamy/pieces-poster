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
export const POST_HOURS = [15, 22];   // post one piece at each of these Cairo hours (3 PM and 10 PM)
const LATE_LIMIT_HOURS = 2;           // if something was down, still post up to this many hours after the time
const ALERT_FROM = [13, 0];           // send "not enough pieces" alerts only from 1:00 PM...
const ALERT_UNTIL = [23, 30];         // ...until 11:30 PM (hour, minute, Cairo time)
const ALERT_EVERY_MINUTES = 60;
const MAX_PHOTOS_PER_POST = 10;
// Tried in this order (all available on the free key, Oct 2026). Busy or missing ones are skipped.
const GEMINI_MODELS = ["gemini-3.5-flash", "gemini-flash-latest", "gemini-3.8-flash", "gemini-3.1-flash-lite",
  "gemini-flash-lite-latest"];
const CAPTION_RETRIES = 5;           // if Gemini is busy, try again this many times...
const CAPTION_RETRY_MINUTES = 3;     // ...this many minutes apart, before using a ready-made caption
const FB_API_VERSION = "v26.0";

const SHOP_NAME = "مجوهرات السلام";

// Real captions from the page's own piece posts (October 2026). Gemini learns the style from these.
// To teach it more, add good captions here.
const STYLE_EXAMPLES = [
  "مش مجرد حلق دهب… دي حكاية شياكة بتتحكي من أول نظرة! 💛👑\nتفاصيل كلها رقة، ولمعة كلها فخامة، وتصميم معمول عشان يسيب بصمة في كل إطلالة 😍✨\nمجوهرات السلام… الدهب اللي يليق بذوقك.",
  "حلق دهب بتصميم يخطف العين، ولمعة تضيف لإطلالتك لمسة من الرقي والفخامة\nقطعة ناعمة في تفاصيلها، فخمة في حضورها، ومميزة في كل وقت\nمجوهرات السلام… لأنك تستاهلي كل ما هو جميل.",
  "لمسة ذهب تكمّل أناقتك\nأنسيال فاخر بتصميم راقي وتفاصيل تخطف العين\nمن مجوهرات السلام… لأن الذوق العالي يبدأ من التفاصيل.",
  "أناقة تِبان من أول نظرة\nانسيالات ذهب بتفاصيل راقية ولمسة فخامة تكمل جمالك\nمجوهرات السلام — لأن التفاصيل الصغيرة تصنع الفرق.",
  "مش مجرد دبل.. دي حكاية حب متحاوطه بالشياكة والفخامة\nتفصيلة صغيرة.. ومعنى كبير\nمجوهرات السلام — عنوان الرُقيّ والأناقة",
  "الفخامة في التفاصيل.. والأناقة في الاختيار\nدبلة من ذهب عيار 21 بتصميم راقٍ ونقوش مميزة، تجمع بين جمال الذهب وأصالة الذوق الرفيع.\nلأن كل تفصيلة ليها حكاية.. اختاري اللي يليق بيكي.\nمجوهرات السلام\nعنوان الثقة والشياكة",
  "دبلة مش مجرد قطعة ذهب…\nدي وعد، وحكاية عمر، وتفصيلة بتكمل أجمل بداية\nاختاروا دبلتكم بعناية…\nلأن الذوق الحقيقي يبدأ من التفاصيل\nمجوهرات السلام",
  "دبلة تحكي عن وعد… وذهب يكمّل الحكاية\nاختيارك للتفاصيل هو عنوان أناقتك\nمجوهرات السلام",
  "في عالم الدهب… التفاصيل هي سر الفخامة\nخواتم من دهب تسرق النظرة من أول لمعة\nتصميمات راقية، وشغل مليان ذوق وإبداع… لأن كل ست تستاهل قطعة دهب تليق بجمالها\nمجوهرات السلام\nفخامة في الاختيار… وتميّز في كل تفصيلة",
  "لأن الأناقة تبدأ من التفاصيل الصغيرة…\nتشكيلة من خواتم الذهب بتصميمات تخطف العين، ولمعة تحكي عن الفخامة والرقي.\nكل خاتم حكاية جمال… وكل تفصيلة معمولة علشان تكمّل شياكتك.\nمجوهرات السلام\nعنوان الذوق الرفيع… ولمعة تليق بيكي",
  "خاتم واحد… كفيل يكمل أناقتك\nفخامة في التفاصيل، ورقي في الاختيار\nمجوهرات السلام — ذوقك له بريقه الخاص",
  "تفاصيل صغيرة… بتكمل أناقتك الكبيرة\nخواتم ذهب بتصميم راقي ولمسة من الفخامة\nاختاري اللي يشبه ذوقك… وسيبي الباقي علينا\nمجوهرات السلام",
  "أناقة تُلبس… وفخامة تليق بيكي\nاختاري خاتمك من أجمل تصاميم الذهب\nلأن التفاصيل الصغيرة هي اللي بتكمل جمالك.\nمجوهرات السلام",
  "الفخامة مش محتاجة كلام كتير… قطعة واحدة كفاية تحكي عن ذوقك\nخاتم وإسوارة بتفاصيل راقية ولمعة تخطف العين.\nاختاري أناقتك… واختاريها من مجوهرات السلام",
  "وزن خفيف وشكل خرافه\nيملي العين",
  "الشياكة مش بالوزن.. الشياكة في التفاصيل\nغوايش ذهب بأوزان خفيفة، عشان كل واحدة تقدر تلبس وتِتألّق\nأناقة رقيقة.. ولمعة تليق بيكي من مجوهرات السلام",
  "غوايش ذهب.. أناقة تُلبس وتِبان\nتفاصيل فخمة ولمعة تخطف العين\nاختاري شياكتك من مجوهرات السلام",
  "لأن الأناقة الحقيقية تُرى من أول نظرة…\nغوايش ذهب بتفاصيل تخطف العين، وفخامة تليق بكل لحظة مميزة\nمجوهرات السلام — الذهب لما يكون عنوان للأناقة.",
  "الفخامة تبدأ من التفاصيل… والذهب عنوانها\nغوايش ذهب بتصميم راقٍ يكمّل أناقتك ويخلي كل إطلالة لها بريق خاص\nمجوهرات السلام\nثقة • أناقة • قيمة تدوم",
  "لأن الشياكة تفاصيل… والذهب عنوانها\nسلسلة ذهب بتصميم راقي ولمسة فخامة تخطف العين\nمجوهرات السلام.. جمال يدوم وقيمة لا تُقدّر بثمن",
  "لأن الاسم له حكاية… خليه يتكتب دهب\nسلسلة باسمك بتتصمم مخصوص ليكي، بتفاصيل راقية ولمسة فخامة تليق بيكي\nمجوهرات السلام\nلأن تميزك يستاهل قطعة معمولة مخصوص علشانك.",
  "فخامة الذهب في كل تفصيلة\nقطعة تخطف الأنظار بتصميمها الملكي وشياكتها اللي ملهاش مثيل\nلأن الأناقة الحقيقية عنوانها الذهب\nمجوهرات السلام… عنوان الفخامة والتميز",
  "قطعة من الذهب… تحكي عن ذوقك\nتفاصيل فخمة ولمعة تخطف القلب\nمجوهرات السلام — لأن الشياكة لها عنوان.",
  "قطعة من الفخامة… تفاصيل تخطف العين وأناقة تليق بكل لحظة\nاختاري ذهبك… واختاري التميز مع مجوهرات السلام",
  "أناقة تليق بكل لحظة… ولمعة ذهب تحكي عن ذوقك الراقي\nمجوهرات السلام — لأن التفاصيل الصغيرة تصنع الفخامة.",
  "تألقي بلمسة من الذهب الخالص\nتصميمات تناسب كل الأذواق\nأناقة لا تحتاج إلى كلام\nقطعة صغيرة... وقيمة كبيرة",
];

// Added under every caption (same lines as the gold price posts).
export const CONTACT =
  "📍 أول شارع البنك الزراعي – بجوار صيدلية عزمي – القناطر الخيرية\n" +
  "📞 واتساب: 01012087660 – 01092091391";

// The logo goes in the bottom-right corner of every photo (the owner chose "Option 1").
const LOGO_WIDTH = 0.16;       // logo width, as a part of the photo's width
const LOGO_MARGIN = 0.03;      // space from the edges, as a part of the photo's width
const LOGO_OPACITY = 0.95;
const STORIES_ON = false;        // owner wants Stories later: set to true to turn them on
const MAX_STORIES_PER_POST = 3;  // after each post, its photos (up to this many) also go up as Page Stories

// Said to the worker every time a post is ready. {name} comes from the USER_NAMES secret ("id:name, id:name").
const CHEERS = [
  "🌟 الله ينور يا {name}! 💪🔥",
  "👏 الله ينور يا {name}! ✨ شغل عالي",
  "💛 الله ينور يا {name}! 😍 تسلم إيدك",
];

// Used only when Gemini is not available.
const READY_CAPTIONS = [
  "✨ قطعة من الذهب… تحكي عن ذوقك 💛\nتفاصيل فخمة ولمعة تخطف القلب 😍\nمجوهرات السلام — لأن الشياكة لها عنوان.",
  "👑 أناقة تليق بكل لحظة… ولمعة ذهب تحكي عن ذوقك الراقي ✨\nمجوهرات السلام — لأن التفاصيل الصغيرة تصنع الفخامة.",
  "💛 الفخامة مش محتاجة كلام كتير… قطعة واحدة كفاية تحكي عن ذوقك ✨\nمجوهرات السلام… الدهب اللي يليق بذوقك.",
  "✨ الشياكة بتبدأ من التفاصيل… والتفاصيل هنا كلها دهب! 💛\nرقة في التصميم وفخامة في اللمعة 😍\nمجوهرات السلام — عنوان الذوق والرقي.",
];

const GEMINI_PROMPT =
  "You write Facebook captions for " + SHOP_NAME + " (Al-Salam Jewelry), a gold jewelry shop in El Qanater " +
  "El Khayreya, Egypt. The photo(s) show ONE gold piece the shop is selling.\n\n" +
  "First, look closely and decide exactly what the piece is, in Egyptian words: حلق، خاتم، دبلة، دبل، " +
  "غويشة / غوايش، انسيال، إسورة، سلسلة، سلسلة باسم، كوليه، تعليقة، طقم، خلخال، سبيكة، جنيه ذهب. " +
  "If there are several pieces, say so (for example خواتم or طقم).\n\n" +
  "Then write ONE caption in Egyptian Arabic in exactly the same style as these real captions from the page:\n\n" +
  STYLE_EXAMPLES.map((c, i) => `[${i + 1}]\n${c}`).join("\n\n") + "\n\n" +
  "Rules:\n" +
  "- 2 to 4 short lines. Line 1 is a catchy hook. Then name the piece and describe what you really see " +
  "(its shape, design, details, shine). The last line is a sign-off with \"مجوهرات السلام\" and a short " +
  "classy phrase, like the examples (use a new phrase, not always the same one).\n" +
  "- Add 2 to 4 emojis in total, like ✨💛👑😍💍, at the start or end of lines.\n" +
  "- Never write a price, weight or karat unless it is in the worker's note. Do not add hashtags, phone numbers, " +
  "addresses, links or offers.\n" +
  "- Write something new. Don't copy an example, and don't repeat these recent captions:\n{recent}\n" +
  "{note}" +
  "Reply with the caption only, nothing else.";

const HELP =
  "أهلاً 👋\n" +
  "ابعت صور القطعة هنا وأنا هنزلها على صفحة الفيسبوك.\n\n" +
  "• قبل كل قطعة هسألك: كام صورة؟ دوس على الرقم، وبعدين ابعت الصور.\n" +
  "• الصور دي كلها هتتنشر في بوست واحد، والكلام هيتكتب لوحده.\n" +
  "• لو عايز تقول حاجة عن القطعة (زي: دبل خفيفة) اكتبها، وهتتحط في الكلام.\n" +
  "• كل يوم بيتنشر بوستين: الساعة 3 العصر و10 بالليل.\n\n" +
  "الأزرار اللي تحت 👇\n" +
  "📋 البوستات – كل البوستات اللي مستنية، وتحت كل واحد أزرار (شوف، كلام تاني، عدّل بـ Gemini، اكتب بإيدك، امسح، انشر)\n" +
  "👀 البوست الجاي – شوفه بالظبط زي ما هيتنشر\n" +
  "🚀 انشر دلوقتي – انشر البوست الجاي حالاً\n" +
  "❌ الغي الصور – الغي الصور اللي لسه بتتبعت\n\n" +
  "🪄 عدّل بـ Gemini: قوله يغير إيه (مثلاً: خليه أقصر، اذكر إنه هدية).\n\n" +
  "وممكن تكتب كمان: امسح 3 – انشر 2 – كلام جديد 1 – عدل 1 – شوف 4 – امسح الكل";

// The buttons that stay at the bottom of the chat. Tapping one sends its text, which the bot understands.
const MENU = {
  keyboard: [
    [{ text: "📋 البوستات" }, { text: "👀 البوست الجاي" }],
    [{ text: "🚀 انشر دلوقتي" }, { text: "❌ الغي الصور" }],
    [{ text: "❓ مساعدة" }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

// Arabic words -> the command they mean. Checked on the cleaned text (no emojis, أ/إ/آ -> ا, ة -> ه, ى -> ي).
const ARABIC_COMMANDS = [
  [/^(البوستات|القايمه|القائمه|الطابور|البوستات اللي مستنيه|ليسته)$/, () => "/list"],
  [/^(البوست الجاي|شوف البوست|شوف|معاينه)$/, () => "/preview"],
  [/^(شوف|معاينه)( البوست)?( رقم)? (\d+)$/, (m) => `/preview ${m[4]}`],
  [/^انشر( دلوقتي| دلوقت| حالا| البوست)?( رقم)?( (\d+))?$/, (m) => `/postnow ${m[4] || ""}`],
  [/^(الغي|الغاء|الغي الصور|كنسل)$/, () => "/cancel"],
  [/^(مساعده|ساعدني|الاوامر|ابدا|القائمه الرئيسيه)$/, () => "/help"],
  [/^(امسح الكل|امسح كل البوستات|امسح كل حاجه|ابدا من الاول)$/, () => "/reset"],
  [/^(امسح|احذف|شيل)( البوست)?( رقم)? (\d+)$/, (m) => `/delete ${m[4]}`],
  [/^(كلام جديد|كلام تاني|اكتب تاني|غير الكلام)( للبوست| البوست)?( رقم)?( (\d+))?$/, (m) => `/rewrite ${m[5] || ""}`],
  [/^(عدل|تعديل|عدل بجيميناي)( البوست)?( رقم)? (\d+)$/, (m) => `/guide ${m[4]}`],
];

function cleanArabic(text) {
  return text
    .replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d))
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")          // tashkeel and tatweel
    .replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي")
    .replace(/[^\u0600-\u06FFa-zA-Z0-9\s]/g, " ")          // emojis and punctuation
    .replace(/\s+/g, " ").trim();
}

export function arabicCommand(text) {
  const clean = cleanArabic(text);
  for (const [pattern, toCommand] of ARABIC_COMMANDS) {
    const m = clean.match(pattern);
    if (m) return toCommand(m).trim();
  }
  return null;
}
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
    .map((line) => {
      const cleaned = line.replace(/https?:\/\/\S+|www\.\S+|#\S+/g, "").trim();
      return cleaned || !line.trim() ? cleaned : null;     // a line that was only links/hashtags is dropped
    })
    .filter((line) => line !== null && !/\d{7,}/.test(line.replace(/\s/g, "")));
  const result = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!/[؀-ۿ]/.test(result) || result.length < 10 || result.length > 700) return null;
  return result;
}

function addNote(open, text) {
  const t = text.trim();
  if (t && !open.note.includes(t)) open.note = (open.note ? `${open.note} – ${t}` : t).slice(0, 300);
}

function readyCaption(piece) {
  const caption = READY_CAPTIONS[piece.id % READY_CAPTIONS.length];
  return piece.note ? `${piece.note}\n${caption}` : caption;
}

export function fullCaption(piece) {
  // Gemini writes the caption (sign-off line included); the contact lines are always added by this code.
  return `${piece.caption}\n\n${CONTACT}`;
}

// ---------------- The bot ----------------

function newState() {
  return { day: null, posted_hours: [], failed_slot: null, last_alert: 0, next_id: 1, pieces: [], open: null };
}

export class BotCore {
  // storage: { get(key), put(key, value), setAlarm(ms) }. fetch and now() are passed in so tests can fake them.
  constructor(storage, env, fetchFn = (...args) => fetch(...args), nowFn = Date.now, logo = null) {
    this.logo = logo;                // the logo PNG (bytes); null = no logo
    this.storage = storage;
    this.env = env;
    this.fetch = fetchFn;
    this.now = () => cairoTime(nowFn());
    this.geminiWaits = [0, 10];      // seconds to wait before each round of Gemini tries when it's busy
  }

  async load() {
    if (!this.state) this.state = (await this.storage.get("state")) || newState();
    this.state.open ??= null;
    const now = this.now();
    if (this.state.day !== now.date) Object.assign(this.state, { day: now.date, posted_hours: [], failed_slot: null });
    return this.state;
  }

  async save() {
    await this.storage.put("state", this.state);
  }

  nameOf(user) {
    // USER_NAMES looks like "597598330:يوساب, 123456:هيما"
    for (const pair of (this.env.USER_NAMES || "").split(",")) {
      const [id, name] = pair.split(":").map((x) => x.trim());
      if (Number(id) === Number(user) && name) return name;
    }
    return null;
  }

  cheer(user) {
    const line = CHEERS[Math.floor(Math.random() * CHEERS.length)];
    const name = this.nameOf(user);
    return name ? line.replace("{name}", name) : line.replace(" يا {name}", "");
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

  async addLogo(bytes) {
    // Draws the logo in the bottom-right corner with Cloudflare Images. If anything fails, the photo goes out as it is.
    const images = this.env.IMAGES;
    if (!images || !this.logo) return bytes;
    try {
      const { width } = await images.info(new Response(bytes).body);
      const logo = images.input(new Response(this.logo).body).transform({ width: Math.round(width * LOGO_WIDTH) });
      const margin = Math.round(width * LOGO_MARGIN);
      const result = await images.input(new Response(bytes).body)
        .draw(logo, { bottom: margin, right: margin, opacity: LOGO_OPACITY })
        .output({ format: "image/jpeg", quality: 92 });
      return new Uint8Array(await result.response().arrayBuffer());
    } catch (e) {
      console.log(`Could not add the logo: ${e.message}`);
      return bytes;
    }
  }

  async storyImage(bytes) {
    // A tall (9:16) story picture: the photo in the middle over a blurred, darker copy of itself.
    const images = this.env.IMAGES;
    if (!images) return bytes;
    try {
      const photo = images.input(new Response(bytes).body).transform({ width: 1000, height: 1700, fit: "contain" });
      const result = await images.input(new Response(bytes).body)
        .transform({ width: 1080, height: 1920, fit: "cover", blur: 60, brightness: 0.7 })
        .draw(photo)
        .output({ format: "image/jpeg", quality: 90 });
      return new Uint8Array(await result.response().arrayBuffer());
    } catch (e) {
      console.log(`Could not make the story picture: ${e.message}`);
      return bytes;
    }
  }

  async postStories(photos) {
    // Each photo is uploaded hidden, then published as a Page Story. Returns how many went up.
    let done = 0;
    for (const photo of photos.slice(0, MAX_STORIES_PER_POST)) {
      const { id } = await this.facebook("photos", { published: "false" }, await this.storyImage(photo));
      await this.facebook("photo_stories", { photo_id: id });
      done++;
    }
    return done;
  }

  async postPhotos(piece) {
    // The photos exactly as they go to Facebook: downloaded from Telegram, with the logo.
    const images = await Promise.all(piece.photos.map((f) => this.downloadPhoto(f)));
    return Promise.all(images.map((b) => this.addLogo(b)));
  }

  async sendPreview(chat, piece, header) {
    // Show a post on Telegram exactly as it will look on Facebook: the photos with the logo and the full caption.
    await this.send(chat, header);
    const caption = fullCaption(piece).slice(0, 1024);
    try {
      const photos = await this.postPhotos(piece);
      const form = new FormData();
      form.append("chat_id", String(chat));
      if (photos.length === 1) {
        form.append("caption", caption);
        form.append("photo", new Blob([photos[0]], { type: "image/jpeg" }), "p0.jpg");
        await this.telegramForm("sendPhoto", form);
      } else {
        const media = photos.map((_, i) => ({ type: "photo", media: `attach://p${i}` }));
        media[0].caption = caption;
        form.append("media", JSON.stringify(media));
        photos.forEach((b, i) => form.append(`p${i}`, new Blob([b], { type: "image/jpeg" }), `p${i}.jpg`));
        await this.telegramForm("sendMediaGroup", form);
      }
    } catch (e) {
      console.log(`Could not send a preview: ${e.message}`);
      await this.send(chat, caption);
    }
  }

  async telegramForm(method, form) {
    const res = await this.fetch(`https://api.telegram.org/bot${this.env.TELEGRAM_BOT_TOKEN}/${method}`,
      { method: "POST", body: form });
    const data = await res.json();
    if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.description}`);
    return data.result;
  }

  // ---- Captions ----

  async geminiCaption(images, note, recent = [], edit = null) {
    const key = this.env.GEMINI_API_KEY;
    if (!key) return null;
    const noteText = note
      ? `- IMPORTANT: the shop's worker wrote this about the piece: "${note}". You MUST include this information ` +
        "in the caption, reworded naturally and nicely in the same style (don't just paste it), and trust it over " +
        "what you see in the photo.\n"
      : "";
    const recentText = recent.length ? recent.map((c) => `«${c}»`).join("\n") : "(none)";
    const editText = edit
      ? `- EDIT REQUEST (most important): the current caption is:\n«${edit.base}»\nThe shop asks for this change: ` +
        `"${edit.instruction}". Write the caption again with exactly this change, keeping what is already good. ` +
        "Follow the request even if it asks to mention a price, weight, karat or occasion. Still no links, phone " +
        "numbers or hashtags.\n"
      : "";
    const parts = [{ text: GEMINI_PROMPT.replace("{recent}", recentText).replace("{note}", noteText + editText) }];
    for (const bytes of images.slice(0, 3)) {
      const type = imageType(bytes);
      if (type) parts.push({ inline_data: { mime_type: type, data: Buffer.from(bytes).toString("base64") } });
    }
    const body = JSON.stringify({ contents: [{ parts }], generationConfig: { temperature: 0.9 } });
    // The free Gemini plan allows only a few requests a minute. When it says "busy" (429/503), wait and try again.
    for (const wait of this.geminiWaits) {
      if (wait) await new Promise((r) => setTimeout(r, wait * 1000));
      let busy = false;
      for (const model of GEMINI_MODELS) {
        try {
          const res = await this.fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
            { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key }, body,
              signal: AbortSignal.timeout(45000) });
          if (!res.ok) {
            console.log(`Gemini ${model} failed: ${res.status} ${(await res.text()).slice(0, 150)}`);
            if (res.status === 429 || res.status >= 500) busy = true;
            continue;
          }
          const result = await res.json();
          const text = result.candidates[0].content.parts.filter((p) => !p.thought).map((p) => p.text || "").join("");
          const caption = cleanCaption(text);
          if (caption) return caption;
          console.log(`Gemini ${model} gave an unusable caption`);
        } catch (e) {
          console.log(`Gemini ${model} failed: ${e.name}`);
          busy = true;
        }
      }
      if (!busy) break;
    }
    return null;
  }

  async writeCaption(piece, images, { fallback = true, edit = null } = {}) {
    if (!images) {
      try {
        images = await Promise.all(piece.photos.slice(0, 3).map((f) => this.downloadPhoto(f)));
      } catch (e) {
        images = [];
      }
    }
    const state = this.state;
    const caption = await this.geminiCaption(images, piece.note, edit ? [] : state?.recent || [], edit);
    if (!caption && !fallback) return false;        // Gemini is busy: the caller will try again later
    piece.caption = caption || readyCaption(piece);
    if (state) state.recent = [piece.caption, ...(state.recent || [])].slice(0, 6);   // so captions don't repeat
    return Boolean(caption);
  }

  // ---- Messages from Telegram (called right away for every message) ----

  async handleUpdate(update) {
    const state = await this.load();
    if (update.callback_query) return this.handleButton(state, update.callback_query);
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

    // Everyone gets the Arabic buttons at the bottom of the chat once.
    state.menu_users ||= [];
    if (!state.menu_users.includes(user)) {
      state.menu_users.push(user);
      await this.save();
      await this.telegram("sendMessage", { chat_id: chat, text: "👇 الأزرار دي تحت علشان تستخدم البوت بسهولة.",
        reply_markup: MENU }).catch(() => {});
    }

    if (fileId) return this.addPhoto(state, msg, fileId, asFile);
    const text = msg.text || "";
    const command = text.startsWith("/") ? text : arabicCommand(text);
    // After tapping 🪄, the next text (that isn't a button) is the change Gemini should make.
    if (state.guiding?.user === user && text.trim() && (!command || command === "/cancel")) {
      const id = state.guiding.id;
      state.guiding = null;
      await this.save();
      if (command === "/cancel") return this.send(chat, "تمام، الكلام زي ما هو.");
      return this.rewrite(state, chat, id, text.trim().slice(0, 300));
    }
    // After tapping ✏️, the next text (that isn't a button) is the new caption.
    if (state.editing?.user === user && text.trim() && (!command || command === "/cancel")) {
      const piece = state.pieces.find((p) => p.id === state.editing.id);
      state.editing = null;
      await this.save();
      if (command === "/cancel") return this.send(chat, "تمام، الكلام زي ما هو.");
      if (!piece) return this.send(chat, "البوست ده مبقاش موجود.");
      piece.caption = text.trim().slice(0, 1500);
      await this.save();
      return this.send(chat, `✏️ اتغير كلام بوست رقم ${piece.id}. دوس 👀 علشان تشوفه.`);
    }
    if (command) {
      try {
        await this.handleCommand(state, chat, command, user);
      } catch (e) {
        console.log(`Command failed: ${e.message}`);
        await this.send(chat, "في حاجة غلط، جرب تاني.");
      }
      return this.save();
    }
    if (text.trim()) {
      // Text from the worker, like "دبل خفيفة": Gemini puts it in this piece's caption.
      state.open ||= { count: null, photos: [], files: [], note: "", from: user, asked: true };
      addNote(state.open, msg.text);
      await this.save();
      return this.send(chat, `✍️ تمام، هضيف "${state.open.note}" لكلام البوست ده.`);
    }
    return this.send(chat, "ابعت صور القطعة، أو دوس ❓ مساعدة.");
  }

  // ---- "How many photos?" ----
  // Before each piece the bot asks how many photos it has. The next photos, up to that number, become one post.
  // state.open is the piece being collected: { count (null until chosen), photos, files, note, from, asked }.

  async askCount(chat, text = "📸 كام صورة للبوست الجاي؟") {
    const buttons = [1, 2, 3, 4, 5].map((n) => ({ text: String(n), callback_data: `count:${n}` }));
    try {
      await this.telegram("sendMessage", { chat_id: chat, text, reply_markup: { inline_keyboard: [buttons] } });
    } catch (e) {
      console.log(`Could not ask for the count: ${e.message}`);
    }
  }

  async handleButton(state, query) {
    const chat = query.message?.chat?.id;
    const count = Number((query.data || "").split(":")[1]);
    await this.telegram("answerCallbackQuery", { callback_query_id: query.id }).catch(() => {});
    if (!this.allowedUsers().includes(query.from.id) || !chat) return;
    const [action, arg] = (query.data || "").split(":");
    const id = Number(arg);
    const piece = state.pieces.find((p) => p.id === id);
    if (["rewrite", "preview", "edit", "guide", "delete", "delyes", "postask"].includes(action) && !piece) {
      return this.send(chat, `مفيش بوست رقم ${arg} دلوقتي.`);
    }
    if (action === "rewrite") return this.rewrite(state, chat, id);
    if (action === "guide") return this.askGuide(state, chat, query.from.id, piece);
    if (action === "preview") return this.preview(state, chat, piece);
    if (action === "postask") return this.askPostNow(chat, piece);
    if (action === "edit") {
      state.editing = { user: query.from.id, id };
      state.guiding = null;
      await this.save();
      return this.send(chat, `✏️ ابعت الكلام الجديد لبوست رقم ${id}.\n(أو دوس ❌ الغي الصور علشان تسيبه زي ما هو)`);
    }
    if (action === "delete") {
      return this.telegram("sendMessage", { chat_id: chat, text: `🗑 تمسح بوست رقم ${id}؟`,
        reply_markup: { inline_keyboard: [[{ text: "أيوه، امسحه", callback_data: `delyes:${id}` }]] } });
    }
    if (action === "delyes") {
      state.pieces.splice(state.pieces.indexOf(piece), 1);
      await this.save();
      return this.telegram("editMessageText", { chat_id: chat, message_id: query.message.message_id,
        text: `🗑 اتمسح بوست رقم ${id}.` }).catch(() => this.send(chat, `🗑 اتمسح بوست رقم ${id}.`));
    }
    if ((query.data || "").startsWith("postnow:")) {
      const id = Number(query.data.split(":")[1]);
      state.post_now = { id, chat };
      await this.save();
      await this.storage.setAlarm(this.now().ms);
      return this.telegram("editMessageText", { chat_id: chat, message_id: query.message.message_id,
        text: `⏳ بنشر بوست رقم ${id}…` }).catch(() => {});
    }
    if (query.data === "reset:yes") {
      // Empty the queue and start again from piece number 1.
      this.state = Object.assign(newState(), { day: state.day, posted_hours: state.posted_hours });
      await this.save();
      await this.telegram("editMessageText", { chat_id: chat, message_id: query.message.message_id,
        text: "🗑 اتمسحت كل البوستات. البوت بدأ من الأول." }).catch(() => {});
      return this.askCount(chat);
    }
    if (!(count >= 1 && count <= MAX_PHOTOS_PER_POST)) return;
    state.open ||= { count: null, photos: [], files: [], note: "", from: query.from.id, asked: true };
    state.open.count = count;
    await this.save();
    await this.telegram("editMessageText", {
      chat_id: chat, message_id: query.message.message_id, text: `📸 تمام، البوست ده ${count} صورة.`,
    }).catch(() => {});
    const left = count - state.open.photos.length;
    if (left <= 0) return this.finishPiece(state, chat);
    return this.send(chat, state.open.photos.length ? `فاضل ${left} صورة.` : `ابعت ${count} صورة دلوقتي 👇`);
  }

  async addPhoto(state, msg, fileId, asFile) {
    const chat = msg.chat.id;
    state.open ||= { count: null, photos: [], files: [], note: "", from: msg.from.id, asked: false };
    const open = state.open;
    if (!open.photos.includes(fileId)) {
      open.photos.push(fileId);
      if (asFile) open.files.push(fileId);
    }
    if (msg.caption) addNote(open, msg.caption);
    if (open.count === null) {
      // Photos came before the number was chosen: ask once, keep collecting.
      if (open.asked) return this.save();
      open.asked = true;
      await this.save();
      return this.askCount(chat, "📸 وصلت الصورة 👍 البوست ده كام صورة؟");
    }
    if (open.photos.length >= open.count) return this.finishPiece(state, chat);
    return this.save();
  }

  async finishPiece(state, chat) {
    // The piece has all its photos: put it in the queue, write the caption, tell the sender, ask for the next one.
    const open = state.open;
    const piece = {
      id: state.next_id++, photos: open.photos.slice(0, open.count), note: open.note, caption: null, from: open.from,
    };
    piece.files = open.files.filter((f) => piece.photos.includes(f));
    const extra = open.photos.slice(open.count);
    state.open = extra.length
      ? { count: null, photos: extra, files: open.files.filter((f) => extra.includes(f)), note: "", from: open.from, asked: false }
      : null;
    state.pieces.push(piece);
    // Gemini can take a while, longer than Telegram's message is allowed to wait, so the caption is
    // written in the background (a Durable Object alarm) and the answer is sent from there.
    state.to_caption = [...(state.to_caption || []), { id: piece.id, chat }];
    await this.save();
    await this.storage.setAlarm(this.now().ms);
    return this.send(chat, "⏳ استلمت الصور، بكتب الكلام…");
  }

  async backgroundWork() {
    // The Durable Object alarm: write captions for finished pieces, then any "post now".
    await this.writePendingCaptions();
    await this.postNowConfirmed(await this.load());
  }

  async writePendingCaptions() {
    // Runs in the background right after a piece is finished. If Gemini is busy, it tries again a few minutes
    // later (up to CAPTION_RETRIES times) before using a ready-made caption.
    const state = await this.load();
    const jobs = state.to_caption || [];
    state.to_caption = [];
    await this.save();
    let retryLater = false;
    for (const job of jobs) {
      const piece = state.pieces.find((p) => p.id === job.id);
      if (!piece) continue;
      if (!piece.caption) {
        const tries = (job.tries || 0) + 1;
        const giveUp = tries > CAPTION_RETRIES;
        const edit = job.instruction ? { base: job.old, instruction: job.instruction } : null;
        const ok = await this.writeCaption(piece, null, { fallback: giveUp && !job.old, edit });
        if (!ok && giveUp && job.old) piece.caption = job.old;    // rewrite failed: keep the old caption
        if (!ok && !piece.caption) {
          state.to_caption.push({ ...job, tries });
          await this.save();
          retryLater = true;
          if (tries === 1) await this.send(job.chat, "⏳ Gemini مشغول شوية دلوقتي، هكتب الكلام خلال دقايق.");
          continue;
        }
      }
      await this.save();
      const text = (job.rewrite ? `${job.instruction ? "🪄 عدلته زي ما قلت" : "🔄 ده كلام جديد"} لبوست رقم ${piece.id}:\n\n${piece.caption}` :
        `${this.cheer(piece.from)}\n\n` +
        `✅ بوست رقم ${piece.id} جاهز (${piece.photos.length} صورة)\n` +
        `🗓 هيتنشر ${pieceSchedule(state, this.now())[piece.id]}\n\n` +
        `📝 الكلام اللي هيتكتب:\n${piece.caption}`) +
        "";
      try {
        await this.telegram("sendMessage", { chat_id: job.chat, text: text.slice(0, 4000), reply_markup: { inline_keyboard: [
          [{ text: "🔄 كلام تاني من Gemini", callback_data: `rewrite:${piece.id}` },
            { text: "🪄 عدّل بـ Gemini", callback_data: `guide:${piece.id}` }],
          [{ text: "✏️ اكتب بإيدك", callback_data: `edit:${piece.id}` },
            { text: "👀 شوفه", callback_data: `preview:${piece.id}` },
            { text: "🗑 امسح", callback_data: `delete:${piece.id}` }],
        ] } });
      } catch (e) {
        await this.send(job.chat, text);
      }
      if (job.rewrite) continue;
      if (state.open?.photos.length && !state.open.count) {
        state.open.asked = true;
        await this.save();
        await this.askCount(job.chat, "📸 في صور زيادة وصلت. البوست الجاي كام صورة؟");
      } else if (!state.open && !job.preview) {
        await this.askCount(job.chat);
      }
    }
    if (retryLater) await this.storage.setAlarm(this.now().ms + CAPTION_RETRY_MINUTES * 60 * 1000);
  }

  async handleCommand(state, chat, text, user) {
    const [rawCommand, ...words] = text.trim().split(/\s+/);
    const command = rawCommand.split("@")[0].toLowerCase();
    const rest = text.trim().slice(rawCommand.length).trim();
    const now = this.now();
    const find = (n) => state.pieces.find((p) => String(p.id) === n);

    if (command === "/start" || command === "/help") {
      await this.telegram("sendMessage", { chat_id: chat, text: HELP, reply_markup: MENU }).catch(() => this.send(chat, HELP));
      if (!state.open) await this.askCount(chat);
      return;
    }

    if (command === "/rewrite") {
      const piece = rest ? find(rest) : state.pieces[0];
      if (!piece) {
        return this.send(chat, rest ? `مفيش بوست رقم ${rest}. دوس 📋 البوستات علشان تشوف الأرقام.` : "📭 مفيش بوستات مستنية دلوقتي.");
      }
      return this.rewrite(state, chat, piece.id);
    }

    if (command === "/postnow") {
      const piece = rest ? find(rest) : state.pieces[0];
      if (!piece) {
        return this.send(chat, state.pieces.length
          ? "مفيش بوست بالرقم ده. دوس 📋 البوستات علشان تشوف الأرقام." : "📭 مفيش بوستات مستنية دلوقتي.");
      }
      return this.askPostNow(chat, piece);
    }

    if (command === "/reset") {
      return this.telegram("sendMessage", { chat_id: chat,
        text: `⚠️ متأكد إنك عايز تمسح كل البوستات اللي مستنية (${state.pieces.length} بوست)؟`,
        reply_markup: { inline_keyboard: [[{ text: "أيوه، امسح كل حاجة", callback_data: "reset:yes" }]] } });
    }

    if (command === "/guide") {
      const piece = find(rest);
      if (!piece) return this.send(chat, `مفيش بوست رقم ${rest}. دوس 📋 البوستات علشان تشوف الأرقام.`);
      return this.askGuide(state, chat, user, piece);
    }

    if (command === "/cancel") {
      state.open = null;
      state.editing = null;
      state.guiding = null;
      await this.send(chat, "❌ اتلغت الصور اللي كانت لسه بتتبعت.");
      return this.askCount(chat);
    }

    if (command === "/list") {
      if (!state.pieces.length) return this.send(chat, "📭 مفيش بوستات مستنية دلوقتي. ابعت صور القطع هنا.");
      const times = pieceSchedule(state, now);
      const lines = [`🗂 البوستات اللي مستنية (${state.pieces.length}):`];
      for (const p of state.pieces) {
        const first = (p.caption || p.note || "").split("\n")[0].slice(0, 50);
        lines.push(`\nرقم ${p.id} – ${p.photos.length} صورة – ${times[p.id]}\n${first}`);
      }
      // A row of buttons for each post (Telegram allows up to 100 buttons, so at most 15 posts get them).
      const rows = state.pieces.slice(0, 14).flatMap((p) => [
        [{ text: `── بوست رقم ${p.id} ──`, callback_data: `preview:${p.id}` }],
        [{ text: "👀", callback_data: `preview:${p.id}` }, { text: "🔄", callback_data: `rewrite:${p.id}` },
          { text: "🪄", callback_data: `guide:${p.id}` }, { text: "✏️", callback_data: `edit:${p.id}` },
          { text: "🗑", callback_data: `delete:${p.id}` }, { text: "🚀", callback_data: `postask:${p.id}` }],
      ]);
      lines.push("\n👀 شوف · 🔄 كلام تاني · 🪄 عدّل بـ Gemini · ✏️ اكتب بإيدك · 🗑 امسح · 🚀 انشر دلوقتي");
      return this.telegram("sendMessage", { chat_id: chat, text: lines.join("\n").slice(0, 4000),
        reply_markup: { inline_keyboard: rows } }).catch(() => this.send(chat, lines.join("\n")));
    }

    if (command === "/delete") {
      const piece = find(rest);
      if (!piece) return this.send(chat, "اكتب رقم البوست، مثلاً: امسح 5\nدوس 📋 البوستات علشان تشوف الأرقام.");
      state.pieces.splice(state.pieces.indexOf(piece), 1);
      return this.send(chat, `🗑 اتمسح بوست رقم ${piece.id}.`);
    }

    if (command === "/caption") {
      const piece = find(words[0] || "");
      const newText = rest.slice((words[0] || "").length).trim();
      if (!piece || !newText) return this.send(chat, "دوس ✏️ تحت البوست في 📋 البوستات، وابعت الكلام الجديد.");
      piece.caption = newText.slice(0, 1500);
      return this.send(chat, `✏️ اتغير كلام بوست رقم ${piece.id}.`);
    }

    if (command === "/preview") {
      if (!state.pieces.length) return this.send(chat, "📭 مفيش بوستات مستنية دلوقتي.");
      const piece = rest ? find(rest) : state.pieces[0];
      if (!piece) return this.send(chat, `مفيش بوست رقم ${rest}.`);
      return this.preview(state, chat, piece);
    }

    return this.send(chat, "مش فاهم ده 🙂 دوس ❓ مساعدة.");
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
    // Safety net: any post still without a caption (and not already waiting for one) gets another try.
    const waiting = new Set((state.to_caption || []).map((t) => t.id));
    const missing = state.pieces.filter((p) => !p.caption && !waiting.has(p.id));
    if (missing.length) {
      state.to_caption = [...(state.to_caption || []), ...missing.map((p) => ({ id: p.id, chat: p.from, tries: 1 }))];
      await this.save();
      await this.storage.setAlarm(this.now().ms);
    }
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
      return this.tellEveryone(`⚠️ كان المفروض يتنشر بوست الساعة ${slot % 12 || 12}، بس مفيش بوستات جاهزة.\n` +
        "📸 ابعت صور القطع هنا.");
    }
    const piece = state.pieces[0];
    try {
      await this.publish(state, piece, () => state.posted_hours.push(slot));
    } catch (e) {
      console.log(`Posting piece ${piece.id} failed: ${e.message}`);
      const slotName = `${now.date} ${slot}`;
      if (state.failed_slot !== slotName) {          // tell people once, then keep trying quietly
        state.failed_slot = slotName;
        await this.tellEveryone(`❌ حصلت مشكلة في نشر بوست رقم ${piece.id}. هحاول تاني كمان شوية.\n${e.message.slice(0, 200)}`);
      }
    }
  }

  async publish(state, piece, markDone = () => {}) {
    // Posts one piece (or, in TEST MODE, shows it on Telegram), takes it out of the queue and tells everyone.
    if (!piece.caption) await this.writeCaption(piece);
    const testMode = !this.env.FB_PAGE_TOKEN;
    let postId = null;
    let photos = null;
    if (!testMode) {
      photos = await this.postPhotos(piece);
      postId = await this.postToFacebook(photos, fullCaption(piece));
    }
    state.pieces.splice(state.pieces.indexOf(piece), 1);
    markDone();
    await this.save();                                 // save right away, so it never posts twice
    if (testMode) {
      for (const user of this.allowedUsers()) {
        await this.sendPreview(user, piece,
          `🧪 تجربة – ده البوست اللي كان هيتنشر دلوقتي على الصفحة (بوست رقم ${piece.id}). ما اتنشرش على الفيسبوك.`);
        if (STORIES_ON) await this.sendStoryPreview(user, piece);
      }
      return;
    }
    console.log(`Posted piece ${piece.id}: ${postId}`);
    let storyNote = "";
    if (STORIES_ON) try {
      const n = await this.postStories(photos);
      storyNote = `\n📲 واتنشر كمان في الستوري (${n}).`;
    } catch (e) {
      console.log(`Stories failed: ${e.message}`);
      storyNote = "\n⚠️ البوست اتنشر، بس الستوري ما اتنشرش.";
    }
    await this.tellEveryone(`✅ اتنشر بوست رقم ${piece.id} على الصفحة.${storyNote}\nفاضل: ${state.pieces.length} بوست جاهز.`);
  }

  async sendStoryPreview(chat, piece) {
    // TEST MODE: show the story pictures too, so you can see how they'll look.
    try {
      const photos = (await this.postPhotos(piece)).slice(0, MAX_STORIES_PER_POST);
      for (const [i, photo] of photos.entries()) {
        const form = new FormData();
        form.append("chat_id", String(chat));
        form.append("caption", `🧪 وده الستوري ${photos.length > 1 ? `(${i + 1} من ${photos.length})` : ""}`.trim());
        form.append("photo", new Blob([await this.storyImage(photo)], { type: "image/jpeg" }), "story.jpg");
        await this.telegramForm("sendPhoto", form);
      }
    } catch (e) {
      console.log(`Could not send the story preview: ${e.message}`);
    }
  }

  async preview(state, chat, piece) {
    if (!piece.caption) {
      // Write it in the background first (Gemini can be slow), then the user asks again.
      if (!(state.to_caption || []).some((t) => t.id === piece.id)) {
        state.to_caption = [...(state.to_caption || []), { id: piece.id, chat, preview: true }];
        await this.save();
        await this.storage.setAlarm(this.now().ms);
      }
      return this.send(chat, "⏳ بكتب كلام البوست ده… دوس 👀 تاني بعد دقيقة.");
    }
    const when = pieceSchedule(state, this.now())[piece.id];
    return this.sendPreview(chat, piece, `👀 بوست رقم ${piece.id} – ${when}:`);
  }

  askPostNow(chat, piece) {
    return this.telegram("sendMessage", { chat_id: chat,
      text: `🚀 تنشر بوست رقم ${piece.id} دلوقتي على الصفحة؟\n(ده مش هيلغي بوستات الساعة 3 و10)`,
      reply_markup: { inline_keyboard: [[{ text: "✅ أيوه، انشره دلوقتي", callback_data: `postnow:${piece.id}` }]] } });
  }

  async rewrite(state, chat, id, instruction = null) {
    // Ask Gemini for a new caption (in the background); the old one is kept until the new one is ready.
    // With an instruction ("خليه أقصر"), Gemini edits the current caption the way it's asked.
    const piece = state.pieces.find((p) => p.id === id);
    if (!piece) return this.send(chat, `مفيش بوست رقم ${id} في الطابور.`);
    if (!instruction) state.recent = [piece.caption, ...(state.recent || [])].filter(Boolean).slice(0, 6);   // write something different
    const old = piece.caption || (state.to_caption || []).find((t) => t.id === id)?.old || null;
    state.to_caption = [...(state.to_caption || []).filter((t) => t.id !== id), { id, chat, rewrite: true, old, instruction }];
    piece.caption = null;
    await this.save();
    await this.storage.setAlarm(this.now().ms);
    return this.send(chat, instruction ? `🪄 تمام، بعدل كلام بوست رقم ${id}…` : `⏳ بكتب كلام جديد لبوست رقم ${id}…`);
  }

  async askGuide(state, chat, user, piece) {
    state.guiding = { user, id: piece.id };
    state.editing = null;
    await this.save();
    return this.send(chat, `🪄 قول لـ Gemini يغير إيه في كلام بوست رقم ${piece.id}.\n` +
      "مثلاً: خليه أقصر – اذكر إنه هدية – من غير إيموجي – ركز على إن الوزن خفيف\n(أو دوس ❌ الغي الصور علشان تسيبه)");
  }

  async postNowConfirmed(state) {
    // Runs in the background (alarm) after the "post now" button, because posting can take a while.
    const job = state.post_now;
    if (!job) return;
    state.post_now = null;
    await this.save();
    const piece = state.pieces.find((p) => p.id === job.id);
    if (!piece) return this.send(job.chat, `مفيش بوست رقم ${job.id} في الطابور.`);
    try {
      await this.publish(state, piece);
    } catch (e) {
      console.log(`Post now failed: ${e.message}`);
      await this.send(job.chat, `❌ حصلت مشكلة في نشر بوست رقم ${piece.id}. جرب تاني.\n${e.message.slice(0, 200)}`);
    }
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
      `جاهز ${state.pieces.length} بوست بس، ومحتاجين ${missing} بوست كمان.\n` +
      "📸 ابعت صور القطع هنا.");
  }
}
