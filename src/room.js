import {
  base64UrlDecode,
  HttpError,
  jsonResponse,
  randomToken,
  readJson,
  safeText,
  signToken,
} from "./security.js";
import { createRealtimeSession, generateIceServers, realtimeRequest } from "./sfu.js";

const textDecoder = new TextDecoder();
const ALLOWED_REACTIONS = new Set(["❤️", "😂", "🥹", "😍", "👏", "🔥"]);

function claimsFromRequest(request) {
  try {
    const encoded = request.headers.get("X-Cinema-Claims");
    return encoded ? JSON.parse(textDecoder.decode(base64UrlDecode(encoded))) : null;
  } catch {
    return null;
  }
}

function socketMeta(socket) {
  try {
    return socket.deserializeAttachment();
  } catch {
    return null;
  }
}

export class CinemaRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.room = null;
    this.ready = ctx.blockConcurrencyWhile(async () => {
      this.room = (await ctx.storage.get("room")) || null;
    });
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    try {
      if (url.pathname === "/internal/create" && request.method === "POST") return this.createRoom(request);
      if (url.pathname === "/internal/ticket" && request.method === "POST") return this.createTicket(request);
      if (url.pathname === "/internal/ws") return this.openSocket(request);
      if (url.pathname === "/internal/status" && request.method === "GET") return this.getStatus(request);
      if (url.pathname.startsWith("/internal/control/")) return this.control(request, url.pathname.split("/").pop());
      if (url.pathname.startsWith("/internal/media/")) return this.media(request, url.pathname.split("/").pop());
      return jsonResponse({ error: "Not found" }, { status: 404 });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const code = error instanceof HttpError ? error.code : "internal_error";
      if (!(error instanceof HttpError)) console.error("CinemaRoom error", error);
      return jsonResponse({ error: error.message || "Unexpected error", code }, { status });
    }
  }

  ensureRoomAvailable() {
    if (!this.room) throw new HttpError(404, "Room not found", "room_not_found");
    if (this.room.endedAt) throw new HttpError(410, "This screening has ended", "room_ended");
    if (this.room.expiresAt <= Date.now()) throw new HttpError(410, "This invitation has expired", "room_expired");
  }

  assertClaim(claims, roles = ["viewer", "host", "owner"]) {
    this.ensureRoomAvailable();
    if (!claims || claims.room !== this.room.id || !roles.includes(claims.role)) {
      throw new HttpError(403, "You are not allowed to do that", "forbidden");
    }
    if (claims.role === "owner") return;
    const invite = this.room.invites?.[claims.jti];
    if (!invite || invite.revokedAt || invite.expiresAt <= Date.now() || invite.role !== claims.role) {
      throw new HttpError(403, "This invitation is no longer valid", "invite_invalid");
    }
  }

  async persist() {
    await this.ctx.storage.put("room", this.room);
  }

  async directoryUpdate() {
    if (!this.room || !this.env.DIRECTORY) return;
    const id = this.env.DIRECTORY.idFromName("main");
    const stub = this.env.DIRECTORY.get(id);
    const payload = {
      id: this.room.id,
      title: this.room.title,
      createdAt: this.room.createdAt,
      expiresAt: this.room.expiresAt,
      status: this.room.endedAt ? "ended" : this.room.locked ? "locked" : "open",
      people: this.ctx.getWebSockets().length,
    };
    await stub.fetch("https://directory/upsert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  async createRoom(request) {
    if (this.room && !this.room.endedAt && this.room.expiresAt > Date.now()) {
      throw new HttpError(409, "Room already exists", "room_exists");
    }
    const claims = claimsFromRequest(request);
    if (claims?.role !== "owner") throw new HttpError(403, "Owner access required", "forbidden");
    const body = await readJson(request, 16384);
    const now = Date.now();
    const hours = Math.max(1, Math.min(168, Number(body.expiresInHours) || 24));
    this.room = {
      schema: 2,
      id: safeText(body.roomId, 80),
      title: safeText(body.title, 100) || "Private screening",
      createdAt: now,
      expiresAt: now + hours * 60 * 60 * 1000,
      endedAt: null,
      locked: false,
      invites: {},
      bannedClients: {},
      admittedClients: {},
      activeMedia: null,
      pendingMedia: null,
    };
    const host = await this.issueInvite("host", "Owner", hours);
    const viewer = await this.issueInvite("viewer", "Guests", hours);
    await this.persist();
    await this.directoryUpdate();
    return jsonResponse({ room: this.publicState(), host, viewer });
  }

  async issueInvite(role, label, requestedHours) {
    const now = Date.now();
    const hours = Math.max(1, Math.min(168, Number(requestedHours) || 24));
    const expiresAt = Math.min(this.room.expiresAt, now + hours * 60 * 60 * 1000);
    const jti = randomToken(18);
    const invite = {
      id: jti,
      role: role === "host" ? "host" : "viewer",
      label: safeText(label, 60) || (role === "host" ? "Guest host" : "Guest"),
      createdAt: now,
      expiresAt,
      revokedAt: null,
    };
    this.room.invites[jti] = invite;
    const token = await signToken(
      {
        typ: "invite",
        room: this.room.id,
        jti,
        role: invite.role,
        exp: Math.floor(expiresAt / 1000),
      },
      this.env.APP_AUTH_SECRET,
    );
    return { ...invite, token };
  }

  publicState() {
    return {
      id: this.room.id,
      title: this.room.title,
      createdAt: this.room.createdAt,
      expiresAt: this.room.expiresAt,
      locked: this.room.locked,
      ended: Boolean(this.room.endedAt),
      sharing: Boolean(this.room.activeMedia),
    };
  }

  async createTicket(request) {
    const claims = claimsFromRequest(request);
    this.assertClaim(claims);
    const body = await readJson(request, 8192);
    const clientId = safeText(body.clientId, 100);
    const name = safeText(body.name, 40) || "Guest";
    if (!clientId) throw new HttpError(400, "Missing client ID", "missing_client_id");

    this.pruneBans();
    this.pruneAdmissions();
    if (this.room.bannedClients[clientId] > Date.now()) {
      throw new HttpError(403, "This device was removed from the room", "client_banned");
    }
    const alreadyConnected = this.ctx.getWebSockets().some((socket) => socketMeta(socket)?.clientId === clientId);
    const alreadyAdmitted = this.room.admittedClients?.[clientId]?.inviteId === claims.jti;
    if (this.room.locked && claims.role === "viewer" && !alreadyConnected && !alreadyAdmitted) {
      throw new HttpError(423, "The host has locked this screening", "room_locked");
    }

    if (!alreadyAdmitted) {
      this.room.admittedClients ||= {};
      this.room.admittedClients[clientId] = {
        inviteId: claims.jti,
        expiresAt: Math.min(this.room.expiresAt, Number(claims.exp) * 1000),
      };
      await this.persist();
    }

    const ticket = randomToken(24);
    await this.ctx.storage.put(`ticket:${ticket}`, {
      claims,
      clientId,
      name,
      expiresAt: Date.now() + 60_000,
    });
    return jsonResponse({ ticket, room: this.publicState() });
  }

  async openSocket(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      throw new HttpError(426, "Expected WebSocket", "upgrade_required");
    }
    this.ensureRoomAvailable();
    const url = new URL(request.url);
    const ticketId = safeText(url.searchParams.get("ticket"), 120);
    const ticket = ticketId ? await this.ctx.storage.get(`ticket:${ticketId}`) : null;
    if (!ticket || ticket.expiresAt <= Date.now()) throw new HttpError(403, "Connection ticket expired", "ticket_expired");
    await this.ctx.storage.delete(`ticket:${ticketId}`);
    this.assertClaim(ticket.claims);

    for (const oldSocket of this.ctx.getWebSockets()) {
      const old = socketMeta(oldSocket);
      if (old?.clientId === ticket.clientId) {
        try {
          oldSocket.close(4000, "Replaced by a newer connection");
        } catch {}
      }
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const meta = {
      id: randomToken(12),
      clientId: ticket.clientId,
      inviteId: ticket.claims.jti,
      role: ticket.claims.role,
      name: ticket.name,
      joinedAt: Date.now(),
      rate: {},
      quality: null,
    };
    server.serializeAttachment(meta);
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({
      type: "welcome",
      id: meta.id,
      role: meta.role,
      room: this.publicState(),
      participants: this.participants(),
      media: this.room.activeMedia ? this.mediaAnnouncement() : null,
    }));
    this.broadcast({ type: "peer:joined", eventId: crypto.randomUUID(), peer: this.publicParticipant(meta) }, meta.id);
    this.broadcastPresence();
    this.ctx.waitUntil(this.directoryUpdate());
    return new Response(null, { status: 101, webSocket: client });
  }

  publicParticipant(meta) {
    return {
      id: meta.id,
      name: meta.name,
      role: meta.role,
      joinedAt: meta.joinedAt,
      quality: meta.quality || null,
    };
  }

  participants() {
    return this.ctx.getWebSockets().map(socketMeta).filter(Boolean).map((meta) => this.publicParticipant(meta));
  }

  broadcastPresence() {
    this.broadcast({ type: "room:presence", participants: this.participants() });
  }

  mediaAnnouncement() {
    const media = this.room.activeMedia;
    return media ? { version: media.version, broadcasterName: media.broadcasterName, startedAt: media.startedAt } : null;
  }

  consumeSocketRate(socket, meta, key, limit, windowMs) {
    const now = Date.now();
    const bucket = meta.rate?.[key] || { startedAt: now, count: 0 };
    if (now - bucket.startedAt > windowMs) {
      bucket.startedAt = now;
      bucket.count = 0;
    }
    bucket.count += 1;
    meta.rate = { ...(meta.rate || {}), [key]: bucket };
    socket.serializeAttachment(meta);
    return bucket.count <= limit;
  }

  webSocketMessage(socket, message) {
    const meta = socketMeta(socket);
    if (!meta) return;
    let data;
    try {
      data = JSON.parse(typeof message === "string" ? message : textDecoder.decode(message));
    } catch {
      return;
    }

    if (data.type === "chat") {
      if (!this.consumeSocketRate(socket, meta, "chat", 8, 10_000)) return;
      const text = safeText(data.text, 1200);
      if (!text) return;
      this.broadcast({
        type: "chat",
        eventId: crypto.randomUUID(),
        from: meta.id,
        name: meta.name,
        text,
        at: Date.now(),
      });
      return;
    }

    if (data.type === "reaction") {
      if (!this.consumeSocketRate(socket, meta, "reaction", 8, 10_000)) return;
      if (!ALLOWED_REACTIONS.has(data.emoji)) return;
      this.broadcast({ type: "reaction", eventId: crypto.randomUUID(), from: meta.id, emoji: data.emoji }, meta.id);
      return;
    }

    if (data.type === "quality:report") {
      if (!this.consumeSocketRate(socket, meta, "quality", 1, 3_000)) return;
      meta.quality = this.sanitizeQuality(data.quality);
      socket.serializeAttachment(meta);
      const update = { type: "quality:update", participant: this.publicParticipant(meta) };
      for (const peer of this.ctx.getWebSockets()) {
        const peerMeta = socketMeta(peer);
        if (peerMeta?.role === "host" || peerMeta?.id === meta.id) {
          try { peer.send(JSON.stringify(update)); } catch {}
        }
      }
    }
  }

  sanitizeQuality(value) {
    const quality = value && typeof value === "object" ? value : {};
    const number = (item, max) => Math.max(0, Math.min(max, Number(item) || 0));
    return {
      state: ["excellent", "good", "fair", "poor", "connecting", "offline"].includes(quality.state) ? quality.state : "connecting",
      route: quality.route === "turn" ? "turn" : "direct",
      transport: ["udp", "tcp", "tls", "unknown"].includes(quality.transport) ? quality.transport : "unknown",
      bitrateKbps: number(quality.bitrateKbps, 100_000),
      packetLoss: number(quality.packetLoss, 100),
      rttMs: number(quality.rttMs, 60_000),
      jitterMs: number(quality.jitterMs, 60_000),
      width: number(quality.width, 16_384),
      height: number(quality.height, 16_384),
      fps: number(quality.fps, 240),
    };
  }

  async webSocketClose(socket) {
    const meta = socketMeta(socket);
    if (!meta) return;
    const replacement = this.ctx.getWebSockets().some((other) => {
      const candidate = socketMeta(other);
      return candidate?.clientId === meta.clientId && candidate?.id !== meta.id;
    });
    if (!replacement) {
      await this.ctx.storage.delete(`session:${meta.clientId}`);
      await this.ctx.storage.delete(`turn:${meta.clientId}`);
      this.broadcast({ type: "peer:left", eventId: crypto.randomUUID(), peer: this.publicParticipant(meta) }, meta.id);
      if (this.room?.activeMedia?.publisherClientId === meta.clientId || this.room?.pendingMedia?.publisherClientId === meta.clientId) {
        await this.stopMedia(meta.clientId, true);
      }
    }
    this.broadcastPresence();
    this.ctx.waitUntil(this.directoryUpdate());
  }

  webSocketError(socket) {
    try { socket.close(1011, "WebSocket error"); } catch {}
  }

  broadcast(payload, exceptId = null) {
    const encoded = JSON.stringify(payload);
    for (const socket of this.ctx.getWebSockets()) {
      const meta = socketMeta(socket);
      if (exceptId && meta?.id === exceptId) continue;
      try { socket.send(encoded); } catch {}
    }
  }

  activeSocketFor(clientId) {
    for (const socket of this.ctx.getWebSockets()) {
      const meta = socketMeta(socket);
      if (meta?.clientId === clientId) return { socket, meta };
    }
    return null;
  }

  consumeHttpRate(clientId, key, limit, windowMs) {
    const active = this.activeSocketFor(clientId);
    if (!active) throw new HttpError(409, "Join the room before using media", "not_connected");
    if (!this.consumeSocketRate(active.socket, active.meta, key, limit, windowMs)) {
      throw new HttpError(429, "Too many requests; wait a moment", "rate_limited");
    }
    return active.meta;
  }

  async getStatus(request) {
    const claims = claimsFromRequest(request);
    this.assertClaim(claims);
    return jsonResponse({ room: this.publicState(), participants: this.participants(), media: this.mediaAnnouncement() });
  }

  async control(request, action) {
    const claims = claimsFromRequest(request);
    this.assertClaim(claims, ["host", "owner"]);
    const body = request.method === "POST" ? await readJson(request, 16384) : {};

    if (action === "invite" && request.method === "POST") {
      const invite = await this.issueInvite(body.role, body.label, body.expiresInHours);
      await this.persist();
      return jsonResponse({ invite });
    }
    if (action === "invites" && request.method === "GET") {
      return jsonResponse({ invites: Object.values(this.room.invites).sort((a, b) => b.createdAt - a.createdAt) });
    }
    if (action === "lock" && request.method === "POST") {
      this.room.locked = Boolean(body.locked);
      await this.persist();
      this.broadcast({ type: "room:lock", locked: this.room.locked });
      await this.directoryUpdate();
      return jsonResponse({ room: this.publicState() });
    }
    if (action === "kick" && request.method === "POST") {
      const participantId = safeText(body.participantId, 80);
      for (const socket of this.ctx.getWebSockets()) {
        const meta = socketMeta(socket);
        if (meta?.id === participantId && meta.role !== "host") {
          this.room.bannedClients[meta.clientId] = Date.now() + 60 * 60 * 1000;
          delete this.room.admittedClients?.[meta.clientId];
          await this.persist();
          try { socket.close(4003, "Removed by host"); } catch {}
          return jsonResponse({ ok: true });
        }
      }
      throw new HttpError(404, "Participant not found", "participant_not_found");
    }
    if (action === "revoke" && request.method === "POST") {
      const inviteId = safeText(body.inviteId, 80);
      const invite = this.room.invites[inviteId];
      if (!invite) throw new HttpError(404, "Invitation not found", "invite_not_found");
      invite.revokedAt = Date.now();
      for (const [clientId, admission] of Object.entries(this.room.admittedClients || {})) {
        if (admission.inviteId === inviteId) delete this.room.admittedClients[clientId];
      }
      await this.persist();
      for (const socket of this.ctx.getWebSockets()) {
        if (socketMeta(socket)?.inviteId === inviteId) {
          try { socket.close(4003, "Invitation revoked"); } catch {}
        }
      }
      return jsonResponse({ ok: true });
    }
    if (action === "end" && request.method === "POST") {
      await this.stopMedia(null, true);
      this.room.endedAt = Date.now();
      await this.persist();
      this.broadcast({ type: "room:ended" });
      for (const socket of this.ctx.getWebSockets()) {
        try { socket.close(4004, "Screening ended"); } catch {}
      }
      await this.directoryUpdate();
      return jsonResponse({ ok: true });
    }
    throw new HttpError(404, "Unknown control action", "not_found");
  }

  async media(request, action) {
    const claims = claimsFromRequest(request);
    this.assertClaim(claims);
    const body = request.method === "POST" || request.method === "PUT" ? await readJson(request) : {};
    const clientId = safeText(request.headers.get("X-Cinema-Client"), 100);
    const meta = this.consumeHttpRate(clientId, "media", 30, 60_000);
    if (meta.inviteId !== claims.jti || meta.role !== claims.role) throw new HttpError(403, "Session identity mismatch", "forbidden");

    if (action === "ice" && request.method === "POST") {
      const cached = await this.ctx.storage.get(`turn:${clientId}`);
      if (cached?.expiresAt > Date.now() + 5 * 60 * 1000) return jsonResponse(cached);
      const ice = await generateIceServers(this.env, `room:${this.room.id.slice(0, 24)}:client:${clientId.slice(0, 32)}`);
      await this.ctx.storage.put(`turn:${clientId}`, ice);
      return jsonResponse(ice);
    }

    if (action === "session" && request.method === "POST") {
      const session = await createRealtimeSession(this.env, `${this.room.id.slice(0, 24)}:${clientId.slice(0, 32)}`);
      await this.ctx.storage.put(`session:${clientId}`, { id: session.sessionId, createdAt: Date.now() });
      return jsonResponse({ sessionId: session.sessionId });
    }

    const storedSession = await this.ctx.storage.get(`session:${clientId}`);
    const sessionId = safeText(body.sessionId, 128);
    if (!storedSession || storedSession.id !== sessionId) throw new HttpError(403, "Unknown media session", "invalid_session");

    if (action === "publish" && request.method === "POST") {
      if (claims.role !== "host") throw new HttpError(403, "Host permission required", "host_required");
      if (this.room.activeMedia && this.room.activeMedia.publisherClientId !== clientId) {
        throw new HttpError(409, "Another host is already broadcasting", "host_busy");
      }
      const description = this.validateDescription(body.sessionDescription, "offer");
      const tracks = this.validatePublishedTracks(body.tracks);
      const response = await realtimeRequest(this.env, `/sessions/${sessionId}/tracks/new`, {
        body: {
          sessionDescription: description,
          tracks: tracks.map(({ mid, trackName }) => ({ location: "local", mid, trackName })),
        },
      });
      this.room.pendingMedia = {
        version: randomToken(12),
        publisherClientId: clientId,
        publisherSessionId: sessionId,
        broadcasterName: meta.name,
        tracks,
        startedAt: Date.now(),
      };
      await this.persist();
      return jsonResponse(response);
    }

    if (action === "ready" && request.method === "POST") {
      if (claims.role !== "host" || this.room.pendingMedia?.publisherClientId !== clientId) {
        throw new HttpError(409, "No pending broadcast", "no_pending_broadcast");
      }
      this.room.activeMedia = this.room.pendingMedia;
      this.room.pendingMedia = null;
      await this.persist();
      this.broadcast({ type: "media:available", media: this.mediaAnnouncement() });
      return jsonResponse({ media: this.mediaAnnouncement() });
    }

    if (action === "subscribe" && request.method === "POST") {
      if (!this.room.activeMedia) throw new HttpError(409, "The host is not broadcasting", "no_active_media");
      const quality = ["auto", "data", "balanced", "high"].includes(body.quality) ? body.quality : "auto";
      const response = await realtimeRequest(this.env, `/sessions/${sessionId}/tracks/new`, {
        body: {
          tracks: this.room.activeMedia.tracks.map((track) => {
            const remote = {
              location: "remote",
              sessionId: this.room.activeMedia.publisherSessionId,
              trackName: track.trackName,
            };
            if (track.kind === "video") remote.simulcast = this.simulcastPreference(quality);
            return remote;
          }),
        },
      });
      return jsonResponse(response);
    }

    if (action === "renegotiate" && request.method === "PUT") {
      const description = this.validateDescription(body.sessionDescription, "answer");
      const response = await realtimeRequest(this.env, `/sessions/${sessionId}/renegotiate`, {
        method: "PUT",
        body: { sessionDescription: description },
      });
      return jsonResponse(response);
    }

    if (action === "stop" && request.method === "POST") {
      if (claims.role !== "host") throw new HttpError(403, "Host permission required", "host_required");
      if (
        this.room.activeMedia?.publisherClientId !== clientId &&
        this.room.pendingMedia?.publisherClientId !== clientId
      ) throw new HttpError(409, "You are not the current broadcaster", "not_broadcaster");
      await this.stopMedia(clientId, true);
      return jsonResponse({ ok: true });
    }

    throw new HttpError(404, "Unknown media action", "not_found");
  }

  validateDescription(value, expectedType) {
    if (!value || value.type !== expectedType || typeof value.sdp !== "string" || value.sdp.length > 450_000) {
      throw new HttpError(400, `Invalid ${expectedType} session description`, "invalid_sdp");
    }
    return { type: expectedType, sdp: value.sdp };
  }

  validatePublishedTracks(value) {
    if (!Array.isArray(value) || value.length < 1 || value.length > 3) {
      throw new HttpError(400, "Expected one to three media tracks", "invalid_tracks");
    }
    const tracks = value.map((track) => ({
      mid: safeText(track.mid, 20),
      trackName: safeText(track.trackName, 128),
      kind: track.kind === "audio" ? "audio" : track.kind === "video" ? "video" : "",
    }));
    if (tracks.some((track) => !track.mid || !track.trackName || !track.kind)) {
      throw new HttpError(400, "Invalid media track", "invalid_tracks");
    }
    if (new Set(tracks.map((track) => track.trackName)).size !== tracks.length) {
      throw new HttpError(400, "Duplicate media track", "invalid_tracks");
    }
    return tracks;
  }

  simulcastPreference(quality) {
    if (quality === "data") return { preferredRid: "z", priorityOrdering: "none", ridNotAvailable: "asciibetical" };
    if (quality === "balanced") return { preferredRid: "m", priorityOrdering: "none", ridNotAvailable: "asciibetical" };
    if (quality === "high") return { preferredRid: "a", priorityOrdering: "none", ridNotAvailable: "asciibetical" };
    return { preferredRid: "a", priorityOrdering: "asciibetical", ridNotAvailable: "asciibetical" };
  }

  async stopMedia(requestingClientId, force = false) {
    const media = this.room?.activeMedia || this.room?.pendingMedia;
    if (!media) return;
    if (!force && requestingClientId && media.publisherClientId !== requestingClientId) return;
    this.room.activeMedia = null;
    this.room.pendingMedia = null;
    await this.persist();
    this.broadcast({ type: "media:stopped" });
    try {
      await realtimeRequest(this.env, `/sessions/${media.publisherSessionId}/tracks/close`, {
        method: "PUT",
        body: { tracks: media.tracks.map((track) => ({ mid: track.mid })), force: true },
      });
    } catch (error) {
      console.warn("Could not close Realtime tracks", error.message);
    }
  }

  pruneBans() {
    const now = Date.now();
    for (const [clientId, expiresAt] of Object.entries(this.room.bannedClients || {})) {
      if (expiresAt <= now) delete this.room.bannedClients[clientId];
    }
  }

  pruneAdmissions() {
    const now = Date.now();
    this.room.admittedClients ||= {};
    for (const [clientId, admission] of Object.entries(this.room.admittedClients)) {
      const invite = this.room.invites?.[admission.inviteId];
      if (!invite || invite.revokedAt || invite.expiresAt <= now || admission.expiresAt <= now) {
        delete this.room.admittedClients[clientId];
      }
    }
  }
}
