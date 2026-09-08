export class CinemaRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const url = new URL(request.url);
    const name = (url.searchParams.get("name") || "Guest").slice(0, 40);
    const role = url.searchParams.get("role") === "host" ? "host" : "viewer";
    const id = crypto.randomUUID();

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    const peers = this.ctx.getWebSockets().map((ws) => {
      try { return ws.deserializeAttachment(); } catch { return null; }
    }).filter(Boolean);

    server.serializeAttachment({ id, name, role });
    this.ctx.acceptWebSocket(server);

    server.send(JSON.stringify({
      type: "welcome",
      id,
      peers
    }));

    this.broadcast({
      type: "peer:joined",
      peer: { id, name, role }
    }, id);

    this.broadcastCount();

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  webSocketMessage(ws, message) {
    let meta;
    try { meta = ws.deserializeAttachment(); } catch { return; }

    let data;
    try {
      data = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
    } catch {
      return;
    }

    if (data.type === "signal" && data.to) {
      for (const other of this.ctx.getWebSockets()) {
        let om;
        try { om = other.deserializeAttachment(); } catch { continue; }
        if (om?.id === data.to) {
          other.send(JSON.stringify({
            type: "signal",
            from: meta.id,
            data: data.data
          }));
          break;
        }
      }
      return;
    }

    if (data.type === "chat") {
      const text = String(data.text || "").trim().slice(0, 1200);
      if (!text) return;
      this.broadcast({
        type: "chat",
        from: meta.id,
        name: meta.name,
        text,
        at: Date.now()
      });
      return;
    }

    if (data.type === "reaction") {
      const allowed = new Set(["❤️", "😂", "😮", "🥹", "👏", "🔥"]);
      if (!allowed.has(data.emoji)) return;
      this.broadcast({
        type: "reaction",
        from: meta.id,
        emoji: data.emoji
      }, meta.id);
      return;
    }

    if (data.type === "host:status" && meta.role === "host") {
      this.broadcast({
        type: "host:status",
        sharing: !!data.sharing
      }, meta.id);
    }
  }

  webSocketClose(ws) {
    let meta;
    try { meta = ws.deserializeAttachment(); } catch { meta = null; }

    if (meta) {
      this.broadcast({
        type: "peer:left",
        peer: meta
      }, meta.id);
    }
    this.broadcastCount();
  }

  webSocketError(ws) {
    try { ws.close(1011, "WebSocket error"); } catch {}
  }

  broadcast(payload, exceptId = null) {
    const text = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      let meta;
      try { meta = ws.deserializeAttachment(); } catch { meta = null; }
      if (exceptId && meta?.id === exceptId) continue;
      try { ws.send(text); } catch {}
    }
  }

  broadcastCount() {
    this.broadcast({
      type: "room:count",
      count: this.ctx.getWebSockets().length
    });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      const room = (url.searchParams.get("room") || "").trim().slice(0, 80);
      if (!room) return new Response("Missing room", { status: 400 });

      const id = env.ROOMS.idFromName(room);
      const stub = env.ROOMS.get(id);
      return stub.fetch(request);
    }

    // Optional Cloudflare Realtime TURN credentials.
    // Add TURN_KEY_ID and TURN_KEY_API_TOKEN as Worker secrets.
    if (url.pathname === "/api/turn") {
      if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) {
        return Response.json({
          enabled: false,
          iceServers: [
            { urls: ["stun:stun.cloudflare.com:3478"] }
          ]
        });
      }

      const resp = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.TURN_KEY_API_TOKEN}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ ttl: 21600 })
        }
      );

      if (!resp.ok) {
        return Response.json({
          enabled: false,
          error: `TURN API returned ${resp.status}`,
          iceServers: [
            { urls: ["stun:stun.cloudflare.com:3478"] }
          ]
        }, { status: 200 });
      }

      const payload = await resp.json();

      // Browsers often block/timeout on port 53, so remove those URLs.
      if (Array.isArray(payload.iceServers)) {
        for (const server of payload.iceServers) {
          const arr = Array.isArray(server.urls) ? server.urls : [server.urls];
          server.urls = arr.filter((u) => !String(u).includes(":53"));
        }
      }

      return Response.json({
        enabled: true,
        iceServers: payload.iceServers
      });
    }

    return env.ASSETS.fetch(request);
  }
};
