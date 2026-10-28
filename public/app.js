import { RoomConnection, JOIN_RELEASE } from "./room-connection.js?v=2.3.10-external-audio-20261028";
import { normaliseLocalState, localMovieClock, localCaptureDecision, formatMovieTime } from "./local-media.js?v=2.3.10-external-audio-20261028";

const $ = (id) => document.getElementById(id);
// Small private rooms prefer direct media because it has performed better than
// the current SFU route in real-world testing. The Host sends one encoded copy
// per viewer, so larger rooms still switch to SFU fan-out.
const MAX_DIRECT_VIEWERS = 3;
const HEARTBEAT_INTERVAL_MS = 25_000;
const DIRECT_DISCONNECT_GRACE_MS = 12_000;
const DIRECT_FAILURE_COOLDOWN_MS = 10 * 60_000;
const DIRECT_RETRY_DELAYS_MS = [15_000, 60_000, 5 * 60_000, 10 * 60_000];
const DIRECT_PROBE_RETRY_DELAYS_MS = [60_000, 3 * 60_000, 10 * 60_000];
const DIRECT_PROBE_SAMPLE_MS = 6_000;
const DIRECT_PROBE_STABLE_LOSS_PERCENT = 3;
const DIRECT_PROBE_MAX_IMPROVED_LOSS_PERCENT = 6;
const FIRST_FRAME_TIMEOUT_MS = 12_000;
const MEDIA_WATCHDOG_INTERVAL_MS = 2_500;
const MEDIA_STALL_WITH_AUDIO_MS = 7_500;
const MEDIA_STALL_HARD_MS = 15_000;
const MEDIA_RECOVERY_COOLDOWN_MS = 12_000;
const DIRECT_HIGH_LOSS_PERCENT = 8;
const DIRECT_HIGH_LOSS_SAMPLES = 2;

const ui = Object.fromEntries([
  "connectionPill", "connectionText", "entryView", "inviteEntry", "ownerEntry", "ownerDashboard", "closedEntry",
  "closedMessage", "guestName", "enterRoomButton", "inviteRoleText", "inviteError", "ownerLoginForm", "ownerPassword",
  "ownerError", "createRoomForm", "roomTitle", "roomHours", "dashboardError", "logoutButton", "recentRooms",
  "refreshRooms", "cinemaView", "cinemaTitle", "copyGuestLink", "lockRoom", "leaveRoom", "stage", "remoteVideo",
  "directVideo", "previewVideo", "stageEmpty", "stageKicker", "stageTitle", "stageHint", "liveBadge", "reactionLayer", "startShare",
  "stopShare", "openMovie", "qualitySelect", "pictureInPicture", "fullscreenButton", "shareTip",
  "peopleCount", "participants", "healthLabel", "routeValue", "transportValue", "bitrateValue", "latencyValue",
  "lossValue", "resolutionValue", "sourceValue", "availableBitrateValue", "frameDropsValue", "limitationValue", "routeStatusValue", "routeSwitchesValue", "hostDiagnostics", "diagnosticList", "chatLog", "chatForm", "chatInput",
  "inviteLabel", "inviteRole", "inviteHours", "createInvite", "inviteResult", "newInviteLink", "copyNewInvite",
  "inviteList", "endRoom", "toast", "busyOverlay", "captionOverlay", "captionSelect", "captionFile",
  "loadCaptions", "deleteCaption", "captionSize", "captionClockToggle", "captionBack", "captionForward", "captionOffset", "sourceThrottleWarning",
  "joinStatus", "joinDiagnosticText", "cancelJoin",
  "localPlayback", "localPlayerStatus", "localPlayPause", "localSeekBack", "localSeekForward", "localSeek", "localTime", "localShare",
].map((id) => [id, $(id)]));

const state = {
  token: "",
  claims: null,
  role: "viewer",
  roomId: "",
  room: null,
  name: "",
  clientId: getClientId(),
  ws: null,
  myId: null,
  participants: [],
  pc: null,
  pendingSfuPc: null,
  sfuStream: null,
  sfuReady: false,
  sfuDisconnectTimer: null,
  sessionId: "",
  localStream: null,
  media: null,
  connected: false,
  reconnectTimer: null,
  reconnectAttempt: 0,
  intentionalClose: false,
  defaultGuestToken: "",
  invites: [],
  statsTimer: null,
  previousRtp: new Map(),
  wakeLock: null,
  seenEvents: new Set(),
  subscriptionGeneration: 0,
  subscriptionPending: false,
  directPeers: new Map(),
  directPc: null,
  directStream: null,
  pendingDirectPc: null,
  pendingDirectStream: null,
  directReady: false,
  directCooldownUntil: 0,
  directFallbackPc: null,
  directPeerCooldowns: new Map(),
  directActivationGeneration: 0,
  directProbePc: null,
  directProbePromise: null,
  directProbeFailures: 0,
  lastDirectProbe: null,
  directProbeTimer: null,
  directProbeScheduleGeneration: 0,
  directFallbackTimers: new Map(),
  directRetryTimers: new Map(),
  directRetryAttempts: new Map(),
  directDisconnectTimers: new Map(),
  directPresenceTimers: new Map(),
  heartbeatTimer: null,
  captionTracks: [],
  captionOffsetSeconds: 0,
  captionTimer: null,
  captionLoadGeneration: 0,
  captionClock: null,
  captionClockLastSentAt: 0,
  playerChannel: null,
  playerChannelId: "",
  playerState: null,
  localCaptureChannelId: "",
  localCaptureVerified: false,
  localSeeking: false,
  localPlayerTimer: null,
  sourceThrottleSamples: 0,
  sourceHealthySamples: 0,
  sourceThrottleWarnedAt: 0,
  sfuSenderTracks: new Map(),
  sfuStandby: false,
  sfuStandbyDesired: false,
  sfuSwitchPromise: Promise.resolve(),
  sfuStandbyTimer: null,
  turnNoticeShown: false,
  activeRoute: "none",
  routeSwitchGeneration: 0,
  routeSwitches: 0,
  routeReason: "Preparing both routes",
  hasWelcomed: false,
  playbackWatchdogTimer: null,
  mediaProgress: new WeakMap(),
  stallRecoveryPromise: null,
  lastStallRecoveryAt: 0,
  directHighLossSamples: 0,
  controlRestoreCount: 0,
  controlRestoreNotice: null,
  lastControlClose: null,
  joinInProgress: false,
};

const roomConnection = new RoomConnection({
  requestTicket: (signal) => api(`/api/rooms/${state.roomId}/ticket`, {
    method: "POST", signal,
    body: JSON.stringify({ name: state.name, clientId: state.clientId }),
  }),
  socketUrl: (ticket) => {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${location.host}/ws?room=${encodeURIComponent(ticket.room.id)}&ticket=${encodeURIComponent(ticket.ticket)}`;
  },
  onSocket: (socket) => {
    state.ws = socket;
    if (!socket) { state.connected = false; stopHeartbeat(); }
  },
  onReady: (ticket) => {
    state.room = ticket.room;
    state.connected = true;
    state.reconnectAttempt = 0;
    startHeartbeat();
    setConnection("Connected", "online");
    if (!state.hasWelcomed) showCinema();
  },
  onMessage: (raw) => handleSocketMessage(raw),
  onDisconnect: (event, socket) => handleSocketClose(event, socket),
  onProgress: (progress) => updateJoinProgress(progress),
});

function updateJoinProgress({ phase, attempt, maxAttempts, code }) {
  const phases = {
    ticket: "Requesting admission / 正在申请入场",
    handshake: "Connecting to the room / 正在建立房间连接",
    welcome: "Waiting for room confirmation / 正在等待房间确认",
    retry_wait: "Connection interrupted; retrying / 正在清理并重试",
    ready: "Room connected / 房间已连接",
    failed: "Unable to join; copy diagnostics below / 加入失败，可复制连接诊断",
    cancelled: "Joining cancelled / 已取消加入",
  };
  if (phases[phase]) {
    const text = `${phases[phase]} (${attempt}/${maxAttempts})${code ? ` [${code}]` : ""}`;
    ui.joinStatus.textContent = text;
    if (!state.hasWelcomed && state.joinInProgress) ui.busyOverlay.querySelector("p").textContent = text;
  }
  const last = roomConnection.diagnostics().events.slice(-12);
  ui.joinDiagnosticText.textContent = `${JOIN_RELEASE}\n${last.map((event) =>
    `${event.at} · ${event.phase} · attempt ${event.attempt}${event.code ? ` · ${event.code}` : ""}${event.status ? ` · HTTP ${event.status}` : ""}${event.closeCode ? ` · close ${event.closeCode}` : ""}`,
  ).join("\n")}`;
}

async function copyConnectionDiagnostics() {
  const report = { ...roomConnection.diagnostics(), online: navigator.onLine,
    visibility: document.visibilityState };
  await copyText(JSON.stringify(report, null, 2), "Connection diagnostics copied / 已复制连接诊断");
}

function getClientId() {
  // A participant identity must survive refreshes and network hand-offs, but it
  // must not be shared by every cinema tab. A localStorage id made two open
  // tabs continually replace each other's WebSocket connection.
  const key = "cinema.tabClientId";
  let value = sessionStorage.getItem(key);
  if (!value) {
    value = localStorage.getItem("cinema.clientId") || crypto.randomUUID();
    sessionStorage.setItem(key, value);
    localStorage.removeItem("cinema.clientId");
  }
  return value;
}

function decodeToken(token) {
  try {
    const payload = token.split(".")[0].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(padded), (char) => char.charCodeAt(0))));
  } catch {
    return null;
  }
}

function setVisible(element, visible) {
  element?.classList.toggle("hidden", !visible);
}

function setConnection(text, mode = "") {
  ui.connectionText.textContent = text;
  ui.connectionPill.classList.toggle("online", mode === "online");
  ui.connectionPill.classList.toggle("warn", mode === "warn");
}

function updateRouteStatus(reason = state.routeReason) {
  state.routeReason = reason;
  if (ui.routeStatusValue) {
    ui.routeStatusValue.textContent = reason;
    ui.routeStatusValue.title = reason;
  }
  if (ui.routeSwitchesValue) ui.routeSwitchesValue.textContent = String(state.routeSwitches);
}

function videoHasFrame(video) {
  return Boolean(video?.srcObject && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0);
}

function waitForVideoFrame(video, timeoutMs = FIRST_FRAME_TIMEOUT_MS) {
  if (videoHasFrame(video)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    let frameHandle = 0;
    const finish = (ready) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      video.removeEventListener("loadeddata", check);
      video.removeEventListener("playing", check);
      if (frameHandle && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(frameHandle);
      resolve(ready);
    };
    const check = () => {
      if (videoHasFrame(video)) finish(true);
    };
    const timeout = setTimeout(() => finish(videoHasFrame(video)), timeoutMs);
    video.addEventListener("loadeddata", check);
    video.addEventListener("playing", check);
    if (video.requestVideoFrameCallback) {
      frameHandle = video.requestVideoFrameCallback(() => finish(true));
    }
  });
}

async function warmVideo(video, stream) {
  if (video.srcObject !== stream) video.srcObject = stream;
  video.muted = true;
  try { await video.play(); } catch {}
  return waitForVideoFrame(video);
}

async function switchViewerRoute(route, reason) {
  if (state.role !== "viewer") return false;
  const generation = ++state.routeSwitchGeneration;
  const target = route === "direct" ? ui.directVideo : ui.remoteVideo;
  const targetPc = route === "direct" ? state.directPc : state.pc;
  const ready = route === "direct"
    ? state.directReady && state.directPc?.connectionState === "connected"
    : state.sfuReady && state.pc?.connectionState === "connected";
  if (!ready || !videoHasFrame(target)) return false;

  target.muted = true;
  target.controls = true;
  try { await target.play(); } catch { toast("Tap the video once to enable audio"); }
  const currentPc = route === "direct" ? state.directPc : state.pc;
  if (generation !== state.routeSwitchGeneration || currentPc !== targetPc || !videoHasFrame(target)) return false;

  const previousRoute = state.activeRoute;
  // Commit the visible route only after the replacement has produced a frame.
  // This prevents an older async switch from overwriting a newer route.
  ui.directVideo.muted = true;
  ui.remoteVideo.muted = true;
  ui.directVideo.classList.toggle("is-active", route === "direct");
  ui.remoteVideo.classList.toggle("is-active", route === "sfu");
  ui.previewVideo.classList.remove("is-active");
  target.muted = false;
  ui.stageEmpty.classList.add("hidden");
  setVisible(ui.liveBadge, true);
  if (previousRoute !== "none" && previousRoute !== route) state.routeSwitches += 1;
  state.activeRoute = route;
  if (route === "direct") {
    cancelScheduledDirectProbe();
  } else if (state.media && directFanoutAvailable() && !state.directPc && !state.pendingDirectPc) {
    scheduleViewerDirectProbe(30_000, "waiting for the first background P2P probe");
  }
  state.mediaProgress.delete(route === "direct" ? state.directPc : state.pc);
  updateRouteStatus(reason);
  setConnection(route === "direct" ? "Direct stream connected" : "Backup stream connected", "online");
  state.previousRtp.clear();
  startStats();
  startPlaybackWatchdog();
  return true;
}

async function readInboundMediaCounters(pc) {
  if (!pc || pc.connectionState === "closed") return null;
  const reports = await pc.getStats();
  let videoFrames = 0;
  let videoBytes = 0;
  let audioBytes = 0;
  let hasFrameCounter = false;
  reports.forEach((report) => {
    if (report.type !== "inbound-rtp" || report.isRemote) return;
    const kind = report.kind || report.mediaType;
    if (kind === "video") {
      videoBytes += Number(report.bytesReceived) || 0;
      if (Number.isFinite(Number(report.framesDecoded))) {
        hasFrameCounter = true;
        videoFrames += Number(report.framesDecoded) || 0;
      } else if (Number.isFinite(Number(report.framesReceived))) {
        hasFrameCounter = true;
        videoFrames += Number(report.framesReceived) || 0;
      }
    }
    if (kind === "audio") audioBytes += Number(report.bytesReceived) || 0;
  });
  return { videoFrames, videoBytes, audioBytes, hasFrameCounter };
}

function recordInboundProgress(pc, counters, now = performance.now()) {
  const previous = state.mediaProgress.get(pc);
  if (!previous) {
    const first = { ...counters, lastVideoAt: now, lastAudioAt: now };
    state.mediaProgress.set(pc, first);
    return first;
  }
  const presentationAvailable = counters.hasPresentationCounter && previous.hasPresentationCounter;
  const videoAdvanced = presentationAvailable
    ? counters.presentedFrames > previous.presentedFrames
    : counters.hasFrameCounter && previous.hasFrameCounter
      ? counters.videoFrames > previous.videoFrames
      : counters.videoBytes > previous.videoBytes;
  const audioAdvanced = counters.audioBytes > previous.audioBytes;
  const next = {
    ...counters,
    lastVideoAt: videoAdvanced ? now : previous.lastVideoAt,
    lastAudioAt: audioAdvanced ? now : previous.lastAudioAt,
  };
  state.mediaProgress.set(pc, next);
  return next;
}

async function waitForInboundVideoProgress(pc, timeoutMs = 3_500) {
  if (!pc || pc.connectionState !== "connected") return false;
  const baseline = await readInboundMediaCounters(pc);
  if (!baseline) return false;
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline && pc.connectionState === "connected") {
    await new Promise((resolve) => setTimeout(resolve, 350));
    const current = await readInboundMediaCounters(pc);
    if (!current) return false;
    const advanced = current.hasFrameCounter && baseline.hasFrameCounter
      ? current.videoFrames > baseline.videoFrames
      : current.videoBytes > baseline.videoBytes;
    if (advanced) {
      recordInboundProgress(pc, current);
      return true;
    }
  }
  return false;
}

async function recoverStalledPlayback(route, pc, stalledForMs) {
  if (state.stallRecoveryPromise || Date.now() - state.lastStallRecoveryAt < MEDIA_RECOVERY_COOLDOWN_MS) return;
  state.lastStallRecoveryAt = Date.now();
  state.stallRecoveryPromise = (async () => {
    const seconds = Math.max(1, Math.round(stalledForMs / 1000));
    setConnection("Video stalled; recovering without a refresh", "warn");
    updateRouteStatus(`${route === "direct" ? "P2P" : "SFU"} decoded no new frames for ${seconds}s · preparing replacement`);

    if (route === "direct") {
      const stalledPc = pc;
      const backupFresh = await ensureFreshSfuBackup();
      if (backupFresh && state.directPc === stalledPc && state.activeRoute === "direct") {
        const host = state.participants.find((participant) => participant.role === "host");
        await fallbackFromDirect(stalledPc, host?.id || "", "P2P video stopped decoding");
      } else {
        updateRouteStatus("P2P stalled · backup has no fresh frame yet, keeping the last picture");
      }
      return;
    }

    // An SFU PeerConnection may remain `connected` even after inbound video
    // has stopped. Replace it make-before-break; subscribeToBroadcast keeps the
    // old picture until the replacement has decoded its first frame.
    if (state.activeRoute === "sfu" && state.pc === pc && state.media) {
      const restored = await subscribeToBroadcast(true);
      if (!restored) updateRouteStatus("SFU video stalled · retrying while the last picture remains visible");
    }
  })().catch((error) => {
    console.warn("Automatic playback recovery failed", error);
  }).finally(() => {
    state.stallRecoveryPromise = null;
    const activePc = state.activeRoute === "direct" ? state.directPc : state.pc;
    if (activePc) state.mediaProgress.delete(activePc);
  });
  await state.stallRecoveryPromise;
}

async function ensureFreshSfuBackup() {
  let backupFresh = state.sfuReady
    && state.pc?.connectionState === "connected"
    && await waitForInboundVideoProgress(state.pc);
  if (!backupFresh && state.media) {
    const replaced = await subscribeToBroadcast(true);
    backupFresh = Boolean(replaced
      && state.sfuReady
      && state.pc?.connectionState === "connected"
      && await waitForInboundVideoProgress(state.pc));
  }
  return backupFresh;
}

async function recoverPoorDirectQuality(pc, packetLoss) {
  if (state.stallRecoveryPromise || Date.now() - state.lastStallRecoveryAt < MEDIA_RECOVERY_COOLDOWN_MS) return;
  state.lastStallRecoveryAt = Date.now();
  state.stallRecoveryPromise = (async () => {
    if (state.directPc !== pc || state.activeRoute !== "direct") return;
    setConnection("P2P is losing packets; checking the backup route", "warn");
    updateRouteStatus(`P2P loss stayed at ${packetLoss.toFixed(1)}% · verifying hot SFU backup`);
    const backupFresh = await ensureFreshSfuBackup();
    if (!backupFresh || state.directPc !== pc || state.activeRoute !== "direct") {
      updateRouteStatus(`P2P loss is ${packetLoss.toFixed(1)}% · backup is not healthier yet, keeping P2P`);
      return;
    }
    const [direct, backup] = await Promise.all([
      measureInboundPath(pc),
      measureInboundPath(state.pc),
    ]);
    if (state.directPc !== pc || state.activeRoute !== "direct") return;
    const backupFpsHealthy = !backup.fps || backup.fps >= 18;
    const backupIsClearlyBetter = backup.usable
      && backupFpsHealthy
      && (backup.packetLoss <= DIRECT_PROBE_STABLE_LOSS_PERCENT
        || (direct.usable && backup.packetLoss + 2 <= direct.packetLoss));
    if (backupIsClearlyBetter) {
      const host = state.participants.find((participant) => participant.role === "host");
      await fallbackFromDirect(
        pc,
        host?.id || "",
        `P2P measured ${direct.packetLoss.toFixed(1)}% loss; SFU measured ${backup.packetLoss.toFixed(1)}%`,
      );
    } else {
      updateRouteStatus(`P2P measured ${direct.packetLoss.toFixed(1)}% loss · SFU is not measurably better, keeping P2P`);
      state.mediaProgress.delete(pc);
    }
  })().catch((error) => {
    console.warn("Poor direct-route recovery failed", error);
  }).finally(() => {
    state.stallRecoveryPromise = null;
  });
  await state.stallRecoveryPromise;
}

function nextDirectProbeDelay() {
  const index = Math.min(state.directProbeFailures, DIRECT_PROBE_RETRY_DELAYS_MS.length - 1);
  const delay = DIRECT_PROBE_RETRY_DELAYS_MS[index];
  state.directProbeFailures += 1;
  return delay;
}

function directProbeDelayLabel(delayMs) {
  if (delayMs < 120_000) return `${Math.round(delayMs / 1000)} seconds`;
  return `${Math.round(delayMs / 60_000)} minutes`;
}

function cancelScheduledDirectProbe() {
  clearTimeout(state.directProbeTimer);
  state.directProbeTimer = null;
  state.directProbeScheduleGeneration += 1;
}

function scheduleViewerDirectProbe(delayMs, reason = "", replace = false) {
  if (state.role !== "viewer" || !directFanoutAvailable()) return;
  if (state.directProbeTimer && !replace) return;
  if (replace) cancelScheduledDirectProbe();
  const generation = ++state.directProbeScheduleGeneration;
  state.directProbeTimer = setTimeout(() => {
    if (generation !== state.directProbeScheduleGeneration) return;
    state.directProbeTimer = null;
    if (state.role !== "viewer" || !state.media || state.activeRoute !== "sfu" || !directFanoutAvailable()) return;
    if (state.pendingDirectPc || state.directProbePromise || state.directPc) {
      scheduleViewerDirectProbe(15_000, "waiting for the current P2P candidate");
      return;
    }
    if (!state.connected || state.ws?.readyState !== WebSocket.OPEN) {
      scheduleViewerDirectProbe(15_000, "waiting for the control connection");
      return;
    }
    const host = state.participants.find((participant) => participant.role === "host");
    if (!host) {
      scheduleViewerDirectProbe(15_000, "waiting for the host");
      return;
    }
    state.directCooldownUntil = 0;
    updateRouteStatus(`SFU remains active · requesting a background P2P probe${reason ? ` (${reason})` : ""}`);
    sendSocket({ type: "p2p:signal", to: host.id, signal: { kind: "retry" } });
    // If the offer is lost, ask again without increasing the quality-failure
    // backoff. acceptDirectOffer cancels this deadline as soon as an offer lands.
    scheduleViewerDirectProbe(30_000, "previous probe offer did not arrive");
  }, Math.max(1_000, delayMs));
}

async function inboundVideoSnapshot(pc) {
  if (!pc || pc.connectionState !== "connected") return null;
  const reports = await pc.getStats();
  const candidates = [];
  reports.forEach((report) => {
    const kind = report.kind || report.mediaType;
    if (report.type === "inbound-rtp" && !report.isRemote && kind === "video") candidates.push(report);
  });
  candidates.sort((left, right) => (Number(right.bytesReceived) || 0) - (Number(left.bytesReceived) || 0));
  const video = candidates[0];
  if (!video) return null;
  return {
    at: performance.now(),
    bytes: Number(video.bytesReceived) || 0,
    packets: Number(video.packetsReceived) || 0,
    lost: Math.max(0, Number(video.packetsLost) || 0),
    frames: Number(video.framesDecoded) || 0,
    reportedFps: Math.round(Number(video.framesPerSecond) || 0),
    width: Number(video.frameWidth) || 0,
    height: Number(video.frameHeight) || 0,
  };
}

async function measureInboundPath(pc, durationMs = DIRECT_PROBE_SAMPLE_MS) {
  const first = await inboundVideoSnapshot(pc);
  if (!first) return { usable: false, packetLoss: 100, fps: 0, bitrateKbps: 0, width: 0, height: 0 };
  const deadline = performance.now() + durationMs;
  while (performance.now() < deadline) {
    if (pc.connectionState !== "connected") return { usable: false, packetLoss: 100, fps: 0, bitrateKbps: 0, width: 0, height: 0 };
    await new Promise((resolve) => setTimeout(resolve, Math.min(500, deadline - performance.now())));
  }
  const last = await inboundVideoSnapshot(pc);
  if (!last) return { usable: false, packetLoss: 100, fps: 0, bitrateKbps: 0, width: 0, height: 0 };
  const elapsedMs = Math.max(1, last.at - first.at);
  const packets = Math.max(0, last.packets - first.packets);
  const lost = Math.max(0, last.lost - first.lost);
  const frames = Math.max(0, last.frames - first.frames);
  const bytes = Math.max(0, last.bytes - first.bytes);
  const packetLoss = packets + lost > 0 ? Number(((lost / (packets + lost)) * 100).toFixed(1)) : 0;
  return {
    usable: frames > 0 || bytes > 50_000,
    inactive: frames === 0 && bytes <= 50_000,
    packetLoss,
    fps: last.reportedFps || Math.round((frames * 1000) / elapsedMs),
    bitrateKbps: Math.round((bytes * 8) / elapsedMs),
    width: last.width,
    height: last.height,
  };
}

async function validateDirectCandidate(pc) {
  const backupPc = state.sfuReady && state.pc?.connectionState === "connected" ? state.pc : null;
  updateRouteStatus("SFU remains visible · measuring a background P2P candidate for 6 seconds");
  const [direct, backup] = await Promise.all([
    measureInboundPath(pc),
    backupPc ? measureInboundPath(backupPc) : Promise.resolve(null),
  ]);
  const fpsHealthy = !direct.fps || direct.fps >= 18;
  const minimumDirectWidth = backup?.width ? Math.min(1280, Math.round(backup.width * 0.65)) : 0;
  const resolutionHealthy = !minimumDirectWidth || !direct.width || direct.width >= minimumDirectWidth;
  const stable = direct.usable
    && fpsHealthy
    && resolutionHealthy
    && direct.packetLoss <= DIRECT_PROBE_STABLE_LOSS_PERCENT;
  const improvesBadBackup = direct.usable
    && fpsHealthy
    && resolutionHealthy
    && direct.packetLoss <= DIRECT_PROBE_MAX_IMPROVED_LOSS_PERCENT
    && backup?.usable
    && direct.packetLoss + 2 <= backup.packetLoss;
  const result = {
    direct,
    backup,
    preferred: stable || improvesBadBackup,
    indeterminate: !direct.usable && (!backup || !backup.usable),
  };
  state.lastDirectProbe = result;
  return result;
}

function deferDirectAttempt(hostId, reason, indeterminate = false) {
  const delay = indeterminate ? DIRECT_PROBE_RETRY_DELAYS_MS[0] : nextDirectProbeDelay();
  state.directCooldownUntil = Date.now() + delay;
  updateRouteStatus(`SFU stays active · P2P probe rejected (${reason}) · retry in ${directProbeDelayLabel(delay)}`);
  setConnection("Backup stream connected; P2P will be tested again", "online");
  if (hostId) {
    sendSocket({ type: "p2p:signal", to: hostId, signal: { kind: "defer", retryAfterMs: delay } });
  }
  scheduleViewerDirectProbe(delay, indeterminate ? "video appears paused" : "previous P2P probe was not healthier", true);
  return delay;
}

function rejectDirectCandidate(pc, hostId, result) {
  const loss = Number.isFinite(result?.direct?.packetLoss) ? `${result.direct.packetLoss}% loss` : "no stable frames";
  deferDirectAttempt(hostId, loss, Boolean(result?.indeterminate));
  closeViewerDirect(false, pc);
}

function monitorDirectPathQuality(quality, pc) {
  if (state.role !== "viewer" || state.activeRoute !== "direct" || state.directPc !== pc) {
    state.directHighLossSamples = 0;
    return;
  }
  if (quality.packetLoss >= DIRECT_HIGH_LOSS_PERCENT) {
    state.directHighLossSamples += 1;
  } else if (quality.packetLoss <= 3) {
    state.directHighLossSamples = 0;
  } else {
    state.directHighLossSamples = Math.max(0, state.directHighLossSamples - 1);
  }
  if (state.directHighLossSamples < DIRECT_HIGH_LOSS_SAMPLES) return;
  state.directHighLossSamples = 0;
  recoverPoorDirectQuality(pc, quality.packetLoss);
}

async function checkViewerPlaybackHealth() {
  if (state.role !== "viewer" || !state.media || !["direct", "sfu"].includes(state.activeRoute)) return;
  if (document.visibilityState !== "visible" || state.stallRecoveryPromise) return;
  const route = state.activeRoute;
  const pc = route === "direct" ? state.directPc : state.pc;
  if (!pc || pc.connectionState !== "connected") return;

  const video = route === "direct" ? ui.directVideo : ui.remoteVideo;
  if (video.paused) {
    try { await video.play(); } catch {}
  }

  try {
    const counters = await readInboundMediaCounters(pc);
    if (!counters || pc !== (route === "direct" ? state.directPc : state.pc) || route !== state.activeRoute) return;
    const playbackQuality = video.getVideoPlaybackQuality?.();
    counters.hasPresentationCounter = Number.isFinite(Number(playbackQuality?.totalVideoFrames));
    counters.presentedFrames = Number(playbackQuality?.totalVideoFrames) || 0;
    const now = performance.now();
    const progress = recordInboundProgress(pc, counters, now);
    const stalledForMs = now - progress.lastVideoAt;
    const audioStillMoving = now - progress.lastAudioAt <= MEDIA_WATCHDOG_INTERVAL_MS * 2.5;
    const threshold = audioStillMoving ? MEDIA_STALL_WITH_AUDIO_MS : MEDIA_STALL_HARD_MS;
    if (stalledForMs >= threshold) await recoverStalledPlayback(route, pc, stalledForMs);
  } catch (error) {
    console.warn("Playback watchdog sample failed", error);
  }
}

function startPlaybackWatchdog() {
  if (state.playbackWatchdogTimer || state.role !== "viewer") return;
  state.playbackWatchdogTimer = setInterval(checkViewerPlaybackHealth, MEDIA_WATCHDOG_INTERVAL_MS);
}

function stopPlaybackWatchdog() {
  clearInterval(state.playbackWatchdogTimer);
  state.playbackWatchdogTimer = null;
  state.mediaProgress = new WeakMap();
  state.stallRecoveryPromise = null;
}

function showHostPreview(stream) {
  ui.previewVideo.srcObject = stream;
  ui.previewVideo.classList.add("is-active");
  ui.remoteVideo.classList.remove("is-active");
  ui.directVideo.classList.remove("is-active");
  ui.stageEmpty.classList.add("hidden");
  state.activeRoute = "host";
  updateRouteStatus("Publishing SFU and preparing direct viewer routes");
}

let toastTimer;
function toast(message) {
  ui.toast.textContent = message;
  ui.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove("show"), 2300);
}

function setBusy(active, message = "Connecting to the cinema…") {
  ui.busyOverlay.querySelector("p").textContent = message;
  setVisible(ui.busyOverlay, active);
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (state.token) headers.set("Authorization", `Bearer ${state.token}`);
  if (state.clientId) headers.set("X-Cinema-Client", state.clientId);
  const response = await fetch(path, { ...options, headers, cache: "no-store" });
  let payload = {};
  try { payload = await response.json(); } catch {}
  if (!response.ok) {
    const error = new Error(payload.error || `Request failed (${response.status})`);
    error.code = payload.code;
    error.status = response.status;
    throw error;
  }
  return payload;
}

function storeInvite(token) {
  state.token = token;
  state.claims = decodeToken(token);
  state.role = state.claims?.role === "host" ? "host" : "viewer";
  state.roomId = state.claims?.room || "";
  sessionStorage.setItem("cinema.invite", token);
  sessionStorage.setItem("cinema.room", state.roomId);
}

function inviteUrl(token) {
  return `${location.origin}/?invite=${encodeURIComponent(token)}`;
}

async function copyText(text, success = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    toast(success);
  } catch {
    const field = document.createElement("textarea");
    field.value = text;
    document.body.appendChild(field);
    field.select();
    document.execCommand("copy");
    field.remove();
    toast(success);
  }
}

function showClosed(message) {
  state.intentionalClose = true;
  clearTimeout(state.reconnectTimer);
  stopHeartbeat();
  roomConnection.cancel(4000, "Screening unavailable");
  cancelScheduledDirectProbe();
  if (state.directPc || state.pendingDirectPc || state.directPeers.size) closeAllDirectConnections(false);
  [ui.inviteEntry, ui.ownerEntry, ui.ownerDashboard].forEach((element) => setVisible(element, false));
  setVisible(ui.closedEntry, true);
  ui.closedMessage.textContent = message;
}

async function initialize() {
  bindEvents();
  const params = new URLSearchParams(location.search);
  const incoming = params.get("invite");
  if (incoming) {
    storeInvite(incoming);
    history.replaceState(null, "", "/");
  } else if (sessionStorage.getItem("cinema.invite") && location.pathname !== "/host") {
    storeInvite(sessionStorage.getItem("cinema.invite"));
  }

  if (state.token) {
    if (!state.claims?.room || !["viewer", "host"].includes(state.claims.role)) {
      showClosed("This invitation is malformed. Ask your host for a new one.");
      return;
    }
    setVisible(ui.inviteEntry, true);
    ui.inviteRoleText.textContent = state.role === "host"
      ? "You've been trusted as a guest host. Enter a name your friends will recognize."
      : "Enter a name your friends will recognize.";
    ui.guestName.value = localStorage.getItem("cinema.displayName") || "";
    ui.guestName.focus();
    return;
  }

  if (location.pathname === "/host") {
    await initializeOwner();
    return;
  }
  showClosed("This cinema has no public rooms. Open a private invitation from your host.");
}

async function initializeOwner() {
  try {
    const [session, config] = await Promise.all([api("/api/admin/session"), api("/api/config")]);
    if (!config.ownerConfigured) {
      showClosed("Owner secrets are not configured yet. Follow DEPLOY.md, then return to /host.");
      return;
    }
    if (!config.realtimeConfigured) toast("Realtime SFU still needs to be configured");
    setVisible(session.authenticated ? ui.ownerDashboard : ui.ownerEntry, true);
    if (session.authenticated) await loadRecentRooms();
  } catch (error) {
    showClosed(error.message);
  }
}

async function ownerLogin(event) {
  event.preventDefault();
  ui.ownerError.textContent = "";
  try {
    await api("/api/admin/login", { method: "POST", body: JSON.stringify({ password: ui.ownerPassword.value }) });
    ui.ownerPassword.value = "";
    setVisible(ui.ownerEntry, false);
    setVisible(ui.ownerDashboard, true);
    await loadRecentRooms();
  } catch (error) {
    ui.ownerError.textContent = error.message;
  }
}

async function ownerLogout() {
  await api("/api/admin/logout", { method: "POST" });
  location.reload();
}

async function loadRecentRooms() {
  try {
    const { rooms = [] } = await api("/api/admin/rooms");
    ui.recentRooms.replaceChildren();
    if (!rooms.length) {
      const empty = document.createElement("p");
      empty.className = "muted compact";
      empty.textContent = "No rooms yet.";
      ui.recentRooms.appendChild(empty);
      return;
    }
    for (const room of rooms) {
      const row = document.createElement("div");
      row.className = "recent-room";
      const copy = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = room.title;
      const details = document.createElement("small");
      details.textContent = `${room.status} · ${new Date(room.createdAt).toLocaleString()}`;
      copy.append(title, details);
      row.appendChild(copy);
      const actions = document.createElement("div");
      actions.className = "recent-room-actions";
      if (room.status !== "ended" && room.expiresAt > Date.now()) {
        const open = document.createElement("button");
        open.className = "text-button";
        open.textContent = "Open";
        open.addEventListener("click", () => resumeRoom(room.id));
        actions.appendChild(open);
      }
      const remove = document.createElement("button");
      remove.className = "text-button delete-room-button";
      remove.textContent = "Delete";
      remove.addEventListener("click", () => deleteRecentRoom(room));
      actions.appendChild(remove);
      row.appendChild(actions);
      ui.recentRooms.appendChild(row);
    }
  } catch (error) {
    ui.dashboardError.textContent = error.message;
  }
}

async function deleteRecentRoom(room) {
  const warning = room.status === "ended"
    ? `Delete the history for “${room.title}”?`
    : `Delete “${room.title}”? Its invitations will stop working and anyone inside will be disconnected.`;
  if (!confirm(warning)) return;
  try {
    await api(`/api/admin/rooms/${room.id}`, { method: "DELETE" });
    await loadRecentRooms();
    toast("Room deleted");
  } catch (error) {
    ui.dashboardError.textContent = error.message;
  }
}

async function createRoom(event) {
  event.preventDefault();
  ui.dashboardError.textContent = "";
  setBusy(true, "Opening a private room…");
  try {
    const result = await api("/api/admin/rooms", {
      method: "POST",
      body: JSON.stringify({ title: ui.roomTitle.value, expiresInHours: Number(ui.roomHours.value) }),
    });
    state.defaultGuestToken = result.viewer.token;
    storeInvite(result.host.token);
    state.name = localStorage.getItem("cinema.ownerName") || "Jiahao";
    await connectToRoom();
  } catch (error) {
    ui.dashboardError.textContent = error.message;
  } finally {
    setBusy(false);
  }
}

async function resumeRoom(roomId) {
  setBusy(true, "Restoring the projection booth…");
  try {
    const result = await api(`/api/rooms/${roomId}/control/invite`, {
      method: "POST",
      body: JSON.stringify({ role: "host", label: "Owner", expiresInHours: 24 }),
    });
    storeInvite(result.invite.token);
    state.name = localStorage.getItem("cinema.ownerName") || "Jiahao";
    await connectToRoom();
  } catch (error) {
    ui.dashboardError.textContent = error.message;
  } finally {
    setBusy(false);
  }
}

async function enterInvitedRoom() {
  if (state.joinInProgress) return;
  const name = ui.guestName.value.trim();
  if (!name) {
    ui.inviteError.textContent = "Please enter your name.";
    return;
  }
  ui.inviteError.textContent = "";
  state.name = name;
  localStorage.setItem("cinema.displayName", name);
  setBusy(true);
  try {
    await connectToRoom();
  } catch (error) {
    if (["room_ended", "room_expired", "invite_invalid", "room_locked", "client_banned"].includes(error.code)) {
      showClosed(error.message);
    } else {
      ui.inviteError.textContent = error.message;
    }
  } finally {
    setBusy(false);
  }
}

async function connectToRoom(isReconnect = false) {
  state.intentionalClose = false;
  clearTimeout(state.reconnectTimer);
  state.joinInProgress = true;
  ui.enterRoomButton.disabled = true;
  setVisible(ui.cancelJoin, !state.hasWelcomed);
  try {
    return await roomConnection.connect();
  } finally {
    state.joinInProgress = false;
    ui.enterRoomButton.disabled = false;
    setVisible(ui.cancelJoin, false);
  }
}

function handleSocketClose(event, socket) {
  if (state.ws !== socket) return;
  state.connected = false;
  stopHeartbeat();
  state.lastControlClose = { code: event.code, reason: event.reason || "network interruption" };
  // The room WebSocket is control/signalling only. A brief control-plane
  // interruption must not tear down a healthy SFU/P2P movie connection or stop
  // the browser's screen-capture permission.
  setConnection("Control connection interrupted; media may continue", "warn");
  if (event.code === 4000 && event.reason === "Replaced by a newer connection") {
    // The same logical tab was opened elsewhere. Reconnecting here would kick
    // the newer socket back out and create an endless replace/reconnect loop.
    setConnection("This room is active in another tab", "warn");
    systemMessage("Another tab took over this room. Reload this tab only if you want it to take control.");
    return;
  }
  if (state.intentionalClose || [4003, 4004].includes(event.code)) {
    if (event.code === 4003) showClosed("Your access to this screening was removed.");
    if (event.code === 4004) showClosed("This screening has ended.");
    return;
  }
  scheduleReconnect();
}

function startHeartbeat() {
  stopHeartbeat();
  state.heartbeatTimer = setInterval(() => {
    sendSocket({ type: "ping", at: Date.now() });
    // This doubles as a small-room route watchdog. A failed direct attempt is
    // retried even if room presence does not otherwise change.
    if (state.role === "host") reconcileDirectRoute();
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
  state.heartbeatTimer = null;
}

function scheduleReconnect(immediate = false) {
  if (state.intentionalClose || state.connected || state.joinInProgress) return;
  clearTimeout(state.reconnectTimer);
  state.reconnectAttempt += 1;
  const delay = immediate ? 0 : Math.min(15_000, 800 * 2 ** Math.min(5, state.reconnectAttempt));
  setConnection(`Reconnecting in ${Math.ceil(delay / 1000)}s`, "warn");
  state.reconnectTimer = setTimeout(async () => {
    if (state.intentionalClose || state.connected || state.joinInProgress) return;
    try {
      await connectToRoom(true);
      noteControlRestored();
    } catch (error) {
      if (["room_ended", "room_expired", "invite_invalid", "room_locked", "client_banned"].includes(error.code)) showClosed(error.message);
      else if (error.code !== "join_cancelled") scheduleReconnect();
    }
  }, delay);
}

function noteControlRestored() {
  state.controlRestoreCount += 1;
  const code = state.lastControlClose?.code || 1006;
  const text = state.controlRestoreCount === 1
    ? `Control connection restored (code ${code}).`
    : `Control connection restored ×${state.controlRestoreCount} (last code ${code}).`;
  if (state.controlRestoreNotice?.isConnected) {
    state.controlRestoreNotice.textContent = text;
    ui.chatLog.scrollTop = ui.chatLog.scrollHeight;
    return;
  }
  state.controlRestoreNotice = systemMessage(text);
}

function showCinema() {
  setVisible(ui.entryView, false);
  setVisible(ui.cinemaView, true);
  document.querySelectorAll(".host-only").forEach((element) => setVisible(element, state.role === "host"));
  ui.cinemaTitle.textContent = state.room?.title || "Private screening";
  ui.qualitySelect.value = localStorage.getItem("cinema.quality") || "auto";
  ui.captionSize.value = localStorage.getItem("cinema.captionSize") || "compact";
  ui.captionOverlay.dataset.size = ui.captionSize.value;
  updateCaptionClockButton();
  updateStageEmpty();
}

function handleSocketMessage(raw) {
  let message;
  try { message = JSON.parse(raw); } catch { return; }
  if (message.type === "pong") return;
  if (message.eventId) {
    if (state.seenEvents.has(message.eventId)) return;
    state.seenEvents.add(message.eventId);
    if (state.seenEvents.size > 500) state.seenEvents.delete(state.seenEvents.values().next().value);
  }
  if (message.type === "welcome") {
    state.myId = message.id;
    state.role = message.role;
    state.room = message.room;
    state.media = message.media;
    state.participants = message.participants || [];
    syncCaptionLibrary(message.room?.captions || []);
    if (message.room?.captionClock) applyCaptionClock(message.room.captionClock);
    ui.cinemaTitle.textContent = message.room.title;
    renderParticipants();
    ui.lockRoom.textContent = message.room.locked ? "Unlock room" : "Lock room";
    if (!state.hasWelcomed) {
      systemMessage(`You entered as ${message.role}.`);
      state.hasWelcomed = true;
    }
    if (state.role === "host") refreshInvites();
    if (state.role === "viewer" && message.media) subscribeToBroadcast();
    return;
  }
  if (message.type === "room:presence") {
    state.participants = message.participants || [];
    renderParticipants();
    reconcileDirectRoute();
    return;
  }
  if (message.type === "peer:joined") {
    systemMessage(`${message.peer.name} joined.`);
    // New viewers begin on the SFU while their direct route negotiates.
    requestSfuStandby(false);
    // Do not close an existing media route just because the independent
    // control WebSocket reappeared. Presence reconciliation creates a route
    // only when the stable participant ID genuinely has none.
    reconcileDirectRoute();
  }
  if (message.type === "peer:reconnected") {
    systemMessage(`${message.peer.name} reconnected.`);
    // Reconnecting the control socket does not invalidate an already healthy
    // media PeerConnection. Presence reconciliation will create a new route
    // only when one is actually missing.
    reconcileDirectRoute();
  }
  if (message.type === "peer:left") systemMessage(`${message.peer.name} left.`);
  if (message.type === "chat") addChatMessage(message);
  if (message.type === "reaction") showReaction(message.emoji);
  if (message.type === "quality:update") updateParticipantQuality(message.participant);
  if (message.type === "captions:update") syncCaptionLibrary(message.captions || []);
  if (message.type === "caption:clock") applyCaptionClock(message.clock);
  if (message.type === "p2p:signal") handleDirectSignal(message);
  if (message.type === "room:lock") {
    state.room.locked = message.locked;
    ui.lockRoom.textContent = message.locked ? "Unlock room" : "Lock room";
    systemMessage(message.locked ? "The room is now locked." : "The room is open to invited guests again.");
  }
  if (message.type === "media:available") {
    state.media = message.media;
    systemMessage(`${message.media.broadcasterName} started the film.`);
    if (state.role === "viewer") subscribeToBroadcast();
    if (state.role === "host") reconcileDirectRoute();
  }
  if (message.type === "media:stopped") {
    state.media = null;
    closeAllDirectConnections(false);
    closePeerConnection();
    hideVideos();
    updateStageEmpty("The broadcast has stopped", "The host can start it again whenever they're ready.");
  }
  if (message.type === "room:ended") showClosed("The host ended this screening.");
}

function sendSocket(payload) {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(payload));
}

function directViewerIds() {
  return state.participants.filter((participant) => participant.role === "viewer").map((participant) => participant.id);
}

function directFanoutAvailable() {
  const count = directViewerIds().length;
  return count > 0 && count <= MAX_DIRECT_VIEWERS;
}

function clearDirectFallbackTimer(viewerId) {
  const timer = state.directFallbackTimers.get(viewerId);
  if (timer) clearTimeout(timer);
  state.directFallbackTimers.delete(viewerId);
}

function clearDirectDisconnectTimer(viewerId) {
  const timer = state.directDisconnectTimers.get(viewerId);
  if (timer) clearTimeout(timer);
  state.directDisconnectTimers.delete(viewerId);
}

function clearDirectRetryTimer(viewerId, resetAttempt = false) {
  const timer = state.directRetryTimers.get(viewerId);
  if (timer) clearTimeout(timer);
  state.directRetryTimers.delete(viewerId);
  if (resetAttempt) state.directRetryAttempts.delete(viewerId);
}

function clearDirectPresenceTimer(viewerId) {
  const timer = state.directPresenceTimers.get(viewerId);
  if (timer) clearTimeout(timer);
  state.directPresenceTimers.delete(viewerId);
}

function scheduleDirectRetry(viewerId) {
  if (state.role !== "host" || !state.localStream || !directFanoutAvailable() || !directViewerIds().includes(viewerId)) return;
  if (state.directPeers.has(viewerId) || state.directRetryTimers.has(viewerId)) return;
  const cooldownUntil = state.directPeerCooldowns.get(viewerId) || 0;
  if (cooldownUntil > Date.now()) {
    const delay = cooldownUntil - Date.now();
    state.directRetryTimers.set(viewerId, setTimeout(() => {
      state.directRetryTimers.delete(viewerId);
      startHostDirectPeer(viewerId);
    }, delay));
    return;
  }
  state.directPeerCooldowns.delete(viewerId);
  const attempt = state.directRetryAttempts.get(viewerId) || 0;
  const delay = DIRECT_RETRY_DELAYS_MS[Math.min(attempt, DIRECT_RETRY_DELAYS_MS.length - 1)];
  state.directRetryAttempts.set(viewerId, attempt + 1);
  state.directRetryTimers.set(viewerId, setTimeout(() => {
    state.directRetryTimers.delete(viewerId);
    startHostDirectPeer(viewerId);
  }, delay));
}

function resetHostDirectPeer(viewerId) {
  if (state.role !== "host") return;
  const pc = state.directPeers.get(viewerId);
  state.directPeers.delete(viewerId);
  clearDirectFallbackTimer(viewerId);
  clearDirectDisconnectTimer(viewerId);
  clearDirectPresenceTimer(viewerId);
  if (pc) try { pc.close(); } catch {}
}

function configureDirectPeer(pc, targetId) {
  pc.addEventListener("connectionstatechange", () => {
    if (pc.connectionState === "connected") {
      clearDirectDisconnectTimer(targetId);
      clearDirectRetryTimer(targetId, true);
      if (state.role === "viewer" && (state.directPc === pc || state.pendingDirectPc === pc)) {
        activateDirectViewer(pc, targetId);
      }
      if (state.role === "host" && state.directPeers.get(targetId) === pc) {
        clearDirectFallbackTimer(targetId);
        toast("Direct small-room route connected");
      }
    }
    if (pc.connectionState === "disconnected") {
      clearDirectDisconnectTimer(targetId);
      state.directDisconnectTimers.set(targetId, setTimeout(() => {
        if (pc.connectionState !== "disconnected") return;
        if (state.role === "host" && state.directPeers.get(targetId) === pc) {
          state.directPeers.delete(targetId);
          try { pc.close(); } catch {}
          scheduleDirectRetry(targetId);
        }
        if (state.role === "viewer" && state.pendingDirectPc === pc) {
          deferDirectAttempt(targetId, "candidate disconnected before it became usable");
          closePendingDirect(pc);
        }
        if (state.role === "viewer" && state.directPc === pc) {
          if (state.activeRoute === "direct") fallbackFromDirect(pc, targetId, "Direct route stayed disconnected");
          else rejectDirectCandidate(pc, targetId, { direct: { packetLoss: 100 } });
        }
      }, DIRECT_DISCONNECT_GRACE_MS));
    }
    if (["failed", "closed"].includes(pc.connectionState)) {
      clearDirectDisconnectTimer(targetId);
      if (state.role === "host" && state.directPeers.get(targetId) === pc) {
        clearDirectFallbackTimer(targetId);
        state.directPeers.delete(targetId);
        scheduleDirectRetry(targetId);
      }
      if (state.role === "viewer" && state.pendingDirectPc === pc) {
        deferDirectAttempt(targetId, `candidate ${pc.connectionState} before it became usable`);
        closePendingDirect(pc);
      }
      if (state.role === "viewer" && state.directPc === pc) {
        if (state.activeRoute === "direct") fallbackFromDirect(pc, targetId, `Direct route ${pc.connectionState}`);
        else rejectDirectCandidate(pc, targetId, { direct: { packetLoss: 100 } });
      }
    }
  });
}

async function startHostDirectPeer(viewerId) {
  if (!state.localStream || state.directPeers.has(viewerId) || !directFanoutAvailable()) return;
  const cooldownUntil = state.directPeerCooldowns.get(viewerId) || 0;
  if (cooldownUntil > Date.now()) {
    scheduleDirectRetry(viewerId);
    return;
  }
  try {
    const pc = new RTCPeerConnection({ iceServers: await getIceServers(), bundlePolicy: "max-bundle", iceTransportPolicy: "all" });
    state.directPeers.set(viewerId, pc);
    configureDirectPeer(pc, viewerId);
    const profile = qualityProfile();
    const transceivers = state.localStream.getTracks().map((track) => {
      const init = { direction: "sendonly", streams: [state.localStream] };
      if (track.kind === "video") {
        init.sendEncodings = [{
          scaleResolutionDownBy: 1,
          maxBitrate: profile.bitrate,
          maxFramerate: 30,
          priority: "high",
          networkPriority: "high",
        }];
      }
      const transceiver = pc.addTransceiver(track, init);
      if (track.kind === "video") preferH264ForDirectPlayback(transceiver);
      return transceiver;
    });
    await Promise.all(transceivers.map(({ sender }) => preferResolutionForDirect(sender, profile)));
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc);
    if (state.directPeers.get(viewerId) !== pc || !directFanoutAvailable() || !directViewerIds().includes(viewerId)) {
      pc.close();
      state.directPeers.delete(viewerId);
      return;
    }
    sendSocket({ type: "p2p:signal", to: viewerId, signal: { kind: "offer", description: pc.localDescription } });
    clearDirectFallbackTimer(viewerId);
    const timer = setTimeout(() => {
      if (state.directPeers.get(viewerId) === pc && pc.connectionState !== "connected") {
        pc.close();
        state.directPeers.delete(viewerId);
        state.directFallbackTimers.delete(viewerId);
        scheduleDirectRetry(viewerId);
      }
    }, 15_000);
    state.directFallbackTimers.set(viewerId, timer);
  } catch (error) {
    console.warn("Direct route could not start; SFU remains available", error);
    const pc = state.directPeers.get(viewerId);
    if (pc) pc.close();
    state.directPeers.delete(viewerId);
    scheduleDirectRetry(viewerId);
  }
}

async function acceptDirectOffer(from, description) {
  if (state.role !== "viewer" || !directFanoutAvailable()) return;
  if (state.directCooldownUntil > Date.now()) {
    sendSocket({
      type: "p2p:signal",
      to: from,
      signal: { kind: "defer", retryAfterMs: state.directCooldownUntil - Date.now() },
    });
    return;
  }
  if (state.directPc?.connectionState === "connected" && state.activeRoute === "direct") return;
  cancelScheduledDirectProbe();
  closePendingDirect();
  const requestedVersion = state.media?.version;
  try {
    const pc = new RTCPeerConnection({ iceServers: await getIceServers(), bundlePolicy: "max-bundle", iceTransportPolicy: "all" });
    const stream = new MediaStream();
    state.pendingDirectPc = pc;
    state.pendingDirectStream = stream;
    configureDirectPeer(pc, from);
    pc.addEventListener("track", ({ track }) => {
      stream.addTrack(track);
      activateDirectViewer(pc, from);
    });
    await pc.setRemoteDescription(description);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForIceGathering(pc);
    if (state.pendingDirectPc !== pc || state.media?.version !== requestedVersion || !directFanoutAvailable()) {
      closePendingDirect(pc);
      return;
    }
    sendSocket({ type: "p2p:signal", to: from, signal: { kind: "answer", description: pc.localDescription } });
    activateDirectViewer(pc, from);
  } catch (error) {
    console.warn("Direct route failed; keeping SFU playback", error);
    deferDirectAttempt(from, "candidate negotiation failed");
    closePendingDirect();
  }
}

async function handleDirectSignal(message) {
  const { from, signal } = message;
  if (!from || !signal) return;
  try {
    if (signal.kind === "offer") {
      await acceptDirectOffer(from, signal.description);
      return;
    }
    if (signal.kind === "answer" && state.role === "host") {
      const pc = state.directPeers.get(from);
      if (pc && pc.signalingState === "have-local-offer") await pc.setRemoteDescription(signal.description);
      return;
    }
    if (signal.kind === "candidate") {
      const pc = state.role === "host" ? state.directPeers.get(from) : state.pendingDirectPc || state.directPc;
      if (pc && signal.candidate) await pc.addIceCandidate(signal.candidate);
      return;
    }
    if (signal.kind === "hangup" && state.role === "viewer") closeViewerDirect(true);
    if (signal.kind === "retry" && state.role === "host") {
      clearDirectRetryTimer(from, true);
      state.directPeerCooldowns.delete(from);
      resetHostDirectPeer(from);
      await startHostDirectPeer(from);
    }
    if (signal.kind === "defer" && state.role === "host") {
      const retryAfterMs = Math.max(60_000, Math.min(DIRECT_FAILURE_COOLDOWN_MS, Number(signal.retryAfterMs) || DIRECT_FAILURE_COOLDOWN_MS));
      state.directPeerCooldowns.set(from, Date.now() + retryAfterMs);
      clearDirectRetryTimer(from);
      resetHostDirectPeer(from);
      scheduleDirectRetry(from);
    }
  } catch (error) {
    console.warn("Ignored invalid direct-media signal", error);
  }
}

async function activateDirectViewer(pc, hostId = "") {
  if (state.directProbePc === pc) return state.directProbePromise;
  const isPending = state.pendingDirectPc === pc;
  const stream = isPending ? state.pendingDirectStream : state.directStream;
  if (!stream || pc.connectionState !== "connected" || !stream.getVideoTracks().length) return;
  const requestedVersion = state.media?.version;
  state.directProbePc = pc;
  state.directProbePromise = (async () => {
    const generation = ++state.directActivationGeneration;
    const ready = await warmVideo(ui.directVideo, stream);
    if (!ready || generation !== state.directActivationGeneration) return;
    if (state.media?.version !== requestedVersion || !directFanoutAvailable()) {
      if (isPending) closePendingDirect(pc);
      else closeViewerDirect(false, pc);
      return;
    }
    if (isPending && state.pendingDirectPc !== pc) return;
    if (!isPending && state.directPc !== pc) return;

    const previousPc = state.directPc;
    if (isPending) {
      state.directPc = pc;
      state.directStream = stream;
      state.pendingDirectPc = null;
      state.pendingDirectStream = null;
    }
    state.directReady = true;

    // When an SFU picture is already visible, do not let a merely-connected
    // P2P candidate take over. Measure both live routes in parallel while the
    // Viewer continues watching the SFU picture.
    if (state.activeRoute === "sfu") {
      const result = await validateDirectCandidate(pc);
      const hostStillPresent = state.participants.some((participant) => participant.id === hostId && participant.role === "host");
      const candidateStillCurrent = generation === state.directActivationGeneration
        && state.media?.version === requestedVersion
        && state.directPc === pc
        && state.directStream === stream
        && ui.directVideo.srcObject === stream
        && pc.connectionState === "connected"
        && directFanoutAvailable()
        && hostStillPresent;
      if (!candidateStillCurrent) {
        closeViewerDirect(false, pc);
        return;
      }
      if (!result.preferred) {
        rejectDirectCandidate(pc, hostId, result);
        return;
      }
      updateRouteStatus(`P2P probe passed (${result.direct.packetLoss}% loss, ${result.direct.fps || "?"} fps) · switching after first frame`);
    }

    state.directCooldownUntil = 0;
    state.directProbeFailures = 0;
    const switched = await switchViewerRoute("direct", "P2P health probe passed · SFU remains hot");
    if (switched && previousPc && previousPc !== pc) {
      try { previousPc.close(); } catch {}
    }
    if (!switched) {
      rejectDirectCandidate(pc, hostId, { direct: { packetLoss: 100 } });
    }
  })().catch((error) => {
    console.warn("Direct-route activation probe failed", error);
    if (state.directPc === pc) rejectDirectCandidate(pc, hostId, null);
    else if (state.pendingDirectPc === pc) closePendingDirect(pc);
  }).finally(() => {
    if (state.directProbePc === pc) {
      state.directProbePc = null;
      state.directProbePromise = null;
    }
  });
  return state.directProbePromise;
}

async function fallbackFromDirect(pc, hostId = "", reason = "Direct route unavailable", retryAfterMs = 0) {
  if (state.directPc !== pc) return;
  if (state.directFallbackPc === pc) return;
  state.directFallbackPc = pc;
  const probeDelay = retryAfterMs || nextDirectProbeDelay();
  updateRouteStatus(`${reason} · preparing hot SFU fallback`);
  setConnection("Switching to backup stream", "warn");
  if ((!state.sfuReady || state.pc?.connectionState !== "connected") && state.media) await subscribeToBroadcast(true);
  const switched = await switchViewerRoute("sfu", `${reason} · SFU active · background P2P retry in ${directProbeDelayLabel(probeDelay)}`);
  if (switched) {
    // Only retire P2P after the SFU video has produced a real frame and is
    // visible. Otherwise a failed backup could turn a degraded route into a
    // black screen.
    state.directCooldownUntil = Date.now() + probeDelay;
    if (hostId) {
      sendSocket({
        type: "p2p:signal",
        to: hostId,
        signal: { kind: "defer", retryAfterMs: probeDelay },
      });
    }
    scheduleViewerDirectProbe(probeDelay, "checking whether P2P has recovered", true);
    state.directFallbackPc = null;
    closeViewerDirect(false, pc);
  } else {
    updateRouteStatus(`${reason} · keeping the last frame while SFU recovers`);
    setTimeout(() => {
      if (state.directFallbackPc !== pc || state.directPc !== pc) return;
      state.directFallbackPc = null;
      fallbackFromDirect(pc, hostId, reason, probeDelay);
    }, 3_000);
  }
}

function allCurrentViewersAreDirect() {
  const viewerIds = directViewerIds();
  return viewerIds.length > 0 && viewerIds.length <= MAX_DIRECT_VIEWERS && viewerIds.every((viewerId) => {
    return state.directPeers.get(viewerId)?.connectionState === "connected";
  });
}

function scheduleSfuStandbyIfAllDirect() {
  // v2.3.2 keeps the SFU publisher warm even while every viewer is on P2P.
  // Turning sender tracks off saved bandwidth but made fallback visibly black.
  if (state.role === "host" && allCurrentViewersAreDirect()) updateRouteStatus("Direct viewers active · SFU hot backup publishing");
}

function requestSfuStandby(standby) {
  if (state.role !== "host") return Promise.resolve();
  state.sfuStandbyDesired = false;
  state.sfuStandby = false;
  clearTimeout(state.sfuStandbyTimer);
  state.sfuStandbyTimer = null;
  if (standby) updateRouteStatus("SFU hot backup kept live for seamless switching");
  return Promise.resolve();
}

function closePendingDirect(pc = state.pendingDirectPc) {
  if (!pc || (state.pendingDirectPc && state.pendingDirectPc !== pc)) return;
  state.directActivationGeneration += 1;
  if (state.pendingDirectPc === pc) {
    state.pendingDirectPc = null;
    state.pendingDirectStream = null;
  }
  if (state.directProbePc === pc) {
    state.directProbePc = null;
    state.directProbePromise = null;
  }
  try { pc.close(); } catch {}
}

function closeViewerDirect(useFallback = true, expectedPc = state.directPc) {
  const pc = state.directPc;
  if (useFallback && pc && state.activeRoute === "direct") {
    const host = state.participants.find((participant) => participant.role === "host");
    fallbackFromDirect(pc, host?.id || "", "Host ended the direct route");
    return;
  }
  if (expectedPc && pc !== expectedPc) return;
  state.directActivationGeneration += 1;
  state.directPc = null;
  state.directStream = null;
  state.directReady = false;
  if (state.directProbePc === pc) {
    state.directProbePc = null;
    state.directProbePromise = null;
  }
  if (state.directFallbackPc === pc) state.directFallbackPc = null;
  if (pc) try { pc.close(); } catch {}
  if (ui.directVideo.srcObject) {
    ui.directVideo.pause();
    ui.directVideo.srcObject = null;
  }
  ui.directVideo.classList.remove("is-active");
  state.previousRtp.clear();
  if (useFallback && state.role === "viewer" && state.media && !state.sfuReady && !state.subscriptionPending) subscribeToBroadcast(true);
}

function closeAllDirectConnections(notifyPeers = true) {
  cancelScheduledDirectProbe();
  state.directActivationGeneration += 1;
  state.directProbeFailures = 0;
  state.directCooldownUntil = 0;
  for (const timer of state.directFallbackTimers.values()) clearTimeout(timer);
  state.directFallbackTimers.clear();
  for (const timer of state.directRetryTimers.values()) clearTimeout(timer);
  state.directRetryTimers.clear();
  state.directRetryAttempts.clear();
  state.directPeerCooldowns.clear();
  for (const timer of state.directDisconnectTimers.values()) clearTimeout(timer);
  state.directDisconnectTimers.clear();
  for (const timer of state.directPresenceTimers.values()) clearTimeout(timer);
  state.directPresenceTimers.clear();
  if (state.role === "host") {
    const peers = [...state.directPeers.entries()];
    state.directPeers.clear();
    for (const [viewerId, pc] of peers) {
      if (notifyPeers) sendSocket({ type: "p2p:signal", to: viewerId, signal: { kind: "hangup" } });
      try { pc.close(); } catch {}
    }
  } else {
    closePendingDirect();
    closeViewerDirect(false);
  }
}

function reconcileDirectRoute() {
  const viewerIds = directViewerIds();
  if (state.role === "host") {
    if (!state.localStream) {
      closeAllDirectConnections(true);
      return;
    }
    if (viewerIds.length > MAX_DIRECT_VIEWERS) {
      requestSfuStandby(false).finally(() => closeAllDirectConnections(true));
      return;
    }
    // A control WebSocket can disappear briefly while its independent media
    // PeerConnection is still healthy. Keep that direct route for 30 seconds so
    // a ticket reconnect does not cause an avoidable movie interruption.
    if (viewerIds.length === 0) {
      for (const [viewerId, pc] of state.directPeers) {
        if (state.directPresenceTimers.has(viewerId)) continue;
        state.directPresenceTimers.set(viewerId, setTimeout(() => {
          state.directPresenceTimers.delete(viewerId);
          if (directViewerIds().includes(viewerId) || state.directPeers.get(viewerId) !== pc) return;
          state.directPeers.delete(viewerId);
          try { pc.close(); } catch {}
        }, 30_000));
      }
      return;
    }
    for (const [viewerId, pc] of state.directPeers) {
      if (!viewerIds.includes(viewerId)) {
        try { pc.close(); } catch {}
        clearDirectFallbackTimer(viewerId);
        state.directPeers.delete(viewerId);
      } else {
        clearDirectPresenceTimer(viewerId);
      }
    }
    for (const viewerId of viewerIds) startHostDirectPeer(viewerId);
    scheduleSfuStandbyIfAllDirect();
    return;
  }
  if (!directFanoutAvailable()) {
    cancelScheduledDirectProbe();
    state.directActivationGeneration += 1;
    if (state.pendingDirectPc) closePendingDirect();
    if (state.directPc) closeViewerDirect(true);
    state.directProbeFailures = 0;
    return;
  }
  if (state.activeRoute === "sfu" && !state.directPc && !state.pendingDirectPc && !state.directProbeTimer) {
    const delay = Math.max(1_000, state.directCooldownUntil - Date.now());
    scheduleViewerDirectProbe(delay, "small-room P2P is available again");
  }
}

function systemMessage(text) {
  const item = document.createElement("div");
  item.className = "system-message";
  item.textContent = text;
  ui.chatLog.appendChild(item);
  ui.chatLog.scrollTop = ui.chatLog.scrollHeight;
  return item;
}

function addChatMessage(message) {
  const item = document.createElement("div");
  item.className = `chat-message${message.from === state.myId ? " mine" : ""}`;
  const meta = document.createElement("div");
  meta.className = "chat-meta";
  meta.textContent = `${message.name} · ${new Date(message.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  const bubble = document.createElement("div");
  bubble.className = "chat-bubble";
  bubble.textContent = message.text;
  item.append(meta, bubble);
  ui.chatLog.appendChild(item);
  ui.chatLog.scrollTop = ui.chatLog.scrollHeight;
}

function submitChat(event) {
  event.preventDefault();
  const text = ui.chatInput.value.trim();
  if (!text) return;
  sendSocket({ type: "chat", text });
  ui.chatInput.value = "";
}

function showReaction(emoji) {
  const item = document.createElement("span");
  item.className = "floating-reaction";
  item.textContent = emoji;
  item.style.setProperty("--x", `${18 + Math.random() * 64}%`);
  ui.reactionLayer.appendChild(item);
  setTimeout(() => item.remove(), 1800);
}

function renderParticipants() {
  ui.peopleCount.textContent = String(state.participants.length);
  ui.participants.replaceChildren();
  for (const participant of state.participants) {
    const row = document.createElement("div");
    row.className = "participant";
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = participant.name.slice(0, 1).toUpperCase();
    const copy = document.createElement("div");
    copy.className = "participant-copy";
    const name = document.createElement("strong");
    name.textContent = `${participant.name}${participant.id === state.myId ? " · you" : ""}`;
    const role = document.createElement("small");
    const roleName = participant.role === "host" ? "Host" : "Viewer";
    role.textContent = participant.reconnecting ? `${roleName} · reconnecting` : roleName;
    copy.append(name, role);
    const quality = document.createElement("span");
    const qualityState = participant.reconnecting ? "connecting" : participant.quality?.state || "connecting";
    quality.className = `quality-dot ${qualityState}`;
    quality.title = participant.reconnecting ? "Control connection is reconnecting; media route is preserved" : qualityState;
    row.append(avatar, copy, quality);
    if (state.role === "host" && participant.role !== "host" && participant.id !== state.myId) {
      const kick = document.createElement("button");
      kick.className = "kick-button";
      kick.textContent = "×";
      kick.title = "Remove from room for one hour";
      kick.addEventListener("click", () => kickParticipant(participant));
      row.appendChild(kick);
    }
    ui.participants.appendChild(row);
  }
  renderDiagnostics();
}

function updateParticipantQuality(participant) {
  const index = state.participants.findIndex((item) => item.id === participant.id);
  if (index >= 0) state.participants[index] = participant;
  renderParticipants();
}

function viewerRouteName(route) {
  if (route === "p2p") return "P2P";
  if (route === "p2p-turn") return "P2P/TURN";
  if (route === "turn") return "SFU/TURN";
  return "SFU";
}

function renderDiagnostics() {
  if (state.role !== "host") return;
  ui.diagnosticList.replaceChildren();
  for (const participant of state.participants) {
    const row = document.createElement("div");
    row.className = "diagnostic-item";
    const name = document.createElement("strong");
    name.textContent = participant.name;
    const value = document.createElement("span");
    const quality = participant.quality;
    const routeName = viewerRouteName(quality?.route);
    value.textContent = quality
      ? `${quality.state} · ${routeName} · ${quality.bitrateKbps || 0} kbps · ${quality.packetLoss || 0}% loss`
      : "waiting for data";
    row.append(name, value);
    ui.diagnosticList.appendChild(row);
  }
}

async function kickParticipant(participant) {
  if (!confirm(`Remove ${participant.name} from this screening for one hour?`)) return;
  try {
    await api(`/api/rooms/${state.roomId}/control/kick`, {
      method: "POST",
      body: JSON.stringify({ participantId: participant.id }),
    });
    toast(`${participant.name} was removed`);
  } catch (error) {
    toast(error.message);
  }
}

function qualityProfile() {
  const quality = ui.qualitySelect.value;
  if (quality === "data") return { width: 960, height: 540, bitrate: 1_000_000 };
  if (quality === "high") return { width: 1920, height: 1080, bitrate: 3_500_000 };
  return { width: 1280, height: 720, bitrate: 2_200_000 };
}

function cinemaSfuEncodings(profile) {
  const original = { rid: "a", scaleResolutionDownBy: 1, maxBitrate: profile.bitrate, maxFramerate: 30 };
  // Keep a cinema-quality floor instead of publishing the old 180p/270p
  // emergency layer. 1080p falls back to 720p; 720p falls back to 540p.
  if (profile.width >= 1900) {
    return [original, { rid: "m", scaleResolutionDownBy: 1.5, maxBitrate: 2_200_000, maxFramerate: 30 }];
  }
  if (profile.width >= 1200) {
    return [original, { rid: "m", scaleResolutionDownBy: 4 / 3, maxBitrate: 1_400_000, maxFramerate: 30 }];
  }
  return [original];
}

async function preferMotionOverResolution(sender) {
  if (!sender?.track || sender.track.kind !== "video") return;
  try {
    const parameters = sender.getParameters();
    parameters.degradationPreference = "maintain-framerate";
    await sender.setParameters(parameters);
  } catch (error) {
    // Safari and some older Chromium builds do not expose this sender option.
    console.info("Frame-rate preference is not supported by this browser", error);
  }
}

async function preferResolutionForDirect(sender, profile) {
  if (!sender?.track || sender.track.kind !== "video") return;
  try {
    const parameters = sender.getParameters();
    parameters.degradationPreference = "maintain-resolution";
    parameters.encodings = (parameters.encodings || [{}]).map((encoding) => ({
      ...encoding,
      scaleResolutionDownBy: 1,
      maxBitrate: profile.bitrate,
      maxFramerate: 30,
      priority: "high",
      networkPriority: "high",
    }));
    await sender.setParameters(parameters);
  } catch (error) {
    // Unsupported hints are non-fatal. The explicit single full-resolution
    // encoding still prevents the app itself from selecting a low layer.
    console.info("Resolution preference is not supported by this browser", error);
  }
}

function preferH264ForDirectPlayback(transceiver) {
  if (!transceiver?.setCodecPreferences || !globalThis.RTCRtpSender?.getCapabilities) return;
  try {
    const codecs = RTCRtpSender.getCapabilities("video")?.codecs || [];
    const h264 = codecs.filter((codec) => codec.mimeType?.toLowerCase() === "video/h264");
    if (!h264.length) return;
    const rest = codecs.filter((codec) => codec.mimeType?.toLowerCase() !== "video/h264");
    transceiver.setCodecPreferences([...h264, ...rest]);
  } catch (error) {
    console.info("H.264 preference is not supported by this browser", error);
  }
}

async function getIceServers() {
  const result = await api(`/api/rooms/${state.roomId}/media/ice`, { method: "POST", body: "{}" });
  if (result.enabled && !state.turnNoticeShown) {
    state.turnNoticeShown = true;
    systemMessage("Cloudflare TURN fallback is ready.");
  }
  if (result.warning) systemMessage(`TURN warning: ${result.warning}`);
  return result.iceServers || [{ urls: ["stun:stun.cloudflare.com:3478"] }];
}

async function createMediaSession(activate = true) {
  const result = await api(`/api/rooms/${state.roomId}/media/session`, { method: "POST", body: "{}" });
  if (activate) state.sessionId = result.sessionId;
  return result.sessionId;
}

async function startBroadcast(options = {}) {
  if (!state.connected || state.role !== "host" || state.localStream) return;
  const preferLocal = options.localPlayer === true;
  if (preferLocal && (!state.playerState?.ready || performance.now() - state.playerState.receivedAt > 10_000)) {
    toast("Choose a playable movie in the local player first / 请先在本地播放器选择可播放的电影");
    return;
  }
  ui.startShare.disabled = true;
  ui.localShare.disabled = true;
  try {
    const profile = qualityProfile();
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        ...(preferLocal ? { displaySurface: "browser" } : {}),
        width: { ideal: profile.width, max: profile.width },
        height: { ideal: profile.height, max: profile.height },
        frameRate: { ideal: 30, max: 30 },
      },
      audio: true,
    });
    state.localStream = stream;
    const videoTrack = stream.getVideoTracks()[0];
    let captureHandle = null;
    try { captureHandle = videoTrack?.getCaptureHandle?.(); } catch {}
    const decision = localCaptureDecision(videoTrack?.getSettings?.(), captureHandle, state.playerChannelId, location.origin, preferLocal);
    if (decision.error) throw new Error(decision.error);
    state.localCaptureChannelId = decision.local ? state.playerChannelId : "";
    state.localCaptureVerified = Boolean(decision.verified);
    if (decision.local) state.playerChannel?.postMessage({ type: "sharing", active: true });
    videoTrack?.addEventListener("capturehandlechange", () => {
      if (state.localStream !== stream || !state.localCaptureChannelId) return;
      let nextHandle = null;
      try { nextHandle = videoTrack.getCaptureHandle?.(); } catch {}
      const next = localCaptureDecision(videoTrack.getSettings?.(), nextHandle, state.playerChannelId, location.origin);
      if (!next.local) {
        state.localCaptureChannelId = "";
        state.playerChannel?.postMessage({ type: "sharing", active: false });
        publishCaptionClock(currentCaptionTime(), false, "manual", true, 1);
        toast("Shared tab changed; subtitle timing is now manual / 共享标签页已改变，字幕切为手动同步");
      }
    });
    if (videoTrack) videoTrack.contentHint = "motion";
    stream.getTracks().forEach((track) => track.addEventListener("ended", () => {
      if (state.localStream) stopBroadcast(true);
    }, { once: true }));

    showHostPreview(stream);
    setVisible(ui.liveBadge, true);
    setVisible(ui.startShare, false);
    setVisible(ui.stopShare, true);
    if (state.localCaptureChannelId) {
      const clock = localMovieClock(state.playerState);
      publishCaptionClock(clock.time, clock.playing, "local-player", true, clock.rate);
    } else publishCaptionClock(0, true, "capture", true, 1);
    const iceServers = await getIceServers();
    const sessionId = await createMediaSession();
    const pc = new RTCPeerConnection({ iceServers, bundlePolicy: "max-bundle" });
    state.pc = pc;
    monitorPeerConnection(pc);

    const transceivers = stream.getTracks().map((track) => {
      const init = { direction: "sendonly" };
      if (track.kind === "video") {
        init.sendEncodings = cinemaSfuEncodings(profile);
      }
      return pc.addTransceiver(track, init);
    });
    state.sfuSenderTracks = new Map(transceivers.map(({ sender }) => [sender, sender.track]));
    state.sfuStandby = false;
    state.sfuStandbyDesired = false;
    await Promise.all(transceivers.map(({ sender }) => preferMotionOverResolution(sender)));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc);
    const response = await api(`/api/rooms/${state.roomId}/media/publish`, {
      method: "POST",
      body: JSON.stringify({
        sessionId,
        sessionDescription: pc.localDescription,
        tracks: transceivers.map(({ mid, sender }) => ({ mid, trackName: sender.track.id, kind: sender.track.kind })),
      }),
    });
    await pc.setRemoteDescription(response.sessionDescription);
    await waitForConnected(pc);
    await api(`/api/rooms/${state.roomId}/media/ready`, { method: "POST", body: JSON.stringify({ sessionId }) });
    await requestWakeLock();
    startStats();
    reconcileDirectRoute();
    toast("Broadcast is live");
  } catch (error) {
    console.error(error);
    toast(error.message || "Could not start broadcasting");
    await stopBroadcast(false);
  } finally {
    ui.startShare.disabled = false;
    updateLocalPlaybackControls();
  }
}

async function subscribeToBroadcast(force = false) {
  if (!state.media || state.role !== "viewer" || state.subscriptionPending) return false;
  if (!force && state.pc?.connectionState === "connected" && state.sfuReady) return true;
  state.subscriptionPending = true;
  const generation = ++state.subscriptionGeneration;
  const requestedVersion = state.media.version;
  const previousPc = state.pc;
  const previousSessionId = state.sessionId;
  const previousStream = state.sfuStream;
  if (state.activeRoute === "none") updateStageEmpty("Connecting to the projection…", "Preparing both the direct and backup routes.");
  let pc = null;
  try {
    const iceServers = await getIceServers();
    const sessionId = await createMediaSession(false);
    pc = new RTCPeerConnection({ iceServers, bundlePolicy: "max-bundle" });
    state.pendingSfuPc = pc;
    const stream = new MediaStream();
    const warmupVideo = document.createElement("video");
    warmupVideo.autoplay = true;
    warmupVideo.muted = true;
    warmupVideo.playsInline = true;
    warmupVideo.srcObject = stream;
    pc.addEventListener("track", ({ track }) => {
      stream.addTrack(track);
      warmupVideo.play().catch(() => {});
    });
    const response = await api(`/api/rooms/${state.roomId}/media/subscribe`, {
      method: "POST",
      body: JSON.stringify({ sessionId, quality: ui.qualitySelect.value }),
    });
    if (state.media?.version !== requestedVersion || generation !== state.subscriptionGeneration || state.pendingSfuPc !== pc) {
      pc.close();
      return false;
    }
    if (!response.requiresImmediateRenegotiation || !response.sessionDescription) {
      throw new Error("Cloudflare did not return a subscription offer");
    }
    await pc.setRemoteDescription(response.sessionDescription);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForIceGathering(pc);
    await api(`/api/rooms/${state.roomId}/media/renegotiate`, {
      method: "PUT",
      body: JSON.stringify({ sessionId, sessionDescription: pc.localDescription }),
    });
    await waitForConnected(pc);
    const firstFrameReady = await waitForVideoFrame(warmupVideo);
    if (!firstFrameReady) throw new Error("The backup route connected but produced no video frame");
    if (generation !== state.subscriptionGeneration || state.pendingSfuPc !== pc) {
      pc.close();
      return false;
    }

    state.pendingSfuPc = null;
    state.pc = pc;
    state.sessionId = sessionId;
    state.sfuStream = stream;
    state.sfuReady = true;
    monitorPeerConnection(pc);
    await warmVideo(ui.remoteVideo, stream);
    if (state.activeRoute !== "direct" || state.directPc?.connectionState !== "connected") {
      await switchViewerRoute("sfu", previousPc ? "SFU replacement ready · old route retired" : "SFU hot backup ready");
    } else {
      updateRouteStatus("Direct P2P active · SFU hot backup ready");
    }
    if (previousPc && previousPc !== pc) {
      try { previousPc.close(); } catch {}
    }
    startStats();
    return true;
  } catch (error) {
    if (generation !== state.subscriptionGeneration) return;
    if (pc && pc !== previousPc) try { pc.close(); } catch {}
    if (state.pendingSfuPc === pc) state.pendingSfuPc = null;
    state.pc = previousPc;
    state.sessionId = previousSessionId;
    state.sfuStream = previousStream;
    state.sfuReady = Boolean(previousPc && previousStream && videoHasFrame(ui.remoteVideo));
    console.error(error);
    if (state.activeRoute === "none") updateStageEmpty("The stream couldn't connect", error.message || "Try again in a moment.");
    else updateRouteStatus("Backup route recovery failed · current picture preserved");
    toast(error.message || "Stream connection failed");
    return false;
  } finally {
    if (generation === state.subscriptionGeneration) state.subscriptionPending = false;
  }
}

function monitorPeerConnection(pc) {
  pc.addEventListener("connectionstatechange", () => {
    if (state.pc !== pc) return;
    if (pc.connectionState === "connected") {
      clearTimeout(state.sfuDisconnectTimer);
      state.sfuDisconnectTimer = null;
      if (state.activeRoute === "sfu") setConnection("Backup stream connected", "online");
    }
    if (pc.connectionState === "disconnected" && state.role === "viewer") {
      if (state.activeRoute === "sfu") setConnection("Backup route recovering", "warn");
      clearTimeout(state.sfuDisconnectTimer);
      state.sfuDisconnectTimer = setTimeout(() => {
        if (state.pc === pc && pc.connectionState === "disconnected") subscribeToBroadcast(true);
      }, DIRECT_DISCONNECT_GRACE_MS);
    }
    if (pc.connectionState === "failed" && state.role === "viewer") {
      state.sfuReady = false;
      if (state.activeRoute === "sfu") setConnection("Backup route recovering", "warn");
      setTimeout(() => state.media && subscribeToBroadcast(true), 1500);
    }
  });
}

function waitForIceGathering(pc, timeoutMs = 4500) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, timeoutMs);
    const listener = () => {
      if (pc.iceGatheringState !== "complete") return;
      clearTimeout(timeout);
      pc.removeEventListener("icegatheringstatechange", listener);
      resolve();
    };
    pc.addEventListener("icegatheringstatechange", listener);
  });
}

function waitForConnected(pc, timeoutMs = 15_000) {
  if (["connected", "completed"].includes(pc.iceConnectionState)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("The media connection timed out")), timeoutMs);
    const listener = () => {
      if (["connected", "completed"].includes(pc.iceConnectionState)) {
        clearTimeout(timeout);
        pc.removeEventListener("iceconnectionstatechange", listener);
        resolve();
      } else if (pc.iceConnectionState === "failed") {
        clearTimeout(timeout);
        pc.removeEventListener("iceconnectionstatechange", listener);
        reject(new Error("The media connection failed"));
      }
    };
    pc.addEventListener("iceconnectionstatechange", listener);
  });
}

async function stopBroadcast(notifyServer = true) {
  state.playerChannel?.postMessage({ type: "sharing", active: false });
  state.localCaptureChannelId = "";
  state.localCaptureVerified = false;
  const hadStream = Boolean(state.localStream);
  if (hadStream && state.role === "host") publishCaptionClock(currentCaptionTime(), false, state.captionClock?.source || "capture", true);
  const sessionId = state.sessionId;
  const localStream = state.localStream;
  state.localStream = null;
  clearTimeout(state.sfuStandbyTimer);
  state.sfuStandbyTimer = null;
  state.sfuStandbyDesired = false;
  state.sfuStandby = false;
  state.sfuSenderTracks.clear();
  resetSourceThrottleWarning();
  closeAllDirectConnections(true);
  if (localStream) localStream.getTracks().forEach((track) => track.stop());
  closePeerConnection();
  hideVideos();
  setVisible(ui.startShare, true);
  setVisible(ui.stopShare, false);
  updateStageEmpty("The screen is quiet", "Start a new broadcast whenever you're ready.");
  if (state.wakeLock) {
    try { await state.wakeLock.release(); } catch {}
    state.wakeLock = null;
  }
  if (hadStream && notifyServer && state.connected) {
    try {
      await api(`/api/rooms/${state.roomId}/media/stop`, { method: "POST", body: JSON.stringify({ sessionId }) });
    } catch (error) {
      console.warn(error);
    }
  }
}

function closePeerConnection() {
  state.subscriptionGeneration += 1;
  state.subscriptionPending = false;
  clearTimeout(state.sfuDisconnectTimer);
  state.sfuDisconnectTimer = null;
  stopStats();
  if (state.pendingSfuPc) {
    try { state.pendingSfuPc.close(); } catch {}
  }
  state.pendingSfuPc = null;
  if (state.pc) {
    try { state.pc.close(); } catch {}
  }
  state.pc = null;
  state.sfuStream = null;
  state.sfuReady = false;
  state.sessionId = "";
  if (state.role === "host") {
    clearTimeout(state.sfuStandbyTimer);
    state.sfuStandbyTimer = null;
    state.sfuStandbyDesired = false;
    state.sfuStandby = false;
    state.sfuSenderTracks.clear();
  }
  state.previousRtp.clear();
}

function hideVideos() {
  state.routeSwitchGeneration += 1;
  stopPlaybackWatchdog();
  ui.remoteVideo.pause();
  ui.remoteVideo.srcObject = null;
  ui.remoteVideo.classList.remove("is-active");
  ui.directVideo.pause();
  ui.directVideo.srcObject = null;
  ui.directVideo.classList.remove("is-active");
  ui.previewVideo.srcObject = null;
  ui.previewVideo.classList.remove("is-active");
  state.activeRoute = "none";
  state.sfuReady = false;
  state.directReady = false;
  updateRouteStatus("No active media route");
  setVisible(ui.liveBadge, false);
  ui.stageEmpty.classList.remove("hidden");
}

function updateStageEmpty(title, hint) {
  if (title) ui.stageTitle.textContent = title;
  else ui.stageTitle.textContent = state.role === "host" ? "Ready when you are" : "Waiting for the film to begin";
  if (hint) ui.stageHint.textContent = hint;
  else ui.stageHint.textContent = state.role === "host"
    ? "Open your video, then share its browser tab with audio."
    : "The host will start the screening soon.";
  ui.stageKicker.textContent = state.role === "host" ? "PROJECTION BOOTH READY" : "THE SCREEN IS QUIET";
}

async function requestWakeLock() {
  try { state.wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
}

function openLocalMovie(event) {
  if (state.role !== "host" || !state.connected || state.localCaptureChannelId) {
    event?.preventDefault();
    toast(state.localCaptureChannelId ? "Stop sharing before opening another player / 请先停止共享，再打开另一个播放器" : "Join as host first / 请先以主持人身份进入房间");
    return;
  }
  if (typeof BroadcastChannel === "undefined") {
    ui.openMovie.href = "/player.html";
    toast("This browser needs manual subtitle timing / 此浏览器需要手动同步字幕");
    return;
  }
  state.playerChannel?.postMessage({ type: "room-detached" });
  state.playerChannel?.close();
  const channelId = crypto.randomUUID();
  const channel = new BroadcastChannel(`cinema-player-${channelId}`);
  state.playerChannel = channel;
  state.playerChannelId = channelId;
  state.playerState = null;
  // A native anchor opens during this exact click. Choose the file INSIDE the
  // player; never call window.open after the file picker has consumed activation.
  ui.openMovie.href = `/player.html?channel=${encodeURIComponent(channelId)}`;
  setVisible(ui.localPlayback, true);
  updateLocalPlaybackControls();
  clearInterval(state.localPlayerTimer);
  state.localPlayerTimer = setInterval(updateLocalPlaybackControls, 1_000);
  channel.addEventListener("message", ({ data }) => {
    if (!data || state.playerChannel !== channel) return;
    if (data.type === "ready") {
      channel.postMessage({ type: "room-ready" });
      return;
    }
    const next = normaliseLocalState(data);
    if (!next) return;
    state.playerState = next;
    updateLocalPlaybackControls();
    if (state.localStream && state.localCaptureChannelId === channelId) {
      const clock = localMovieClock(next);
      const force = ["play", "pause", "seeked", "loadedmetadata", "ended", "waiting", "stalled", "seeking", "closed", "load", "ratechange", "error", "playing"].includes(data.reason);
      publishCaptionClock(clock.time, clock.playing, "local-player", force, clock.rate);
    }
  });
}

function updateLocalPlaybackControls() {
  if (!ui.localPlayerStatus || state.role !== "host") return;
  const player = state.playerState;
  const fresh = player && performance.now() - player.receivedAt <= 10_000;
  const usable = Boolean(fresh && player.ready);
  const labels = {
    empty: "Choose a movie in the player / 请在播放器选择电影",
    loading: "Reading local file / 正在读取本地电影",
    error: "Unsupported file; see the player for details / 文件不兼容，请查看播放器提示",
    closed: "Player closed / 播放器已关闭",
  };
  const shared = state.localCaptureChannelId ? (state.localCaptureVerified ? "Sharing local player / 已识别本地播放器" : "Sharing selected local tab / 按所选本地标签页同步") : "Not sharing yet / 尚未共享";
  ui.localPlayerStatus.textContent = !player ? "Waiting for player tab / 等待播放器标签页"
    : !fresh ? "Player is not responding / 播放器暂未响应"
    : labels[player.status] || `${player.name} · ${shared}`;
  if (player?.audioWarning) ui.localPlayerStatus.textContent += ` · ${player.audioWarning}`;
  ui.localPlayerStatus.title = ui.localPlayerStatus.textContent;
  ui.localPlayerStatus.dataset.audioWarning = player?.audioWarning ? "true" : "false";
  for (const button of [ui.localPlayPause, ui.localSeekBack, ui.localSeekForward]) button.disabled = !usable;
  ui.localShare.disabled = !usable || Boolean(state.localStream) || !state.connected;
  ui.localPlayPause.textContent = player?.paused ? "Play / 播放" : "Pause / 暂停";
  const clock = localMovieClock(player);
  ui.localSeek.disabled = !usable || !player.duration;
  ui.localSeek.max = String(player?.duration || 0);
  if (!state.localSeeking) ui.localSeek.value = String(clock.time);
  ui.localTime.textContent = `${formatMovieTime(state.localSeeking ? ui.localSeek.value : clock.time)} / ${formatMovieTime(player?.duration)}`;
  if (state.localCaptureChannelId && !fresh && state.captionClock?.playing) {
    publishCaptionClock(clock.time, false, "local-player", true, clock.rate);
  }
}

function commandLocalMovie(action, time) {
  if (state.role !== "host" || !state.playerChannel || !state.playerState?.ready
    || performance.now() - state.playerState.receivedAt > 10_000) return;
  if (action === "seek" && !Number.isFinite(time)) return;
  state.playerChannel.postMessage({ type: "command", action, ...(action === "seek" ? { time } : {}) });
}

function seekLocalMovieBy(seconds) {
  if (state.playerState) {
    const clock = localMovieClock(state.playerState);
    commandLocalMovie("seek", Math.max(0, Math.min(state.playerState.duration, clock.time + seconds)));
  }
}

function parseCaptionTime(value) {
  const parts = String(value || "").trim().replace(",", ".").split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return NaN;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return NaN;
}

function plainCaptionText(value) {
  const wrapper = document.createElement("div");
  wrapper.innerHTML = String(value || "").replace(/<br\s*\/?>/gi, "\n");
  return wrapper.textContent?.trim() || "";
}

function parseCaptionFile(source) {
  const blocks = String(source || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/^WEBVTT[^\n]*\n+/i, "")
    .split(/\n{2,}/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trimEnd());
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const [startText, endPart] = lines[timingIndex].split("-->");
    const endText = endPart?.trim().split(/\s+/)[0];
    const start = parseCaptionTime(startText);
    const end = parseCaptionTime(endText);
    const text = plainCaptionText(lines.slice(timingIndex + 1).join("\n"));
    if (Number.isFinite(start) && Number.isFinite(end) && end > start && text) cues.push({ start, end, text });
  }
  return cues.sort((left, right) => left.start - right.start);
}

const CAPTION_LANGUAGE_NAMES = {
  en: "English",
  eng: "English",
  ru: "Русский",
  rus: "Русский",
  zh: "中文",
  "zh-cn": "简体中文",
  "zh-hans": "简体中文",
  "zh-tw": "繁體中文",
  "zh-hant": "繁體中文",
  cn: "简体中文",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  fa: "فارسی",
  ar: "العربية",
  ja: "日本語",
  ko: "한국어",
};

function captionIdentity(fileName) {
  const stem = String(fileName || "Subtitles").replace(/\.(srt|vtt)$/i, "");
  const tokens = stem.toLowerCase().split(/[._\-\s]+/).filter(Boolean);
  let code = "";
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const one = tokens[index];
    const two = index > 0 ? `${tokens[index - 1]}-${one}` : "";
    if (CAPTION_LANGUAGE_NAMES[two]) { code = two; break; }
    if (CAPTION_LANGUAGE_NAMES[one]) { code = one; break; }
  }
  const language = CAPTION_LANGUAGE_NAMES[code] || "Undetermined";
  return { name: language === "Undetermined" ? stem : language, language };
}

function syncCaptionLibrary(captions) {
  const previous = new Map(state.captionTracks.map((track) => [track.id, track]));
  const selected = ui.captionSelect?.value || "off";
  state.captionTracks = captions.map((caption) => ({
    ...caption,
    cues: previous.get(caption.id)?.cues || null,
  }));
  ui.captionSelect.replaceChildren(new Option("Off", "off"));
  for (const caption of state.captionTracks) {
    const label = caption.language && caption.language !== caption.name
      ? `${caption.language} — ${caption.name}`
      : caption.name;
    ui.captionSelect.appendChild(new Option(label, caption.id));
  }
  ui.captionSelect.value = state.captionTracks.some((caption) => caption.id === selected) ? selected : "off";
  setVisible(ui.deleteCaption, state.role === "host" && ui.captionSelect.value !== "off");
  startCaptionRenderer();
  renderCaption();
}

async function loadCaptionFiles() {
  if (state.role !== "host") return;
  const files = [...(ui.captionFile.files || [])];
  let lastCaption = null;
  for (const file of files) {
    if (file.size > 768 * 1024) {
      toast(`${file.name} is larger than 768 KB`);
      continue;
    }
    const content = await file.text();
    const cues = parseCaptionFile(content);
    if (!cues.length) {
      toast(`No timed captions found in ${file.name}`);
      continue;
    }
    const identity = captionIdentity(file.name);
    try {
      const result = await api(`/api/rooms/${state.roomId}/control/captions`, {
        method: "POST",
        body: JSON.stringify({
          name: identity.name,
          language: identity.language,
          format: file.name.toLowerCase().endsWith(".vtt") ? "vtt" : "srt",
          content,
        }),
      });
      syncCaptionLibrary(result.captions || []);
      lastCaption = result.caption;
      const track = state.captionTracks.find((item) => item.id === result.caption?.id);
      if (track) track.cues = cues;
      toast(`${identity.name} is available to everyone in the room`);
    } catch (error) {
      toast(error.message);
    }
  }
  ui.captionFile.value = "";
  if (lastCaption) {
    ui.captionSelect.value = lastCaption.id;
    setVisible(ui.deleteCaption, true);
  }
  renderCaption();
}

async function ensureCaptionLoaded(caption) {
  if (!caption || caption.cues) return caption;
  const generation = ++state.captionLoadGeneration;
  try {
    const result = await api(`/api/rooms/${state.roomId}/captions/${caption.id}`);
    if (generation !== state.captionLoadGeneration) return null;
    const current = state.captionTracks.find((item) => item.id === caption.id);
    if (!current) return null;
    current.cues = parseCaptionFile(result.caption?.content || "");
    if (!current.cues.length) throw new Error("This subtitle track has no readable cues");
    renderCaption();
    return current;
  } catch (error) {
    toast(error.message);
    return null;
  }
}

async function deleteSelectedCaption() {
  if (state.role !== "host" || ui.captionSelect.value === "off") return;
  const caption = state.captionTracks.find((item) => item.id === ui.captionSelect.value);
  if (!caption || !confirm(`Remove “${caption.name}” from this room?`)) return;
  try {
    const result = await api(`/api/rooms/${state.roomId}/control/captions/${caption.id}`, { method: "DELETE" });
    syncCaptionLibrary(result.captions || []);
    toast("Subtitle track removed");
  } catch (error) {
    toast(error.message);
  }
}

function activePlaybackVideo() {
  if (state.role === "host") return ui.previewVideo;
  return state.activeRoute === "direct" ? ui.directVideo : ui.remoteVideo;
}

function applyCaptionClock(clock) {
  if (!clock || !Number.isFinite(Number(clock.time))) return;
  state.captionClock = {
    time: Math.max(0, Number(clock.time)),
    playing: Boolean(clock.playing),
    source: ["capture", "local-player", "manual"].includes(clock.source) ? clock.source : "capture",
    rate: Number.isFinite(Number(clock.rate)) && Number(clock.rate) > 0 ? Math.max(0.25, Math.min(4, Number(clock.rate))) : 1,
    anchoredAt: performance.now(),
  };
  updateCaptionClockButton();
  renderCaption();
}

function currentCaptionTime() {
  if (!state.captionClock) return Math.max(0, Number(activePlaybackVideo()?.currentTime || 0));
  const elapsed = state.captionClock.playing ? (performance.now() - state.captionClock.anchoredAt) / 1000 * state.captionClock.rate : 0;
  return Math.max(0, state.captionClock.time + elapsed);
}

function publishCaptionClock(time, playing, source = "manual", force = false, rate = state.captionClock?.rate || 1) {
  if (state.role !== "host") return;
  const now = performance.now();
  applyCaptionClock({ time, playing, source, rate });
  if (!force && now - state.captionClockLastSentAt < 900) return;
  state.captionClockLastSentAt = now;
  sendSocket({ type: "caption:clock", clock: { time: Math.max(0, Number(time) || 0), playing: Boolean(playing), source, rate } });
}

function toggleCaptionClock() {
  if (state.role !== "host") return;
  if (state.localCaptureChannelId) {
    commandLocalMovie("toggle");
    return;
  }
  const time = currentCaptionTime();
  const playing = state.captionClock ? !state.captionClock.playing : false;
  publishCaptionClock(time, playing, "manual", true);
  toast(playing ? "Room subtitles resumed" : "Room subtitles paused");
}

function updateCaptionClockButton() {
  if (!ui.captionClockToggle) return;
  const playing = state.captionClock?.playing !== false;
  ui.captionClockToggle.textContent = state.localCaptureChannelId
    ? playing ? "Pause movie + subtitles / 暂停电影及字幕" : "Play movie + subtitles / 播放电影及字幕"
    : playing ? "Pause subtitles" : "Resume subtitles";
  ui.captionClockToggle.classList.toggle("button-danger", playing);
  ui.captionClockToggle.classList.toggle("button-soft", !playing);
}

function cueAtTime(cues, time) {
  let low = 0;
  let high = cues.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const cue = cues[middle];
    if (time < cue.start) high = middle - 1;
    else if (time > cue.end) low = middle + 1;
    else return cue;
  }
  return null;
}

function renderCaption() {
  const track = state.captionTracks.find((item) => item.id === ui.captionSelect.value);
  const video = activePlaybackVideo();
  if (!track || !video?.srcObject) {
    ui.captionOverlay.textContent = "";
    setVisible(ui.captionOverlay, false);
    return;
  }
  if (!track.cues) {
    if (!track.loading) {
      track.loading = true;
      ensureCaptionLoaded(track).finally(() => { track.loading = false; });
    }
    ui.captionOverlay.textContent = "";
    setVisible(ui.captionOverlay, false);
    return;
  }
  const cue = cueAtTime(track.cues, Math.max(0, currentCaptionTime() + state.captionOffsetSeconds));
  ui.captionOverlay.textContent = cue?.text || "";
  setVisible(ui.captionOverlay, Boolean(cue?.text));
}

function startCaptionRenderer() {
  if (state.captionTimer) return;
  state.captionTimer = setInterval(() => {
    renderCaption();
    if (state.role === "host" && !state.localCaptureChannelId && state.captionClock?.playing && performance.now() - state.captionClockLastSentAt >= 4_000) {
      publishCaptionClock(currentCaptionTime(), true, state.captionClock.source, true);
    }
  }, 150);
}

function adjustCaptionOffset(delta) {
  state.captionOffsetSeconds = Math.max(-3600, Math.min(3600, state.captionOffsetSeconds + delta));
  ui.captionOffset.textContent = `${state.captionOffsetSeconds.toFixed(1)}s`;
  renderCaption();
}

function startStats() {
  stopStats();
  collectStats();
  state.statsTimer = setInterval(collectStats, 5000);
}

function stopStats() {
  clearInterval(state.statsTimer);
  state.statsTimer = null;
}

function resetSourceThrottleWarning() {
  state.sourceThrottleSamples = 0;
  state.sourceHealthySamples = 0;
  ui.sourceThrottleWarning?.classList.remove("is-active");
}

function updateSourceThrottleWarning(quality) {
  if (state.role !== "host" || !state.localStream) {
    resetSourceThrottleWarning();
    return;
  }

  // Chrome can report a 30 fps capture track while an occluded/background
  // source tab is actually delivered to WebRTC at roughly 15 fps. Only flag
  // this when packet loss and the sender's own network/CPU limiter do not
  // explain the reduction.
  const sourceCanProduceMotion = quality.sourceFps >= 24;
  const encodedFpsIsLow = quality.fps > 0 && quality.fps <= 20;
  const senderIsNotLimited = !["bandwidth", "cpu"].includes(quality.qualityLimitationReason);
  const enoughEstimatedBandwidth = !quality.availableBitrateKbps
    || quality.availableBitrateKbps >= Math.max(3_500, quality.bitrateKbps * 1.25);
  const likelyBrowserThrottle = sourceCanProduceMotion
    && encodedFpsIsLow
    && quality.packetLoss <= 1
    && senderIsNotLimited
    && enoughEstimatedBandwidth;

  if (likelyBrowserThrottle) {
    state.sourceThrottleSamples += 1;
    state.sourceHealthySamples = 0;
  } else if (quality.fps >= 23) {
    state.sourceHealthySamples += 1;
    state.sourceThrottleSamples = 0;
  } else {
    state.sourceThrottleSamples = Math.max(0, state.sourceThrottleSamples - 1);
    state.sourceHealthySamples = 0;
  }

  if (state.sourceThrottleSamples >= 3) {
    ui.sourceThrottleWarning?.classList.add("is-active");
    const now = Date.now();
    if (now - state.sourceThrottleWarnedAt > 60_000) {
      state.sourceThrottleWarnedAt = now;
      toast("The shared movie source appears throttled — move it to its own active window");
    }
  } else if (state.sourceHealthySamples >= 2) {
    ui.sourceThrottleWarning?.classList.remove("is-active");
  }
}

async function collectStats() {
  const directHostPc = state.role === "host"
    ? [...state.directPeers.values()].find((candidate) => candidate.connectionState === "connected")
    : null;
  const pc = state.role === "viewer" && state.activeRoute === "direct" && state.directPc?.connectionState === "connected"
    ? state.directPc
    : directHostPc || state.pc;
  if (!pc || pc.connectionState === "closed") return;
  try {
    const reports = await pc.getStats();
    const rtpCandidates = [];
    let pair = null;
    let selectedPairId = "";
    reports.forEach((report) => {
      const videoKind = report.kind === "video" || report.mediaType === "video";
      if (videoKind && report.type === (state.role === "host" ? "outbound-rtp" : "inbound-rtp") && !report.isRemote) {
        rtpCandidates.push(report);
      }
      if (report.type === "candidate-pair" && report.state === "succeeded" && (report.nominated || report.selected)) pair = report;
      if (report.type === "transport" && report.selectedCandidatePairId) selectedPairId = report.selectedCandidatePairId;
    });
    if (!pair && selectedPairId) pair = reports.get(selectedPairId) || null;
    if (!pair) {
      const succeededPairs = [];
      reports.forEach((report) => {
        if (report.type === "candidate-pair" && report.state === "succeeded") succeededPairs.push(report);
      });
      succeededPairs.sort((left, right) => Number(right.bytesReceived || 0) + Number(right.bytesSent || 0) - Number(left.bytesReceived || 0) - Number(left.bytesSent || 0));
      pair = succeededPairs[0] || null;
    }

    // A simulcast publisher has several outbound-rtp reports. Showing whichever
    // report happened to be visited last made the Host panel jump between 180p,
    // 540p and 1080p. Use the largest active layer as the source-quality report.
    rtpCandidates.sort((left, right) => {
      const leftPixels = (Number(left.frameWidth) || 0) * (Number(left.frameHeight) || 0);
      const rightPixels = (Number(right.frameWidth) || 0) * (Number(right.frameHeight) || 0);
      return rightPixels - leftPixels || (Number(right.bytesSent || right.bytesReceived) || 0) - (Number(left.bytesSent || left.bytesReceived) || 0);
    });
    const rtp = rtpCandidates[0];
    if (!rtp) return;
    const remoteInbound = state.role === "host" && rtp.remoteId ? reports.get(rtp.remoteId) : null;
    const now = Number(rtp.timestamp) || performance.now();
    const bytes = Number(state.role === "host" ? rtp.bytesSent : rtp.bytesReceived) || 0;
    const previous = state.previousRtp.get(rtp.id);
    let bitrateKbps = 0;
    if (previous && now > previous.time) {
      bitrateKbps = Math.max(0, Math.round(((bytes - previous.bytes) * 8) / (now - previous.time)));
    }

    const isDirectPeer = pc === state.directPc || pc === directHostPc;
    let route = isDirectPeer ? "p2p" : "direct";
    let transport = "unknown";
    if (pair) {
      const local = reports.get(pair.localCandidateId);
      const remote = reports.get(pair.remoteCandidateId);
      if (local?.candidateType === "relay" || remote?.candidateType === "relay") route = isDirectPeer ? "p2p-turn" : "turn";
      transport = String(local?.protocol || remote?.protocol || "unknown").toLowerCase();
      if (transport === "ssl" || transport === "tls") transport = "tls";
    }
    const packetCount = Number(state.role === "host" ? rtp.packetsSent : rtp.packetsReceived) || 0;
    const lost = Math.max(0, Number(rtp.packetsLost ?? remoteInbound?.packetsLost) || 0);
    const packetDelta = previous ? Math.max(0, packetCount - previous.packetCount) : packetCount;
    const lostDelta = previous ? Math.max(0, lost - previous.packetsLost) : lost;
    const lossDenominator = state.role === "host" ? packetDelta : packetDelta + lostDelta;
    const packetLoss = lossDenominator > 0
      ? Number(((lostDelta / lossDenominator) * 100).toFixed(1))
      : 0;
    const rttMs = Math.round(1000 * (Number(pair?.currentRoundTripTime) || Number(remoteInbound?.roundTripTime) || 0));
    const jitterMs = Math.round(1000 * (Number(rtp.jitter) || 0));
    const droppedTotal = Number(rtp.framesDropped) || 0;
    const framesDropped = previous ? Math.max(0, droppedTotal - previous.framesDropped) : 0;
    const qualityLimitationReason = state.role === "host"
      ? String(rtp.qualityLimitationReason || "none")
      : "receiver";
    const codecReport = rtp.codecId ? reports.get(rtp.codecId) : null;
    const codec = String(codecReport?.mimeType || "").split("/").pop().toUpperCase().slice(0, 16);
    state.previousRtp.set(rtp.id, {
      bytes,
      time: now,
      framesDropped: droppedTotal,
      packetCount,
      packetsLost: lost,
    });
    const sourceSettings = state.role === "host"
      ? state.localStream?.getVideoTracks?.()[0]?.getSettings?.() || {}
      : {};
    const availableBitrateKbps = Math.round(Number(
      state.role === "host" ? pair?.availableOutgoingBitrate : pair?.availableIncomingBitrate,
    ) / 1000) || 0;
    const quality = {
      state: healthState({
        packetLoss,
        rttMs,
        jitterMs,
        bitrateKbps,
        width: Number(rtp.frameWidth) || 0,
        fps: Math.round(Number(rtp.framesPerSecond) || 0),
        connected: pc.connectionState === "connected",
      }),
      route,
      transport: ["udp", "tcp", "tls"].includes(transport) ? transport : "unknown",
      bitrateKbps,
      packetLoss,
      rttMs,
      jitterMs,
      width: Number(rtp.frameWidth) || 0,
      height: Number(rtp.frameHeight) || 0,
      fps: Math.round(Number(rtp.framesPerSecond) || 0),
      framesDropped,
      qualityLimitationReason,
      codec,
      sourceWidth: Number(sourceSettings.width) || 0,
      sourceHeight: Number(sourceSettings.height) || 0,
      sourceFps: Math.round(Number(sourceSettings.frameRate) || 0),
      availableBitrateKbps,
    };
    monitorDirectPathQuality(quality, pc);
    updateSourceThrottleWarning(quality);
    updateNetworkPanel(quality);
    sendSocket({ type: "quality:report", quality });
  } catch (error) {
    console.warn("Stats unavailable", error);
  }
}

function healthState({ packetLoss, rttMs, jitterMs, bitrateKbps, width, fps, connected }) {
  if (!connected) return "connecting";
  if (packetLoss > 8 || rttMs > 650 || jitterMs > 120 || (bitrateKbps && bitrateKbps < 220) || (fps && fps < 18)) return "poor";
  if (packetLoss > 3 || rttMs > 380 || jitterMs > 65 || (bitrateKbps && bitrateKbps < 550) || (width && width <= 320) || (fps && fps < 23)) return "fair";
  if (packetLoss < 1 && rttMs < 220 && jitterMs < 30) return "excellent";
  return "good";
}

function updateNetworkPanel(quality) {
  ui.healthLabel.className = `health-chip ${quality.state}`;
  ui.healthLabel.textContent = quality.state;
  if (state.role === "host") {
    ui.routeValue.textContent = quality.route === "p2p"
      ? "Host → viewer P2P sample"
      : quality.route === "p2p-turn"
        ? "Host → viewer via TURN"
        : quality.route === "turn"
          ? "Host → SFU backup via TURN"
          : "Host → SFU hot backup";
  } else {
    ui.routeValue.textContent = quality.route === "p2p"
      ? "Direct P2P"
      : quality.route === "p2p-turn"
        ? "P2P via TURN"
        : quality.route === "turn"
          ? "SFU via TURN"
          : "Cloudflare SFU";
  }
  ui.transportValue.textContent = quality.transport.toUpperCase();
  ui.bitrateValue.textContent = quality.bitrateKbps ? `${quality.bitrateKbps} kbps` : "—";
  ui.latencyValue.textContent = quality.rttMs ? `${quality.rttMs} ms` : "—";
  ui.lossValue.textContent = `${quality.packetLoss}%`;
  ui.resolutionValue.textContent = quality.width
    ? `${quality.width}×${quality.height} · ${quality.fps} fps${quality.codec ? ` · ${quality.codec}` : ""}`
    : "—";
  ui.frameDropsValue.textContent = Number.isFinite(quality.framesDropped) ? `${quality.framesDropped} / 5s` : "—";
  ui.sourceValue.textContent = quality.sourceWidth
    ? `${quality.sourceWidth}x${quality.sourceHeight}${quality.sourceFps ? ` · ${quality.sourceFps} fps` : ""}`
    : "-";
  ui.availableBitrateValue.textContent = quality.availableBitrateKbps
    ? `${quality.availableBitrateKbps} kbps`
    : "-";
  ui.limitationValue.textContent = quality.qualityLimitationReason && quality.qualityLimitationReason !== "none"
    ? quality.qualityLimitationReason === "receiver" ? "Receiver" : quality.qualityLimitationReason
    : "None";
}

async function toggleRoomLock() {
  try {
    const result = await api(`/api/rooms/${state.roomId}/control/lock`, {
      method: "POST",
      body: JSON.stringify({ locked: !state.room.locked }),
    });
    state.room = result.room;
  } catch (error) { toast(error.message); }
}

async function ensureGuestLink() {
  if (state.defaultGuestToken) return state.defaultGuestToken;
  const result = await api(`/api/rooms/${state.roomId}/control/invite`, {
    method: "POST",
    body: JSON.stringify({ role: "viewer", label: "Guests", expiresInHours: 24 }),
  });
  state.defaultGuestToken = result.invite.token;
  await refreshInvites();
  return state.defaultGuestToken;
}

async function copyGuestInvite() {
  try {
    const token = await ensureGuestLink();
    await copyText(inviteUrl(token), "Guest invitation copied");
  } catch (error) { toast(error.message); }
}

async function createInvitation() {
  ui.createInvite.disabled = true;
  try {
    const result = await api(`/api/rooms/${state.roomId}/control/invite`, {
      method: "POST",
      body: JSON.stringify({
        role: ui.inviteRole.value,
        label: ui.inviteLabel.value || (ui.inviteRole.value === "host" ? "Guest host" : "Guest"),
        expiresInHours: Number(ui.inviteHours.value),
      }),
    });
    ui.newInviteLink.value = inviteUrl(result.invite.token);
    setVisible(ui.inviteResult, true);
    await refreshInvites();
  } catch (error) { toast(error.message); }
  finally { ui.createInvite.disabled = false; }
}

async function refreshInvites() {
  if (state.role !== "host") return;
  try {
    const result = await api(`/api/rooms/${state.roomId}/control/invites`);
    state.invites = result.invites || [];
    renderInvites();
  } catch (error) { console.warn(error); }
}

function renderInvites() {
  ui.inviteList.replaceChildren();
  for (const invite of state.invites) {
    const row = document.createElement("div");
    row.className = "invite-item";
    const copy = document.createElement("div");
    const label = document.createElement("strong");
    label.textContent = invite.label;
    const details = document.createElement("small");
    details.textContent = `${invite.role} · ${invite.revokedAt ? "revoked" : new Date(invite.expiresAt).toLocaleString()}`;
    copy.append(label, details);
    row.appendChild(copy);
    if (!invite.revokedAt) {
      const revoke = document.createElement("button");
      revoke.className = "revoke-button";
      revoke.textContent = "Revoke";
      revoke.addEventListener("click", () => revokeInvite(invite));
      row.appendChild(revoke);
    }
    ui.inviteList.appendChild(row);
  }
}

async function revokeInvite(invite) {
  if (!confirm(`Revoke the invitation “${invite.label}”? Anyone using it will be disconnected.`)) return;
  try {
    await api(`/api/rooms/${state.roomId}/control/revoke`, {
      method: "POST",
      body: JSON.stringify({ inviteId: invite.id }),
    });
    await refreshInvites();
  } catch (error) { toast(error.message); }
}

async function endScreening() {
  if (!confirm("End this screening for everyone? Invitations for this room will stop working.")) return;
  try {
    await api(`/api/rooms/${state.roomId}/control/end`, { method: "POST", body: "{}" });
  } catch (error) { toast(error.message); }
}

function leaveRoom() {
  state.intentionalClose = true;
  clearTimeout(state.reconnectTimer);
  clearInterval(state.localPlayerTimer);
  state.playerChannel?.postMessage({ type: "room-detached" });
  state.playerChannel?.close();
  closeAllDirectConnections(false);
  roomConnection.cancel(1000, "Left room");
  if (state.localStream) state.localStream.getTracks().forEach((track) => track.stop());
  closePeerConnection();
  sessionStorage.removeItem("cinema.invite");
  sessionStorage.removeItem("cinema.room");
  location.href = state.role === "host" ? "/host" : "/";
}

function bindEvents() {
  document.querySelectorAll("[data-copy-connection]").forEach((button) =>
    button.addEventListener("click", copyConnectionDiagnostics));
  ui.cancelJoin.addEventListener("click", () => {
    state.intentionalClose = true;
    clearTimeout(state.reconnectTimer);
    roomConnection.cancel();
    setBusy(false);
  });
  ui.ownerLoginForm.addEventListener("submit", ownerLogin);
  ui.createRoomForm.addEventListener("submit", createRoom);
  ui.logoutButton.addEventListener("click", ownerLogout);
  ui.refreshRooms.addEventListener("click", loadRecentRooms);
  ui.enterRoomButton.addEventListener("click", enterInvitedRoom);
  ui.guestName.addEventListener("keydown", (event) => event.key === "Enter" && enterInvitedRoom());
  ui.chatForm.addEventListener("submit", submitChat);
  document.querySelectorAll("[data-reaction]").forEach((button) => button.addEventListener("click", () => {
    sendSocket({ type: "reaction", emoji: button.dataset.reaction });
    showReaction(button.dataset.reaction);
  }));
  ui.startShare.addEventListener("click", startBroadcast);
  ui.stopShare.addEventListener("click", () => stopBroadcast(true));
  ui.openMovie.addEventListener("click", openLocalMovie);
  ui.localShare.addEventListener("click", () => startBroadcast({ localPlayer: true }));
  ui.localPlayPause.addEventListener("click", () => commandLocalMovie("toggle"));
  ui.localSeekBack.addEventListener("click", () => seekLocalMovieBy(-10));
  ui.localSeekForward.addEventListener("click", () => seekLocalMovieBy(10));
  ui.localSeek.addEventListener("input", () => { state.localSeeking = true; updateLocalPlaybackControls(); });
  ui.localSeek.addEventListener("change", () => { state.localSeeking = false; commandLocalMovie("seek", Number(ui.localSeek.value)); });
  ui.loadCaptions.addEventListener("click", () => ui.captionFile.click());
  ui.captionFile.addEventListener("change", loadCaptionFiles);
  ui.captionSelect.addEventListener("change", () => {
    state.captionLoadGeneration += 1;
    setVisible(ui.deleteCaption, state.role === "host" && ui.captionSelect.value !== "off");
    renderCaption();
  });
  ui.captionSize.addEventListener("change", () => {
    const size = ["compact", "standard", "large"].includes(ui.captionSize.value) ? ui.captionSize.value : "compact";
    localStorage.setItem("cinema.captionSize", size);
    ui.captionOverlay.dataset.size = size;
  });
  ui.deleteCaption.addEventListener("click", deleteSelectedCaption);
  ui.captionClockToggle.addEventListener("click", toggleCaptionClock);
  ui.captionBack.addEventListener("click", () => adjustCaptionOffset(-1));
  ui.captionForward.addEventListener("click", () => adjustCaptionOffset(1));
  ui.fullscreenButton.addEventListener("click", () => ui.stage.requestFullscreen?.());
  ui.pictureInPicture.addEventListener("click", async () => {
    const video = activePlaybackVideo();
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (video.srcObject) await video.requestPictureInPicture();
    } catch { toast("Picture-in-picture is not available"); }
  });
  ui.qualitySelect.addEventListener("change", () => {
    localStorage.setItem("cinema.quality", ui.qualitySelect.value);
    if (state.role === "viewer" && state.directPc?.connectionState === "connected") {
      toast("Direct quality is unchanged; refreshing the SFU backup");
      subscribeToBroadcast(true);
    } else if (state.role === "viewer" && state.media) subscribeToBroadcast(true);
    else if (state.localStream) toast("Restart the broadcast to apply host quality");
  });
  ui.copyGuestLink.addEventListener("click", copyGuestInvite);
  ui.lockRoom.addEventListener("click", toggleRoomLock);
  ui.createInvite.addEventListener("click", createInvitation);
  ui.copyNewInvite.addEventListener("click", () => copyText(ui.newInviteLink.value, "Invitation copied"));
  ui.endRoom.addEventListener("click", endScreening);
  ui.leaveRoom.addEventListener("click", leaveRoom);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    // Browsers throttle timers in background tabs. Throw away the stale
    // baseline so the first foreground sample is not presented as a five-second
    // loss/bitrate window.
    state.previousRtp.clear();
    state.mediaProgress = new WeakMap();
    if (state.pc) collectStats();
    if (state.role === "viewer") checkViewerPlaybackHealth();
    if (state.localStream && !state.wakeLock) requestWakeLock();
  });
  window.addEventListener("online", () => {
    if (!state.connected && state.hasWelcomed && !state.intentionalClose) scheduleReconnect(true);
    if (state.role === "host") reconcileDirectRoute();
    else if (state.directPc && state.directPc.connectionState !== "connected" && state.directCooldownUntil <= Date.now()) {
      const host = state.participants.find((participant) => participant.role === "host");
      if (host) sendSocket({ type: "p2p:signal", to: host.id, signal: { kind: "retry" } });
    }
  });
}

initialize();
