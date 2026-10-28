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
const textEncoder = new TextEncoder();
const ROOM_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const CAPTION_MAX_TRACKS = 12;
const CAPTION_MAX_BYTES = 768 * 1024;
const CAPTION_CHUNK_BYTES = 48 * 1024;
const PARTICIPANT_RECONNECT_GRACE_MS = 45_000;
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
      if (url.pathname === "/internal/delete" && request.method === "DELETE") return this.deleteRoom(request);
      if (url.pathname === "/internal/ticket" && request.method === "POST") return this.createTicket(request);
      if (url.pathname === "/internal/ws") return this.openSocket(request);
      if (url.pathname === "/internal/status" && request.method === "GET") return this.getStatus(request);
      if (url.pathname === "/internal/captions" && request.method === "GET") return this.listCaptions(request);
      if (url.pathname === "/internal/control/captions" && request.method === "POST") return this.addCaption(request);
      const captionMatch = url.pathname.match(/^\/internal\/captions\/([A-Za-z0-9_-]{16,80})$/);
      if (captionMatch && request.method === "GET") return this.getCaption(request, captionMatch[1]);
      const captionControlMatch = url.pathname.match(/^\/internal\/control\/captions\/([A-Za-z0-9_-]{16,80})$/);
      if (captionControlMatch && request.method === "DELETE") return this.deleteCaption(request, captionControlMatch[1]);
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

  async directoryDelete(roomId) {
    if (!roomId || !this.env.DIRECTORY) return;
    const id = this.env.DIRECTORY.idFromName("main");
    const stub = this.env.DIRECTORY.get(id);
    await stub.fetch(`https://directory/delete?id=${encodeURIComponent(roomId)}`, { method: "DELETE" });
  }

  async deleteRoom(request) {
    const claims = claimsFromRequest(request);
    if (claims?.role !== "owner") throw new HttpError(403, "Owner access required", "forbidden");
    await this.purgeRoom(this.room?.id || claims.room, "Screening deleted");
    return jsonResponse({ ok: true });
  }

  async purgeRoom(roomId, reason = "Screening expired") {
    if (this.room) {
      try { await this.stopMedia(null, true); } catch {}
      this.broadcast({ type: "room:ended" });
      for (const socket of this.ctx.getWebSockets()) {
        try { socket.close(4004, reason); } catch {}
      }
    }
    await this.directoryDelete(roomId);
    await this.ctx.storage.deleteAll();
    this.room = null;
  }

  async scheduleNextAlarm() {
    if (!this.room) return;
    const reconnectDeadlines = Object.values(this.room.participantDisconnects || {}).map((entry) => entry.deadline);
    const deadlines = [this.room.publisherDisconnect?.deadline, this.room.cleanupAt, ...reconnectDeadlines]
      .filter((value) => Number(value) > Date.now());
    if (deadlines.length) await this.ctx.storage.setAlarm(Math.min(...deadlines));
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
      schema: 3,
      id: safeText(body.roomId, 80),
      title: safeText(body.title, 100) || "Private screening",
      createdAt: now,
      expiresAt: now + hours * 60 * 60 * 1000,
      cleanupAt: now + hours * 60 * 60 * 1000 + ROOM_RETENTION_MS,
      endedAt: null,
      locked: false,
      invites: {},
      bannedClients: {},
      admittedClients: {},
      participantDisconnects: {},
      activeMedia: null,
      pendingMedia: null,
      captions: [],
    };
    const host = await this.issueInvite("host", "Owner", hours);
    const viewer = await this.issueInvite("viewer", "Guests", hours);
    await this.persist();
    await this.directoryUpdate();
    await this.scheduleNextAlarm();
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
      captions: this.captionMetadata(),
      captionClock: this.captionClockState(),
    };
  }

  captionClockState() {
    const clock = this.room?.captionClock;
    if (!clock || !Number.isFinite(Number(clock.time))) return null;
    const now = Date.now();
    const rate = Number.isFinite(clock.rate) && clock.rate > 0 ? Math.max(0.25, Math.min(4, clock.rate)) : 1;
    const elapsed = clock.playing ? Math.max(0, now - Number(clock.updatedAt || now)) / 1000 * rate : 0;
    return {
      time: Math.max(0, Number(clock.time) + elapsed),
      playing: Boolean(clock.playing),
      rate,
      source: ["capture", "local-player", "manual"].includes(clock.source) ? clock.source : "capture",
    };
  }

  captionMetadata() {
    return (this.room?.captions || []).map((caption) => ({
      id: caption.id,
      name: caption.name,
      language: caption.language,
      format: caption.format,
      bytes: caption.bytes,
      createdAt: caption.createdAt,
    }));
  }

  captionStorageKey(id, index) {
    return `caption:${id}:${index}`;
  }

  async storeCaptionContent(id, content) {
    const bytes = textEncoder.encode(content);
    const chunkCount = Math.ceil(bytes.byteLength / CAPTION_CHUNK_BYTES);
    for (let index = 0; index < chunkCount; index += 1) {
      const start = index * CAPTION_CHUNK_BYTES;
      const chunk = bytes.slice(start, Math.min(bytes.byteLength, start + CAPTION_CHUNK_BYTES));
      await this.ctx.storage.put(this.captionStorageKey(id, index), chunk);
    }
    return { bytes: bytes.byteLength, chunkCount };
  }

  async loadCaptionContent(caption) {
    const chunks = [];
    let total = 0;
    for (let index = 0; index < caption.chunkCount; index += 1) {
      const stored = await this.ctx.storage.get(this.captionStorageKey(caption.id, index));
      if (!stored) throw new HttpError(410, "Subtitle data is no longer available", "caption_missing");
      const chunk = stored instanceof Uint8Array ? stored : new Uint8Array(stored);
      chunks.push(chunk);
      total += chunk.byteLength;
    }
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return textDecoder.decode(joined);
  }

  async removeCaptionContent(caption) {
    const keys = Array.from({ length: caption.chunkCount }, (_, index) => this.captionStorageKey(caption.id, index));
    if (keys.length) await this.ctx.storage.delete(keys);
  }

  async listCaptions(request) {
    const claims = claimsFromRequest(request);
    this.assertClaim(claims);
    return jsonResponse({ captions: this.captionMetadata() });
  }

  async getCaption(request, captionId) {
    const claims = claimsFromRequest(request);
    this.assertClaim(claims);
    const caption = (this.room.captions || []).find((item) => item.id === captionId);
    if (!caption) throw new HttpError(404, "Subtitle track not found", "caption_not_found");
    const metadata = this.captionMetadata().find((item) => item.id === captionId);
    return jsonResponse({ caption: { ...metadata, content: await this.loadCaptionContent(caption) } });
  }

  async addCaption(request) {
    const claims = claimsFromRequest(request);
    this.assertClaim(claims, ["host", "owner"]);
    this.room.captions ||= [];
    if (this.room.captions.length >= CAPTION_MAX_TRACKS) {
      throw new HttpError(409, `A room can contain up to ${CAPTION_MAX_TRACKS} subtitle tracks`, "caption_limit");
    }
    const body = await readJson(request, CAPTION_MAX_BYTES + 32 * 1024);
    const format = String(body.format || "").toLowerCase() === "vtt" ? "vtt" : "srt";
    const content = String(body.content || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    const encoded = textEncoder.encode(content);
    if (!content.includes("-->") || encoded.byteLength < 16) {
      throw new HttpError(400, "No timed subtitles were found in this file", "caption_invalid");
    }
    if (encoded.byteLength > CAPTION_MAX_BYTES) {
      throw new HttpError(413, "Subtitle file is larger than 768 KB", "caption_too_large");
    }
    const id = randomToken(18);
    const stored = await this.storeCaptionContent(id, content);
    const caption = {
      id,
      name: safeText(body.name, 100) || `Subtitles ${this.room.captions.length + 1}`,
      language: safeText(body.language, 35) || "Undetermined",
      format,
      bytes: stored.bytes,
      chunkCount: stored.chunkCount,
      createdAt: Date.now(),
    };
    this.room.captions.push(caption);
    await this.persist();
    this.broadcast({ type: "captions:update", captions: this.captionMetadata() });
    const metadata = this.captionMetadata();
    return jsonResponse({ captions: metadata, caption: metadata.find((item) => item.id === id) });
  }

  async deleteCaption(request, captionId) {
    const claims = claimsFromRequest(request);
    this.assertClaim(claims, ["host", "owner"]);
    const index = (this.room.captions || []).findIndex((item) => item.id === captionId);
    if (index < 0) throw new HttpError(404, "Subtitle track not found", "caption_not_found");
    const [caption] = this.room.captions.splice(index, 1);
    await this.removeCaptionContent(caption);
    await this.persist();
    this.broadcast({ type: "captions:update", captions: this.captionMetadata() });
    return jsonResponse({ ok: true, captions: this.captionMetadata() });
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
        participantId: randomToken(12),
      };
      await this.persist();
    } else if (!this.room.admittedClients[clientId].participantId) {
      // Rooms created by earlier releases did not persist a logical participant
      // identity. Add one lazily so a network handoff does not look like a new
      // device every time the WebSocket reconnects.
      this.room.admittedClients[clientId].participantId = randomToken(12);
      await this.persist();
    }

    const admission = this.room.admittedClients[clientId];

    const ticket = randomToken(24);
    await this.ctx.storage.put(`ticket:${ticket}`, {
      claims,
      clientId,
      participantId: admission.participantId,
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

    this.room.participantDisconnects ||= {};
    const pendingReconnect = this.room.participantDisconnects[ticket.clientId] || null;
    let roomChanged = false;
    if (pendingReconnect) {
      delete this.room.participantDisconnects[ticket.clientId];
      roomChanged = true;
    }
    if (this.room.publisherDisconnect?.clientId === ticket.clientId) {
      this.room.publisherDisconnect = null;
      roomChanged = true;
    }
    if (roomChanged) await this.persist();

    let replacingConnection = false;
    for (const oldSocket of this.ctx.getWebSockets()) {
      const old = socketMeta(oldSocket);
      if (old?.clientId === ticket.clientId) {
        replacingConnection = true;
        old.replaced = true;
        oldSocket.serializeAttachment(old);
        try {
          oldSocket.close(4000, "Replaced by a newer connection");
        } catch {}
      }
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const meta = {
      id: ticket.participantId || randomToken(12),
      clientId: ticket.clientId,
      inviteId: ticket.claims.jti,
      role: ticket.claims.role,
      name: ticket.name,
      joinedAt: pendingReconnect?.peer?.joinedAt || Date.now(),
      rate: {},
      quality: pendingReconnect?.peer?.quality || null,
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
    this.broadcast({
      type: replacingConnection || pendingReconnect ? "peer:reconnected" : "peer:joined",
      eventId: crypto.randomUUID(),
      peer: this.publicParticipant(meta),
    }, meta.id);
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
      reconnecting: Boolean(meta.reconnecting),
    };
  }

  participants() {
    const latestByClient = new Map();
    for (const socket of this.ctx.getWebSockets()) {
      const meta = socketMeta(socket);
      if (!meta) continue;
      const existing = latestByClient.get(meta.clientId);
      if (!existing || Number(meta.joinedAt) >= Number(existing.joinedAt)) latestByClient.set(meta.clientId, meta);
    }
    const now = Date.now();
    for (const pending of Object.values(this.room?.participantDisconnects || {})) {
      if (!pending?.clientId || Number(pending.deadline) <= now || latestByClient.has(pending.clientId)) continue;
      latestByClient.set(pending.clientId, {
        ...pending.peer,
        clientId: pending.clientId,
        reconnecting: true,
      });
    }
    return [...latestByClient.values()].map((meta) => this.publicParticipant(meta));
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

    if (data.type === "ping") {
      try { socket.send(JSON.stringify({ type: "pong", at: Number(data.at) || Date.now() })); } catch {}
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

    if (data.type === "caption:clock") {
      if (!["host", "owner"].includes(meta.role)) return;
      if (!this.consumeSocketRate(socket, meta, "captionClock", 20, 10_000)) return;
      const input = data.clock && typeof data.clock === "object" ? data.clock : {};
      const time = Math.max(0, Math.min(24 * 60 * 60, Number(input.time) || 0));
      const source = ["capture", "local-player", "manual"].includes(input.source) ? input.source : "capture";
      const rate = Number.isFinite(input.rate) && input.rate > 0 ? Math.max(0.25, Math.min(4, input.rate)) : 1;
      this.room.captionClock = { time, playing: Boolean(input.playing), source, rate, updatedAt: Date.now() };
      this.ctx.waitUntil(this.persist());
      this.broadcast({ type: "caption:clock", clock: this.captionClockState() });
      return;
    }

    if (data.type === "p2p:signal") {
      // ICE can emit a burst of candidates, so this limit is intentionally
      // higher than chat while still preventing an unbounded signaling flood.
      if (!this.consumeSocketRate(socket, meta, "p2p", 80, 10_000)) return;
      const targetId = safeText(data.to, 80);
      const signal = data.signal && typeof data.signal === "object" ? data.signal : {};
      const kind = ["offer", "answer", "candidate", "hangup", "retry", "defer"].includes(signal.kind) ? signal.kind : "";
      if (!targetId || !kind) return;

      let cleanSignal;
      if (kind === "offer" || kind === "answer") {
        const description = signal.description;
        if (!description || description.type !== kind || typeof description.sdp !== "string" || description.sdp.length > 450_000) return;
        cleanSignal = { kind, description: { type: kind, sdp: description.sdp } };
      } else if (kind === "candidate") {
        const candidate = signal.candidate;
        if (candidate === null) cleanSignal = { kind, candidate: null };
        else if (candidate && typeof candidate === "object" && typeof candidate.candidate === "string" && candidate.candidate.length <= 4096) {
          cleanSignal = {
            kind,
            candidate: {
              candidate: candidate.candidate,
              sdpMid: typeof candidate.sdpMid === "string" ? candidate.sdpMid.slice(0, 40) : null,
              sdpMLineIndex: Number.isInteger(candidate.sdpMLineIndex) ? candidate.sdpMLineIndex : null,
              usernameFragment: typeof candidate.usernameFragment === "string" ? candidate.usernameFragment.slice(0, 256) : null,
            },
          };
        } else return;
      } else if (kind === "defer") {
        cleanSignal = {
          kind,
          retryAfterMs: Math.max(60_000, Math.min(10 * 60_000, Number(signal.retryAfterMs) || 10 * 60_000)),
        };
      } else {
        cleanSignal = { kind };
      }

      for (const peer of this.ctx.getWebSockets()) {
        const peerMeta = socketMeta(peer);
        if (peerMeta?.id !== targetId) continue;
        // Only host-to-viewer or viewer-to-host media signaling is allowed.
        if (peerMeta.role === meta.role || !["host", "viewer"].includes(peerMeta.role) || !["host", "viewer"].includes(meta.role)) return;
        try { peer.send(JSON.stringify({ type: "p2p:signal", from: meta.id, signal: cleanSignal })); } catch {}
        return;
      }
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
      route: ["turn", "p2p", "p2p-turn"].includes(quality.route) ? quality.route : "direct",
      transport: ["udp", "tcp", "tls", "unknown"].includes(quality.transport) ? quality.transport : "unknown",
      bitrateKbps: number(quality.bitrateKbps, 100_000),
      packetLoss: number(quality.packetLoss, 100),
      rttMs: number(quality.rttMs, 60_000),
      jitterMs: number(quality.jitterMs, 60_000),
      width: number(quality.width, 16_384),
      height: number(quality.height, 16_384),
      fps: number(quality.fps, 240),
      framesDropped: number(quality.framesDropped, 1_000_000_000),
      qualityLimitationReason: ["none", "cpu", "bandwidth", "other", "receiver"].includes(quality.qualityLimitationReason)
        ? quality.qualityLimitationReason
        : "none",
      codec: safeText(quality.codec, 16).toUpperCase(),
    };
  }

  async webSocketClose(socket, code = 1006, reason = "") {
    const meta = socketMeta(socket);
    if (!meta) return;
    if (meta.replaced) return;
    const replacement = this.ctx.getWebSockets().some((other) => {
      const candidate = socketMeta(other);
      return other !== socket && candidate?.clientId === meta.clientId;
    });
    if (!replacement) {
      // A proxy is allowed to close with 1000 as well, so only the explicit
      // client leave reason is treated as an immediate departure.
      const intentional = [4003, 4004].includes(Number(code)) || (Number(code) === 1000 && reason === "Left room");
      this.room.participantDisconnects ||= {};
      if (intentional) {
        delete this.room.participantDisconnects[meta.clientId];
        this.broadcast({ type: "peer:left", eventId: crypto.randomUUID(), peer: this.publicParticipant(meta) }, meta.id);
        await this.ctx.storage.delete(`session:${meta.clientId}`);
        await this.ctx.storage.delete(`turn:${meta.clientId}`);
        if (this.room?.activeMedia?.publisherClientId === meta.clientId || this.room?.pendingMedia?.publisherClientId === meta.clientId) {
          this.room.publisherDisconnect = null;
          await this.stopMedia(meta.clientId, true);
        } else {
          await this.persist();
        }
      } else {
        // The control WebSocket and the movie PeerConnection are independent.
        // Preserve the logical participant while a VPN/Wi-Fi handoff repairs
        // the control plane; otherwise a momentary outage becomes a forced
        // P2P teardown and a visible video pause.
        const deadline = Date.now() + PARTICIPANT_RECONNECT_GRACE_MS;
        this.room.participantDisconnects[meta.clientId] = {
          clientId: meta.clientId,
          deadline,
          peer: this.publicParticipant(meta),
        };
        if (this.room?.activeMedia?.publisherClientId === meta.clientId || this.room?.pendingMedia?.publisherClientId === meta.clientId) {
          this.room.publisherDisconnect = { clientId: meta.clientId, deadline };
        }
        await this.persist();
        await this.scheduleNextAlarm();
      }
    }
    this.broadcastPresence();
    this.ctx.waitUntil(this.directoryUpdate());
  }

  webSocketError(socket) {
    try { socket.close(1011, "WebSocket error"); } catch {}
  }

  async alarm() {
    await this.ready;
    if (!this.room) return;
    if (this.room.cleanupAt && this.room.cleanupAt <= Date.now()) {
      await this.purgeRoom(this.room.id);
      return;
    }
    const now = Date.now();
    this.room.participantDisconnects ||= {};
    let changed = false;
    for (const [clientId, pending] of Object.entries(this.room.participantDisconnects)) {
      if (Number(pending.deadline) > now) continue;
      const returned = this.ctx.getWebSockets().some((socket) => socketMeta(socket)?.clientId === clientId);
      delete this.room.participantDisconnects[clientId];
      changed = true;
      if (returned) continue;
      this.broadcast({ type: "peer:left", eventId: crypto.randomUUID(), peer: pending.peer });
      await this.ctx.storage.delete(`session:${clientId}`);
      await this.ctx.storage.delete(`turn:${clientId}`);
      if (this.room?.activeMedia?.publisherClientId === clientId || this.room?.pendingMedia?.publisherClientId === clientId) {
        this.room.publisherDisconnect = null;
        await this.stopMedia(clientId, true);
      }
    }
    const publisher = this.room.publisherDisconnect;
    if (publisher && publisher.deadline <= now) {
      const returned = this.ctx.getWebSockets().some((socket) => socketMeta(socket)?.clientId === publisher.clientId);
      this.room.publisherDisconnect = null;
      changed = true;
      if (!returned) {
        await this.ctx.storage.delete(`session:${publisher.clientId}`);
        await this.ctx.storage.delete(`turn:${publisher.clientId}`);
        await this.stopMedia(publisher.clientId, true);
      }
    }
    if (changed) await this.persist();
    this.broadcastPresence();
    this.ctx.waitUntil(this.directoryUpdate());
    await this.scheduleNextAlarm();
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
      this.room.cleanupAt = Date.now() + ROOM_RETENTION_MS;
      await this.persist();
      this.broadcast({ type: "room:ended" });
      for (const socket of this.ctx.getWebSockets()) {
        try { socket.close(4004, "Screening ended"); } catch {}
      }
      await this.directoryUpdate();
      await this.scheduleNextAlarm();
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
    if (quality === "data") return { preferredRid: "m", priorityOrdering: "none", ridNotAvailable: "asciibetical" };
    // Balanced and best-quality are preferences, not hard locks. The SFU must
    // remain free to step down when a phone or network cannot sustain the RID.
    if (quality === "balanced") return { preferredRid: "m", priorityOrdering: "asciibetical", ridNotAvailable: "asciibetical" };
    if (quality === "high") return { preferredRid: "a", priorityOrdering: "asciibetical", ridNotAvailable: "asciibetical" };
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
