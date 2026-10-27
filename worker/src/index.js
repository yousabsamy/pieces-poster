// Entry point on Cloudflare. All the work happens in one Durable Object ("Bot"), so messages are
// handled one at a time and the queue is stored safely. See core.js for what the bot does.

import { DurableObject } from "cloudflare:workers";
import { BotCore } from "./core.js";

export class Bot extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const storage = {
      get: (key) => ctx.storage.get(key),
      put: (key, value) => ctx.storage.put(key, value),
      setAlarm: (ms) => ctx.storage.setAlarm(ms),
    };
    this.core = new BotCore(storage, env);
  }

  handleUpdate(update) {
    return this.core.handleUpdate(update);
  }

  tick() {
    return this.core.tick();
  }

  alarm() {
    return this.core.albumDone();
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
      ctx.waitUntil(bot(env).handleUpdate(update).catch((e) => console.log(`Update failed: ${e.message}`)));
      return new Response("ok");
    }

    // Opening /setup once tells Telegram to send messages to this Worker.
    if (url.pathname === "/setup") {
      const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: `${url.origin}/telegram`, secret_token: env.WEBHOOK_SECRET,
          allowed_updates: ["message"], drop_pending_updates: true,
        }),
      });
      const result = await res.json();
      return new Response(result.ok ? "✅ Telegram is connected to the bot." : `❌ ${result.description}`,
        { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }

    return new Response("مجوهرات السلام", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(bot(env).tick());
  },
};
