// Entry point on Cloudflare. All the work happens in one Durable Object ("Bot"), so messages are
// handled one at a time and the queue is stored safely. See core.js for what the bot does.

import { DurableObject } from "cloudflare:workers";
import { BotCore } from "./core.js";
import logo from "../assets/logo.png";

export class Bot extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const storage = {
      get: (key) => ctx.storage.get(key),
      put: (key, value) => ctx.storage.put(key, value),
      setAlarm: (ms) => ctx.storage.setAlarm(ms),
    };
    this.core = new BotCore(storage, env, undefined, undefined, logo);
  }

  handleUpdate(update) {
    return this.core.handleUpdate(update);
  }

  tick() {
    return this.core.tick();
  }

  alarm() {
    return this.core.backgroundWork();   // captions for finished pieces and "post now", in the background
  }
}

function bot(env) {
  return env.BOT.get(env.BOT.idFromName("main"));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Telegram sends every new message here. The secret header proves it's really Telegram.
    if (request.method === "POST" && url.pathname === "/telegram") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      const update = await request.json();
      // Handled before answering Telegram. It's quick: slow work (Gemini) runs later in the alarm.
      try {
        await bot(env).handleUpdate(update);
      } catch (e) {
        console.log(`Update failed: ${e.message}`);
      }
      return new Response("ok");
    }

    // Opening /setup once tells Telegram to send messages to this Worker.
    if (url.pathname === "/setup") {
      const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: `${url.origin}/telegram`, secret_token: env.WEBHOOK_SECRET,
          allowed_updates: ["message", "callback_query"], drop_pending_updates: true,
        }),
      });
      const result = await res.json();
      return new Response(result.ok ? "✅ Telegram is connected to the bot." : `❌ ${result.description}`,
        { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }

    // /status shows whether Telegram can reach the bot (no private data).
    if (url.pathname === "/status") {
      const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getWebhookInfo`);
      const { result = {} } = await res.json();
      return Response.json({
        connected: result.url === `${url.origin}/telegram`,
        waiting_messages: result.pending_update_count,
        last_error: result.last_error_message || null,
        last_error_at: result.last_error_date ? new Date(result.last_error_date * 1000).toISOString() : null,
      });
    }

    return new Response("مجوهرات السلام", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(bot(env).tick());
  },
};
