import { jsonResponse, readJson, safeText } from "./security.js";

export class CinemaDirectory {
  constructor(ctx) {
    this.ctx = ctx;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const rooms = (await this.ctx.storage.get("rooms")) || {};

    if (request.method === "GET") {
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const items = Object.values(rooms)
        .filter((room) => room.createdAt >= cutoff)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 50);
      return jsonResponse({ rooms: items });
    }

    if (request.method === "POST" && url.pathname === "/upsert") {
      const body = await readJson(request, 16384);
      if (!body.id) return jsonResponse({ error: "Missing room id" }, { status: 400 });
      rooms[body.id] = {
        id: safeText(body.id, 80),
        title: safeText(body.title, 100) || "Private screening",
        createdAt: Number(body.createdAt) || Date.now(),
        expiresAt: Number(body.expiresAt) || Date.now(),
        status: ["open", "locked", "ended"].includes(body.status) ? body.status : "open",
        people: Math.max(0, Number(body.people) || 0),
      };
      const ordered = Object.values(rooms).sort((a, b) => b.createdAt - a.createdAt).slice(0, 100);
      await this.ctx.storage.put("rooms", Object.fromEntries(ordered.map((room) => [room.id, room])));
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ error: "Not found" }, { status: 404 });
  }
}

export class AuthRateLimiter {
  constructor(ctx) {
    this.ctx = ctx;
  }

  async fetch(request) {
    const now = Date.now();
    const state = (await this.ctx.storage.get("state")) || { failures: [], blockedUntil: 0 };
    state.failures = state.failures.filter((time) => now - time < 15 * 60 * 1000);

    if (request.method === "GET") {
      const retryAfter = Math.max(0, Math.ceil((state.blockedUntil - now) / 1000));
      return jsonResponse({ allowed: retryAfter === 0, retryAfter });
    }

    if (request.method === "POST") {
      const body = await readJson(request, 1024);
      if (body.success) {
        await this.ctx.storage.delete("state");
        return jsonResponse({ ok: true });
      }
      state.failures.push(now);
      if (state.failures.length >= 5) state.blockedUntil = now + 15 * 60 * 1000;
      await this.ctx.storage.put("state", state);
      return jsonResponse({ ok: true, blockedUntil: state.blockedUntil });
    }

    return jsonResponse({ error: "Method not allowed" }, { status: 405 });
  }
}
