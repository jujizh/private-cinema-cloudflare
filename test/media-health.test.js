import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import * as health from "../public/media-health.js";
import { CinemaRoom } from "../src/room.js";

function browser() {
  const elements = new Map();
  const timers = new Map();
  let nextTimer = 0;
  const element = () => ({ value: "auto", textContent: "", dataset: {}, readyState: 4, videoWidth: 1920,
    srcObject: null, paused: false, classList: { add() {}, remove() {}, toggle() {} },
    async play() { this.paused = false; }, pause() { this.paused = true; },
    addEventListener() {}, removeEventListener() {}, appendChild() {}, replaceChildren() {},
    getVideoPlaybackQuality: () => ({ totalVideoFrames: 100 }),
  });
  const storage = new Map();
  const context = vm.createContext({ ...health, console: { ...console, warn() {} }, performance, Date, Map, Set, WeakMap, Promise,
    crypto: { randomUUID: () => "01234567-1234-1234-1234-012345678901" },
    localStorage: { getItem: (k) => storage.get(k), setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) },
    sessionStorage: { getItem: (k) => storage.get(k), setItem: (k, v) => storage.set(k, v) },
    document: { visibilityState: "visible", getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }, createElement: element },
    HTMLMediaElement: { HAVE_CURRENT_DATA: 2 }, WebSocket: { OPEN: 1 }, navigator: {},
    setTimeout: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => timers.delete(id), setInterval: () => 0, clearInterval() {},
  });
  const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8")
    .replace(/^import[^\n]+\n/, "").replace(/\ninitialize\(\);\s*$/, "");
  vm.runInContext(source + "\nglobalThis.app = {state,ui,scheduleBackupRelease,requestSfuStandby,startHostDirectPeer,closeAllDirectConnections,collectStats,healthState,acceptDirectOffer,handleDirectSignal,exportDiagnostics};", context);
  return { ...context.app, context, timers };
}

test("health badge needs consecutive changes, while raw values remain independent", () => {
  let sample = health.smoothHealth(null, "good", "one");
  sample = health.smoothHealth(sample, "poor", "one");
  assert.equal(sample.value, "good");
  sample = health.smoothHealth(sample, "good", "one");
  assert.equal(sample.count, 0);
  sample = health.smoothHealth(sample, "poor", "one");
  sample = health.smoothHealth(sample, "poor", "one");
  assert.equal(sample.value, "poor");
  assert.equal(health.smoothHealth(sample, "good", "replacement").value, "good");
});

test("capture settings are not treated as measured capture FPS", () => {
  assert.equal(health.actualSourceFps({ frameRate: 30 }, null), null);
  assert.equal(health.actualSourceFps({ frames: 150, timestamp: 6000 }, { frames: 50, timestamp: 1000 }), 20);
  assert.equal(health.actualSourceFps({ frames: 0, timestamp: 6000 }, { frames: 50, timestamp: 1000 }), null);
  assert.equal(health.perFrameMs(4, 200, 2, 100), 20);
  assert.equal(health.perFrameMs(null, 200, 2, 100), null);
});

test("host cannot idle SFU on connection state alone, stale reports or a hot-backup viewer", () => {
  const now = 100000;
  const peers = new Map([["anna", { connectionState: "connected" }]]);
  const anna = { id: "anna", quality: null };
  assert.equal(health.viewersConfirmedDirect([anna], peers, "movie", now), false);
  anna.quality = { playbackRoute: "sfu", needsSfu: false, mediaVersion: "movie", reportedAt: now };
  assert.equal(health.viewersConfirmedDirect([anna], peers, "movie", now), false);
  anna.quality.playbackRoute = "direct";
  assert.equal(health.viewersConfirmedDirect([anna], peers, "movie", now), true);
  anna.quality.needsSfu = true;
  assert.equal(health.viewersConfirmedDirect([anna], peers, "movie", now), false);
  anna.quality.needsSfu = false;
  assert.equal(health.viewersConfirmedDirect([anna], peers, "movie", now + 21000), false);
  assert.equal(health.viewersConfirmedDirect([anna], peers, "new-movie", now), false);
  assert.equal(health.viewersConfirmedDirect([], peers, "movie", now), false);
});

test("on-demand release retires only the standby receiver and preserves visible P2P", () => {
  const b = browser();
  let closed = 0;
  let samples = 0;
  b.context.sample = () => samples++;
  vm.runInContext("collectStats = sample", b.context);
  Object.assign(b.state, { role: "viewer", connected: true, activeRoute: "direct", directPc: { connectionState: "connected" }, pc: { close: () => closed++ } });
  b.ui.backupMode.value = "ondemand";
  const stream = {};
  b.ui.directVideo.srcObject = stream;
  b.scheduleBackupRelease();
  [...b.timers.values()].find((t) => t.ms === 8000).fn();
  assert.equal(closed, 1);
  assert.equal(b.state.pc, null);
  assert.equal(b.state.activeRoute, "direct");
  assert.equal(b.ui.directVideo.srcObject, stream);
  assert.equal(b.ui.directVideo.paused, false);
  assert.equal(samples, 1);
});

test("hot-backup mode never schedules receiver retirement", () => {
  const b = browser();
  Object.assign(b.state, { role: "viewer", activeRoute: "direct" });
  b.ui.backupMode.value = "hot";
  b.scheduleBackupRelease();
  assert.equal(b.timers.size, 0);
});

test("publisher pause and wake serialize encoding activity without removing tracks", async () => {
  const b = browser();
  const applied = [];
  const sender = { getParameters: () => ({ encodings: [{ rid: "a" }, { rid: "m" }] }), async setParameters(p) { applied.push(p.encodings.map((e) => e.active)); } };
  Object.assign(b.state, { role: "host", localStream: {}, pc: {} });
  b.state.sfuSenderTracks.set(sender, {});
  await b.requestSfuStandby(true);
  assert.equal(b.state.sfuStandby, true);
  await b.requestSfuStandby(false);
  assert.deepEqual(applied, [[false, false], [true, true]]);
  assert.equal(b.state.sfuStandby, false);
});

test("concurrent host starts cannot create duplicate PeerConnections while ICE awaits", async () => {
  const b = browser();
  let releaseIce;
  let created = 0;
  b.context.icePromise = new Promise((r) => { releaseIce = r; });
  vm.runInContext("getIceServers = () => icePromise; waitForIceGathering = async () => {};", b.context);
  b.context.RTCPeerConnection = class {
    constructor() { created++; this.connectionState = "new"; this.localDescription = {}; }
    addEventListener() {} async createOffer() { return {}; } async setLocalDescription() {} close() {}
  };
  Object.assign(b.state, { role: "host", localStream: { getTracks: () => [] }, participants: [{ id: "anna", role: "viewer" }] });
  const first = b.startHostDirectPeer("anna");
  const second = b.startHostDirectPeer("anna");
  assert.equal(b.state.directStarts.size, 1);
  releaseIce([]);
  await Promise.all([first, second]);
  assert.equal(created, 1);
  b.closeAllDirectConnections(false);
});

test("server preserves unknown counters and overwrites client report timestamps", () => {
  const q = CinemaRoom.prototype.sanitizeQuality.call({}, { reportedAt: 1, fps: null, packetLoss: null, framesDropped: null });
  assert.equal(q.fps, null);
  assert.equal(q.packetLoss, null);
  assert.equal(q.framesDropped, null);
  assert.equal(q.needsSfu, true);
  assert.ok(q.reportedAt > 1);
  assert.equal(q.qualityLimitationReason, "unknown");
});

test("zero decoded FPS is poor rather than excellent; absent metrics remain unknown", () => {
  const b = browser();
  assert.equal(b.healthState({ connected: true, fps: 0, packetLoss: 0, rttMs: 10, jitterMs: 0 }), "poor");
  assert.equal(b.healthState({ connected: true, fps: null, packetLoss: null }), "connecting");
});

test("bytes arriving without decoded frames cannot pass the P2P quality probe", async () => {
  const b = browser();
  let bytes = 0;
  b.context.testPc = { connectionState: "connected", async getStats() {
    bytes += 200000;
    return new Map([["video", { type: "inbound-rtp", kind: "video", bytesReceived: bytes, framesDecoded: 0, packetsReceived: 100, packetsLost: 0 }]]);
  } };
  const result = await vm.runInContext("measureInboundPath(testPc, 0)", b.context);
  assert.equal(result.usable, false);
  assert.equal(result.fps, 0);
});

test("host wakes senders before acknowledging an SFU backup request", async () => {
  const b = browser();
  const order = [];
  Object.assign(b.state, { role: "host", localStream: {}, pc: {}, sfuStandby: true, media: { version: "movie" }, participants: [{ id: "anna", role: "viewer" }] });
  const sender = { getParameters: () => ({ encodings: [{ active: false }] }), async setParameters(p) {
    assert.equal(p.encodings[0].active, true); order.push("wake");
  } };
  b.state.sfuSenderTracks.set(sender, {});
  b.state.ws = { readyState: 1, send(raw) { const message = JSON.parse(raw); order.push(message.signal.kind); } };
  await b.handleDirectSignal({ from: "anna", signal: { kind: "backup-needed", mediaVersion: "movie", requestId: "01234567-1234-1234-1234-012345678901" } });
  assert.deepEqual(order, ["wake", "backup-ready"]);
  assert.ok(b.state.sfuWakeUntil > Date.now());
});

test("server forwards backup wake signals only for the current publication and correct role", () => {
  const sent = [];
  const makeSocket = (id, role) => {
    let meta = { id, role };
    return { deserializeAttachment: () => meta, serializeAttachment: (m) => { meta = m; }, send: (raw) => sent.push(JSON.parse(raw)) };
  };
  const host = makeSocket("host", "host");
  const viewer = makeSocket("anna", "viewer");
  const room = Object.create(CinemaRoom.prototype);
  room.ctx = { getWebSockets: () => [host, viewer] };
  room.room = { activeMedia: { version: "movie" } };
  const send = (socket, to, kind, version) => room.webSocketMessage(socket, JSON.stringify({ type: "p2p:signal", to,
    signal: { kind, mediaVersion: version, requestId: "01234567-1234-1234-1234-012345678901" } }));
  send(viewer, "host", "backup-needed", "old-movie");
  send(viewer, "host", "backup-ready", "movie");
  assert.equal(sent.length, 0);
  send(viewer, "host", "backup-needed", "movie");
  assert.equal(sent[0].signal.kind, "backup-needed");
  send(host, "anna", "backup-ready", "movie");
  assert.equal(sent[1].signal.kind, "backup-ready");
});

test("failed sender wake never acknowledges a live backup", async () => {
  const b = browser();
  const sent = [];
  Object.assign(b.state, { role: "host", localStream: {}, pc: {}, sfuStandby: true, media: { version: "movie" }, participants: [{ id: "anna", role: "viewer" }] });
  b.state.sfuSenderTracks.set({ getParameters: () => ({ encodings: [{}] }), async setParameters() { throw new Error("unsupported"); } }, {});
  b.state.ws = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) };
  await b.handleDirectSignal({ from: "anna", signal: { kind: "backup-needed", mediaVersion: "movie", requestId: "request" } });
  assert.equal(sent.length, 0);
  assert.equal(b.state.sfuStandby, true);
});

test("page startup binds new controls without requiring a live room", async () => {
  const b = browser();
  b.context.location = { pathname: "/", search: "" };
  b.context.URLSearchParams = URLSearchParams;
  b.context.window = { addEventListener() {} };
  b.context.document.addEventListener = () => {};
  b.context.document.querySelectorAll = () => [];
  await vm.runInContext("initialize()", b.context);
  assert.match(b.ui.closedMessage.textContent, /no public rooms/);
});

test("SFU warmup decoder retires without dropping audio which arrives later", async () => {
  const b = browser();
  let trackHandler;
  const tracks = [];
  b.context.MediaStream = class { addTrack(track) { tracks.push(track); } };
  b.context.RTCPeerConnection = class {
    constructor() { this.connectionState = "connected"; }
    addEventListener(kind, fn) { if (kind === "track") trackHandler = fn; }
    removeEventListener() {} close() {}
    async setRemoteDescription() { trackHandler({ track: { kind: "video" } }); }
    async createAnswer() { return {}; } async setLocalDescription() {}
  };
  vm.runInContext(`
    wakeSfuPublisher = async () => true;
    getIceServers = async () => [];
    createMediaSession = async () => "session";
    api = async () => ({ requiresImmediateRenegotiation: true, sessionDescription: {} });
    waitForIceGathering = async () => {};
    waitForConnected = async () => {};
    waitForVideoFrame = async () => true;
    warmVideo = async () => true;
    switchViewerRoute = async () => true;
    startStats = () => {};
  `, b.context);
  Object.assign(b.state, { role: "viewer", media: { version: "movie" }, activeRoute: "none" });
  assert.equal(await vm.runInContext("subscribeToBroadcast()", b.context), true);
  assert.doesNotThrow(() => trackHandler({ track: { kind: "audio" } }));
  assert.deepEqual(tracks.map((track) => track.kind), ["video", "audio"]);
});
