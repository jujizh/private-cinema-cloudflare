// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Private Cinema contributors.
// Open-source snapshot prepared 2026-10-29; see CHANGELOG.md.
// Control/signalling only. This controller never owns or closes media tracks.
export const JOIN_RELEASE = "2.4.1-host-settings-20261029";

const terminalCodes = new Set([
  "join_cancelled", "room_ended", "room_expired", "invite_invalid", "invite_required",
  "room_locked", "client_banned", "setup_required", "ticket_invalid", "connection_replaced",
]);

function failure(code, phase, extra = {}) {
  const error = new Error(code);
  Object.assign(error, { code, phase }, extra);
  return error;
}

export function connectionErrorText(error) {
  const messages = {
    ticket_timeout: "Room admission timed out / 入场请求超时",
    ticket_failed: "Room admission failed / 入场请求失败",
    ticket_invalid: "The server returned an invalid admission / 入场响应异常",
    ws_timeout: "The room connection timed out / 房间连接握手超时",
    ws_error: "The room connection could not be established / 房间连接失败",
    ws_closed: "The room connection closed before joining / 加入完成前连接已关闭",
    ws_create_failed: "The browser could not start the room connection / 浏览器无法创建房间连接",
    welcome_timeout: "Connected, but the room did not confirm admission / 已连接，但未收到房间确认",
    welcome_invalid: "The room confirmation was invalid / 房间确认信息异常",
    join_cancelled: "Joining cancelled / 已取消加入",
    room_ended: "This screening has ended / 房间已结束",
    room_expired: "This invitation has expired / 邀请已过期",
    invite_invalid: "This invitation is no longer valid / 邀请已失效",
    invite_required: "A valid invitation is required / 需要有效邀请",
    room_locked: "The host has locked this screening / 房间已锁定",
    client_banned: "This device was removed from the room / 此设备已被移出房间",
    setup_required: "The server configuration is incomplete / 服务端配置不完整",
    welcome_handler_failed: "The page could not finish joining / 页面未能完成加入",
    connection_replaced: "Another tab took over this room / 房间已在另一标签页打开",
  };
  const status = Number.isInteger(error?.status) ? ` · HTTP ${error.status}` : "";
  return `${messages[error?.code] || "The room could not connect / 无法连接房间"}${status} [${error?.code || "unknown"}]`;
}

export class RoomConnection {
  constructor({ requestTicket, socketUrl, makeSocket = (url) => new WebSocket(url),
    onSocket = () => {}, onReady = () => {}, onMessage = () => {}, onDisconnect = () => {},
    onProgress = () => {}, ticketTimeoutMs = 12_000, handshakeTimeoutMs = 20_000,
    welcomeTimeoutMs = 8_000, maxAttempts = 3, retryDelaysMs = [1_000, 2_500] }) {
    Object.assign(this, { requestTicket, socketUrl, makeSocket, onSocket, onReady,
      onMessage, onDisconnect, onProgress, ticketTimeoutMs, handshakeTimeoutMs,
      welcomeTimeoutMs, maxAttempts, retryDelaysMs });
    this.socket = null;
    this.ready = false;
    this.events = [];
    this.phase = "idle";
    this.attempt = 0;
    this._generation = 0;
    this._promise = null;
    this._abort = null;
    this._dispose = null;
    this.lastFailure = null;
  }

  record(phase, fields = {}) {
    this.phase = phase;
    // Deliberate allowlist: never export URLs, tickets, room/client IDs, names,
    // messages, close reasons or arbitrary exception text.
    const event = { at: new Date().toISOString(), phase, attempt: this.attempt };
    for (const key of ["code", "status", "closeCode", "delayMs"]) {
      if (key === "code" && typeof fields[key] === "string" && /^[a-z_]{1,48}$/.test(fields[key])) event[key] = fields[key];
      else if (key !== "code" && Number.isFinite(fields[key])) event[key] = fields[key];
    }
    this.events.push(event);
    if (this.events.length > 100) this.events.shift();
    try { this.onProgress({ ...event, maxAttempts: this.maxAttempts }); } catch {}
  }

  diagnostics() {
    return { release: JOIN_RELEASE, exportedAt: new Date().toISOString(), phase: this.phase,
      ready: this.ready, socketState: this.socket?.readyState ?? null,
      events: this.events.map((event) => ({ ...event })) };
  }

  connect() {
    if (this._promise) return this._promise;
    if (this.ready && this.socket?.readyState === 1) return Promise.resolve(this.socket);
    const generation = ++this._generation;
    const abort = new AbortController();
    this._abort = abort;
    const pending = this._run(abort.signal, generation).finally(() => {
      if (this._promise === pending) this._promise = null;
    });
    this._promise = pending;
    return pending;
  }

  cancel(code = 1000, reason = "Left room") {
    ++this._generation;
    const socket = this.socket;
    this._abort?.abort();
    this._dispose?.();
    this._dispose = null;
    this.socket = null;
    this.ready = false;
    this.onSocket(null);
    if (socket && socket.readyState < 2) {
      try { socket.close(code, reason); } catch {}
    }
    this.record("cancelled", { code: "join_cancelled" });
  }

  async _run(signal, generation) {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      this.attempt = attempt;
      try {
        if (signal.aborted || generation !== this._generation) throw failure("join_cancelled", "cancelled");
        this.record("ticket");
        // Tickets are single-use and short-lived. Never reuse one on retry.
        const ticket = await this._getTicket(signal);
        if (signal.aborted || generation !== this._generation) throw failure("join_cancelled", "cancelled");
        if (!ticket?.ticket || typeof ticket.ticket !== "string" || typeof ticket.room?.id !== "string") {
          throw failure("ticket_invalid", "ticket");
        }
        return await this._open(ticket, signal, generation);
      } catch (error) {
        const current = error?.phase ? error : failure("ticket_failed", "ticket");
        this.lastFailure = current;
        if (signal.aborted || generation !== this._generation) throw failure("join_cancelled", "cancelled");
        this.record("attempt_failed", current);
        const fatalStatus = current.status >= 400 && current.status < 500 && current.status !== 408;
        if (terminalCodes.has(current.code) || fatalStatus || attempt === this.maxAttempts) {
          this.record("failed", current);
          current.message = connectionErrorText(current);
          throw current;
        }
        const delayMs = this.retryDelaysMs[Math.min(attempt - 1, this.retryDelaysMs.length - 1)] ?? 1_000;
        this.record("retry_wait", { code: current.code, delayMs });
        await this._delay(delayMs, signal);
      }
    }
  }

  _getTicket(signal) {
    return new Promise((resolve, reject) => {
      const abort = new AbortController();
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", cancelled);
        if (error) { abort.abort(); reject(error); } else resolve(result);
      };
      const cancelled = () => finish(failure("join_cancelled", "cancelled"));
      const timer = setTimeout(() => finish(failure("ticket_timeout", "ticket")), this.ticketTimeoutMs);
      signal.addEventListener("abort", cancelled, { once: true });
      if (signal.aborted) { cancelled(); return; }
      Promise.resolve().then(() => this.requestTicket(abort.signal)).then(
        (result) => finish(null, result),
        (error) => finish(failure(error?.code || "ticket_failed", "ticket", { status: error?.status })),
      );
    });
  }

  _open(ticket, signal, generation) {
    return new Promise((resolve, reject) => {
      let socket;
      try { socket = this.makeSocket(this.socketUrl(ticket)); }
      catch { reject(failure("ws_create_failed", "handshake")); return; }
      this.socket = socket;
      this.ready = false;
      this.onSocket(socket);
      this.record("handshake");
      let ready = false;
      let settled = false;
      let disposed = false;
      let timer;
      const current = () => !disposed && generation === this._generation && this.socket === socket;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        clearTimeout(timer);
        for (const [name, handler] of Object.entries(listeners)) socket.removeEventListener(name, handler);
        signal.removeEventListener("abort", cancelled);
        if (this._dispose === dispose) this._dispose = null;
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        dispose();
        if (this.socket === socket) { this.socket = null; this.ready = false; this.onSocket(null); }
        // Detach first: retiring an attempt must never start a second reconnect
        // loop or let a late welcome mutate the newly connected room.
        if (socket.readyState < 2) try { socket.close(4000, "Connection attempt retired"); } catch {}
        reject(error);
      };
      const cancelled = () => {
        if (!ready) fail(failure("join_cancelled", "cancelled"));
        else dispose();
      };
      const listeners = {
        open: () => {
          if (!current() || ready) return;
          clearTimeout(timer);
          this.record("welcome");
          timer = setTimeout(() => fail(failure("welcome_timeout", "welcome")), this.welcomeTimeoutMs);
        },
        message: (event) => {
          if (!current()) return;
          if (!ready) {
            let message;
            try { message = JSON.parse(event.data); } catch { return; }
            if (message?.type !== "welcome") return;
            if (message.room?.id !== ticket.room.id || typeof message.id !== "string"
              || !["host", "viewer"].includes(message.role)) {
              fail(failure("welcome_invalid", "welcome")); return;
            }
            clearTimeout(timer);
            // Mark control ready before welcome starts any media subscription.
            this.ready = true;
            try { this.onReady(ticket); this.onMessage(event.data); }
            catch { fail(failure("welcome_handler_failed", "welcome")); return; }
            if (!current()) { fail(failure("join_cancelled", "cancelled")); return; }
            ready = true;
            settled = true;
            this.lastFailure = null;
            this.record("ready");
            resolve(socket);
          } else {
            try { this.onMessage(event.data); } catch { this.record("message_handler_failed"); }
          }
        },
        error: () => {
          if (current() && !ready) fail(failure("ws_error", "handshake"));
        },
        close: (event) => {
          if (!current()) return;
          if (!ready) {
            const code = event.code === 4003 ? "client_banned" : event.code === 4004 ? "room_ended"
              : event.code === 4000 && event.reason === "Replaced by a newer connection" ? "connection_replaced" : "ws_closed";
            fail(failure(code, "handshake", { closeCode: event.code })); return;
          }
          dispose();
          this.ready = false;
          this.record("disconnected", { closeCode: event.code });
          // The app may schedule control reconnection, but owns media separately.
          try { this.onDisconnect(event, socket); }
          finally {
            if (this.socket === socket) { this.socket = null; this.onSocket(null); }
          }
        },
      };
      this._dispose = dispose;
      for (const [name, handler] of Object.entries(listeners)) socket.addEventListener(name, handler);
      signal.addEventListener("abort", cancelled, { once: true });
      timer = setTimeout(() => fail(failure("ws_timeout", "handshake")), this.handshakeTimeoutMs);
      if (signal.aborted) cancelled();
    });
  }

  _delay(ms, signal) {
    return new Promise((resolve, reject) => {
      const cancelled = () => { clearTimeout(timer); reject(failure("join_cancelled", "cancelled")); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", cancelled); resolve(); }, ms);
      signal.addEventListener("abort", cancelled, { once: true });
      if (signal.aborted) cancelled();
    });
  }
}
