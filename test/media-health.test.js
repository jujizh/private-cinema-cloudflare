// Intentionally replaces the retired v2.3.7 test file of the same name when
// users upload over an existing repository. These tests target the join-fix
// release, not the discarded on-demand SFU implementation.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { RoomConnection, JOIN_RELEASE } from "../public/room-connection.js";
import * as localMedia from "../public/local-media.js";

class Socket extends EventTarget {
  constructor() { super(); this.readyState = 0; this.closed = []; this.handlers = new Map(); }
  addEventListener(name, callback, options) {
    this.handlers.set(name, callback);
    super.addEventListener(name, callback, options);
  }
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
  message(data) { this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(data) })); }
  welcome(room = "room-test") { this.message({ type: "welcome", id: "anna", role: "viewer", room: { id: room, title: "Test" }, participants: [], media: null }); }
  serverClose(code = 1006, reason = "") { this.readyState = 3; this.dispatchEvent(Object.assign(new Event("close"), { code, reason })); }
  close(code, reason) { this.closed.push({ code, reason }); this.serverClose(code, reason); }
}

const flush = async () => { for (let i = 0; i < 24; i += 1) await Promise.resolve(); };

function fixture(t, options = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sockets = [], urls = [], events = [], deliveries = [], disconnects = [];
  let tickets = 0, ready = 0;
  const connector = new RoomConnection({
    ticketTimeoutMs: 10, handshakeTimeoutMs: 20, welcomeTimeoutMs: 8, retryDelaysMs: [1, 2],
    requestTicket: async () => ({ ticket: `secret-ticket-${++tickets}`, room: { id: "room-test" } }),
    socketUrl: (ticket) => `wss://example.test/ws?ticket=${ticket.ticket}`,
    makeSocket: (url) => { urls.push(url); const socket = new Socket(); sockets.push(socket); return socket; },
    onMessage: (raw) => deliveries.push(JSON.parse(raw)),
    onReady: () => { ready += 1; },
    onProgress: (event) => events.push(event),
    onDisconnect: (event) => disconnects.push(event),
    ...options,
  });
  return { connector, sockets, urls, events, deliveries, disconnects,
    get tickets() { return tickets; }, get ready() { return ready; } };
}

test("join is single-flight and requires welcome, not merely an open socket", async (t) => {
  const f = fixture(t);
  const first = f.connector.connect();
  assert.equal(f.connector.connect(), first);
  await flush();
  f.sockets[0].open();
  await flush();
  assert.equal(f.connector.ready, false);
  assert.equal(f.ready, 0);
  f.sockets[0].welcome();
  assert.equal(await first, f.sockets[0]);
  assert.equal(f.connector.ready, true);
  assert.equal(f.tickets, 1);
  assert.equal(f.ready, 1);
  assert.equal(await f.connector.connect(), f.sockets[0]);
  assert.equal(f.tickets, 1);
});

test("handshake timeout closes the old attempt and retries with a fresh ticket", async (t) => {
  const f = fixture(t);
  const pending = f.connector.connect();
  await flush();
  t.mock.timers.tick(20); await flush();
  assert.equal(f.sockets[0].closed.length, 1);
  assert.equal(f.disconnects.length, 0);
  t.mock.timers.tick(1); await flush();
  assert.equal(f.tickets, 2);
  assert.notEqual(f.urls[0], f.urls[1]);
  f.sockets[1].open(); f.sockets[1].welcome();
  await pending;
  assert.equal(f.connector.socket, f.sockets[1]);
});

test("a late welcome and close from an expired attempt cannot affect the current room", async (t) => {
  const f = fixture(t);
  const pending = f.connector.connect(); await flush();
  const oldMessage = f.sockets[0].handlers.get("message");
  const oldClose = f.sockets[0].handlers.get("close");
  t.mock.timers.tick(20); await flush(); t.mock.timers.tick(1); await flush();
  f.sockets[1].open(); f.sockets[1].welcome(); await pending;
  oldMessage({ data: JSON.stringify({ type: "media:stopped" }) });
  oldClose({ code: 1006 });
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.connector.ready, true);
  assert.equal(f.disconnects.length, 0);
});

test("close before welcome fails immediately instead of waiting for the old timeout", async (t) => {
  const f = fixture(t, { maxAttempts: 1 });
  const pending = f.connector.connect();
  const rejected = assert.rejects(pending, { code: "ws_closed", closeCode: 1006 });
  await flush(); f.sockets[0].serverClose(); await rejected;
  assert.equal(f.connector.socket, null);
  assert.equal(f.disconnects.length, 0);
});

test("open without welcome has its own timeout and does not enter the cinema", async (t) => {
  const f = fixture(t, { maxAttempts: 1 });
  const pending = f.connector.connect();
  const rejected = assert.rejects(pending, { code: "welcome_timeout" });
  await flush(); f.sockets[0].open(); t.mock.timers.tick(8); await rejected;
  assert.equal(f.ready, 0);
  assert.equal(f.sockets[0].closed.length, 1);
});

test("retries stop after three attempts and leave no live sockets or late readiness", async (t) => {
  const f = fixture(t);
  const pending = f.connector.connect();
  const rejected = assert.rejects(pending, { code: "ws_timeout" });
  await flush();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    t.mock.timers.tick(20); await flush();
    if (attempt < 2) { t.mock.timers.tick(attempt + 1); await flush(); }
  }
  await rejected;
  assert.equal(f.sockets.length, 3);
  assert.ok(f.sockets.every((socket) => socket.closed.length === 1));
  assert.equal(f.connector.socket, null);
  assert.equal(f.connector.phase, "failed");
  f.sockets[2].open(); f.sockets[2].welcome();
  assert.equal(f.ready, 0);
});

test("a hung ticket fetch is aborted and bounded even if the fetch ignores abort", async (t) => {
  let signal, finish;
  const f = fixture(t, { maxAttempts: 1, requestTicket: (received) => { signal = received; return new Promise((r) => { finish = r; }); } });
  const pending = f.connector.connect(); const rejected = assert.rejects(pending, { code: "ticket_timeout" });
  await flush(); t.mock.timers.tick(10); await rejected;
  assert.equal(signal.aborted, true);
  finish({ ticket: "late-secret", room: { id: "room-test" } }); await flush();
  assert.equal(f.sockets.length, 0);
});

test("cancel during admission aborts fetch and cannot resurrect a socket", async (t) => {
  let finish, signal;
  const f = fixture(t, { requestTicket: (received) => { signal = received; return new Promise((r) => { finish = r; }); } });
  const pending = f.connector.connect(); const rejected = assert.rejects(pending, { code: "join_cancelled" });
  await flush(); f.connector.cancel(); await rejected;
  finish({ ticket: "late-secret", room: { id: "room-test" } }); await flush();
  assert.equal(signal.aborted, true);
  assert.equal(f.sockets.length, 0);
});

test("cancel during handshake closes exactly the pending connection without reconnecting", async (t) => {
  const f = fixture(t);
  const pending = f.connector.connect(); const rejected = assert.rejects(pending, { code: "join_cancelled" });
  await flush(); f.connector.cancel(); await rejected;
  t.mock.timers.tick(100); await flush();
  assert.equal(f.sockets.length, 1);
  assert.equal(f.sockets[0].closed.length, 1);
  assert.equal(f.disconnects.length, 0);
});

test("cancel during retry delay prevents the next ticket request", async (t) => {
  const f = fixture(t);
  const pending = f.connector.connect(); const rejected = assert.rejects(pending, { code: "join_cancelled" });
  await flush(); f.sockets[0].serverClose(); await flush();
  f.connector.cancel(); await rejected; t.mock.timers.tick(100); await flush();
  assert.equal(f.tickets, 1);
});

for (const status of [401, 403, 404, 410, 423, 429]) {
  test(`HTTP ${status} does not produce an automatic admission retry storm`, async (t) => {
    let requests = 0;
    const f = fixture(t, { requestTicket: async () => { requests += 1; throw Object.assign(new Error("sensitive upstream text"), { status }); } });
    await assert.rejects(f.connector.connect(), { status, code: "ticket_failed" });
    t.mock.timers.tick(100); await flush();
    assert.equal(requests, 1);
    assert.equal(f.sockets.length, 0);
  });
}

test("temporary server errors retry admission instead of stopping permanently", async (t) => {
  let requests = 0;
  const f = fixture(t, { requestTicket: async () => {
    if (++requests === 1) throw Object.assign(new Error("upstream"), { status: 503 });
    return { ticket: "next-ticket", room: { id: "room-test" } };
  } });
  const pending = f.connector.connect(); await flush(); t.mock.timers.tick(1); await flush();
  f.sockets[0].open(); f.sockets[0].welcome(); await pending;
  assert.equal(requests, 2);
});

test("wrong-room welcome cannot activate the room", async (t) => {
  const f = fixture(t, { maxAttempts: 1 });
  const pending = f.connector.connect(); const rejected = assert.rejects(pending, { code: "welcome_invalid" });
  await flush(); f.sockets[0].open(); f.sockets[0].welcome("other-room"); await rejected;
  assert.equal(f.ready, 0);
});

test("server removal during handshake is terminal, not an endless reconnect", async (t) => {
  const f = fixture(t);
  const pending = f.connector.connect(); const rejected = assert.rejects(pending, { code: "client_banned" });
  await flush(); f.sockets[0].serverClose(4003); await rejected;
  assert.equal(f.tickets, 1);
});

test("established control disconnect notifies once; leave does not notify", async (t) => {
  const f = fixture(t);
  const pending = f.connector.connect(); await flush(); f.sockets[0].open(); f.sockets[0].welcome(); await pending;
  f.sockets[0].serverClose(); f.sockets[0].serverClose();
  assert.equal(f.disconnects.length, 1);
  const again = f.connector.connect(); await flush(); f.sockets[1].open(); f.sockets[1].welcome(); await again;
  f.connector.cancel(1000, "Left room");
  assert.equal(f.sockets[1].closed[0].reason, "Left room");
  assert.equal(f.disconnects.length, 1);
});

test("diagnostics are bounded and omit tokens, URLs and upstream exception text", async (t) => {
  const f = fixture(t);
  const pending = f.connector.connect(); await flush(); f.sockets[0].open(); f.sockets[0].welcome(); await pending;
  for (let i = 0; i < 120; i += 1) f.connector.record("sample", { url: "secret-url", ticket: "secret-ticket", message: "secret-name", status: 200 });
  const json = JSON.stringify(f.connector.diagnostics());
  assert.equal(f.connector.events.length, 100);
  assert.equal(json.includes("secret-"), false);
  assert.equal(json.includes("room-test"), false);
  assert.equal(json.includes("anna"), false);
});

test("page boots with the join controls, and control recovery does not touch media", async (t) => {
  const elements = new Map();
  const element = () => ({ value: "", textContent: "", dataset: {}, disabled: false,
    classList: { add() {}, remove() {}, toggle() {} }, querySelector: () => ({ textContent: "" }),
    addEventListener() {}, removeEventListener() {}, appendChild() {}, replaceChildren() {} });
  const storage = new Map();
  const context = vm.createContext({ RoomConnection, JOIN_RELEASE, ...localMedia, console,
    document: { visibilityState: "visible", getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }, querySelectorAll: () => [], addEventListener() {}, createElement: element },
    Option: function (text, value) { this.text = text; this.value = value; },
    localStorage: { getItem: (key) => storage.get(key), setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) },
    sessionStorage: { getItem: (key) => storage.get(key), setItem: (k, v) => storage.set(k, v) },
    crypto: { randomUUID: () => "test-tab" }, navigator: { onLine: true },
    window: { addEventListener() {} }, location: { protocol: "https:", host: "example.test", pathname: "/", search: "" },
    setTimeout, clearTimeout, setInterval, clearInterval, performance,
  });
  const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8")
    .replace(/^import[^\n]+\n/gm, "").replace(/\ninitialize\(\);\s*$/, "");
  vm.runInContext(source + "\nbindEvents();globalThis.app={state,roomConnection,connectToRoom,handleSocketClose};", context);
  const { state, roomConnection, connectToRoom } = context.app;
  roomConnection.maxAttempts = 1;
  t.after(() => {
    state.intentionalClose = true;
    clearTimeout(state.reconnectTimer); clearInterval(state.heartbeatTimer); clearInterval(state.captionTimer);
    roomConnection.cancel();
  });
  const socket = new Socket();
  roomConnection.requestTicket = async () => ({ ticket: "test-ticket", room: { id: "room-test", title: "Test" } });
  roomConnection.makeSocket = () => socket;
  let closedTracks = 0;
  const media = { getTracks: () => [{ stop() { closedTracks += 1; } }] };
  state.localStream = media;
  const pending = connectToRoom(); await flush(); socket.open(); socket.welcome(); await pending;
  assert.equal(state.connected, true);
  assert.equal(state.hasWelcomed, true);
  assert.equal(state.localStream, media);
  socket.serverClose();
  assert.equal(state.connected, false);
  assert.equal(closedTracks, 0);
  assert.equal(state.localStream, media);
  state.intentionalClose = true;
  clearTimeout(state.reconnectTimer); clearInterval(state.heartbeatTimer); roomConnection.cancel();
});
