const $ = (id) => document.getElementById(id);

const ui = Object.fromEntries([
  "connectionPill", "connectionText", "entryView", "inviteEntry", "ownerEntry", "ownerDashboard", "closedEntry",
  "closedMessage", "guestName", "enterRoomButton", "inviteRoleText", "inviteError", "ownerLoginForm", "ownerPassword",
  "ownerError", "createRoomForm", "roomTitle", "roomHours", "dashboardError", "logoutButton", "recentRooms",
  "refreshRooms", "cinemaView", "cinemaTitle", "copyGuestLink", "lockRoom", "leaveRoom", "stage", "remoteVideo",
  "previewVideo", "stageEmpty", "stageKicker", "stageTitle", "stageHint", "liveBadge", "reactionLayer", "startShare",
  "stopShare", "openMovie", "movieFile", "qualitySelect", "pictureInPicture", "fullscreenButton", "shareTip",
  "peopleCount", "participants", "healthLabel", "routeValue", "transportValue", "bitrateValue", "latencyValue",
  "lossValue", "resolutionValue", "frameDropsValue", "limitationValue", "hostDiagnostics", "diagnosticList", "chatLog", "chatForm", "chatInput",
  "inviteLabel", "inviteRole", "inviteHours", "createInvite", "inviteResult", "newInviteLink", "copyNewInvite",
  "inviteList", "endRoom", "toast", "busyOverlay",
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
  previousBytes: null,
  wakeLock: null,
  seenEvents: new Set(),
  subscriptionGeneration: 0,
  subscriptionPending: false,
};

function getClientId() {
  const key = "cinema.clientId";
  let value = localStorage.getItem(key);
  if (!value) {
    value = crypto.randomUUID();
    localStorage.setItem(key, value);
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
      if (room.status !== "ended" && room.expiresAt > Date.now()) {
        const open = document.createElement("button");
        open.className = "text-button";
        open.textContent = "Open";
        open.addEventListener("click", () => resumeRoom(room.id));
        row.appendChild(open);
      }
      ui.recentRooms.appendChild(row);
    }
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
  const ticket = await api(`/api/rooms/${state.roomId}/ticket`, {
    method: "POST",
    body: JSON.stringify({ name: state.name, clientId: state.clientId }),
  });
  state.room = ticket.room;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}/ws?room=${encodeURIComponent(state.roomId)}&ticket=${encodeURIComponent(ticket.ticket)}`);
  if (state.ws && state.ws.readyState < 2) state.ws.close(4000, "Reconnecting");
  state.ws = socket;

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("The room took too long to respond")), 12_000);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.removeEventListener("open", opened);
      socket.removeEventListener("error", failed);
    };
    const opened = () => {
      cleanup();
      resolve();
    };
    const failed = () => {
      cleanup();
      reject(new Error("Could not connect to the room"));
    };
    socket.addEventListener("message", (event) => handleSocketMessage(event.data));
    socket.addEventListener("close", (event) => handleSocketClose(event, socket));
    socket.addEventListener("open", opened, { once: true });
    socket.addEventListener("error", failed, { once: true });
  });

  state.connected = true;
  state.reconnectAttempt = 0;
  setConnection("Connected", "online");
  if (!isReconnect) showCinema();
}

function handleSocketClose(event, socket) {
  if (state.ws !== socket) return;
  state.connected = false;
  setConnection("Disconnected", "warn");
  stopStats();
  closePeerConnection();
  if (state.localStream) stopBroadcast(false);
  if (state.intentionalClose || [4003, 4004].includes(event.code)) {
    if (event.code === 4003) showClosed("Your access to this screening was removed.");
    if (event.code === 4004) showClosed("This screening has ended.");
    return;
  }
  scheduleReconnect();
}

function scheduleReconnect() {
  clearTimeout(state.reconnectTimer);
  state.reconnectAttempt += 1;
  const delay = Math.min(15_000, 800 * 2 ** Math.min(5, state.reconnectAttempt));
  setConnection(`Reconnecting in ${Math.ceil(delay / 1000)}s`, "warn");
  state.reconnectTimer = setTimeout(async () => {
    try {
      await connectToRoom(true);
      systemMessage("Connection restored.");
    } catch (error) {
      if (["room_ended", "room_expired", "invite_invalid", "room_locked", "client_banned"].includes(error.code)) showClosed(error.message);
      else scheduleReconnect();
    }
  }, delay);
}

function showCinema() {
  setVisible(ui.entryView, false);
  setVisible(ui.cinemaView, true);
  document.querySelectorAll(".host-only").forEach((element) => setVisible(element, state.role === "host"));
  ui.cinemaTitle.textContent = state.room?.title || "Private screening";
  ui.qualitySelect.value = localStorage.getItem("cinema.quality") || "auto";
  updateStageEmpty();
}

function handleSocketMessage(raw) {
  let message;
  try { message = JSON.parse(raw); } catch { return; }
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
    ui.cinemaTitle.textContent = message.room.title;
    renderParticipants();
    ui.lockRoom.textContent = message.room.locked ? "Unlock room" : "Lock room";
    systemMessage(`You entered as ${message.role}.`);
    if (state.role === "host") refreshInvites();
    if (state.role === "viewer" && message.media) subscribeToBroadcast();
    return;
  }
  if (message.type === "room:presence") {
    state.participants = message.participants || [];
    renderParticipants();
    return;
  }
  if (message.type === "peer:joined") systemMessage(`${message.peer.name} joined.`);
  if (message.type === "peer:left") systemMessage(`${message.peer.name} left.`);
  if (message.type === "chat") addChatMessage(message);
  if (message.type === "reaction") showReaction(message.emoji);
  if (message.type === "quality:update") updateParticipantQuality(message.participant);
  if (message.type === "room:lock") {
    state.room.locked = message.locked;
    ui.lockRoom.textContent = message.locked ? "Unlock room" : "Lock room";
    systemMessage(message.locked ? "The room is now locked." : "The room is open to invited guests again.");
  }
  if (message.type === "media:available") {
    state.media = message.media;
    systemMessage(`${message.media.broadcasterName} started the film.`);
    if (state.role === "viewer") subscribeToBroadcast();
  }
  if (message.type === "media:stopped") {
    state.media = null;
    closePeerConnection();
    hideVideos();
    updateStageEmpty("The broadcast has stopped", "The host can start it again whenever they're ready.");
  }
  if (message.type === "room:ended") showClosed("The host ended this screening.");
}

function sendSocket(payload) {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(payload));
}

function systemMessage(text) {
  const item = document.createElement("div");
  item.className = "system-message";
  item.textContent = text;
  ui.chatLog.appendChild(item);
  ui.chatLog.scrollTop = ui.chatLog.scrollHeight;
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
    role.textContent = participant.role === "host" ? "Host" : "Viewer";
    copy.append(name, role);
    const quality = document.createElement("span");
    quality.className = `quality-dot ${participant.quality?.state || "connecting"}`;
    quality.title = participant.quality?.state || "connecting";
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
    value.textContent = quality
      ? `${quality.state} · ${quality.bitrateKbps || 0} kbps · ${quality.packetLoss || 0}% loss`
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
  if (quality === "data") return { width: 960, height: 540, bitrate: 1_200_000 };
  if (quality === "high") return { width: 1920, height: 1080, bitrate: 5_000_000 };
  return { width: 1280, height: 720, bitrate: 3_000_000 };
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

async function getIceServers() {
  const result = await api(`/api/rooms/${state.roomId}/media/ice`, { method: "POST", body: "{}" });
  if (result.enabled) systemMessage("Cloudflare TURN fallback is ready.");
  if (result.warning) systemMessage(`TURN warning: ${result.warning}`);
  return result.iceServers || [{ urls: ["stun:stun.cloudflare.com:3478"] }];
}

async function createMediaSession() {
  const result = await api(`/api/rooms/${state.roomId}/media/session`, { method: "POST", body: "{}" });
  state.sessionId = result.sessionId;
  return result.sessionId;
}

async function startBroadcast() {
  if (!state.connected || state.role !== "host" || state.localStream) return;
  ui.startShare.disabled = true;
  try {
    const profile = qualityProfile();
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: profile.width, max: profile.width },
        height: { ideal: profile.height, max: profile.height },
        frameRate: { ideal: 30, max: 30 },
      },
      audio: true,
    });
    state.localStream = stream;
    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) videoTrack.contentHint = "motion";
    stream.getTracks().forEach((track) => track.addEventListener("ended", () => {
      if (state.localStream) stopBroadcast(true);
    }, { once: true }));

    ui.previewVideo.srcObject = stream;
    ui.previewVideo.style.display = "block";
    ui.stageEmpty.classList.add("hidden");
    setVisible(ui.liveBadge, true);
    setVisible(ui.startShare, false);
    setVisible(ui.stopShare, true);
    const iceServers = await getIceServers();
    const sessionId = await createMediaSession();
    const pc = new RTCPeerConnection({ iceServers, bundlePolicy: "max-bundle" });
    state.pc = pc;
    monitorPeerConnection(pc);

    const transceivers = stream.getTracks().map((track) => {
      const init = { direction: "sendonly" };
      if (track.kind === "video") {
        init.sendEncodings = [
          { rid: "a", scaleResolutionDownBy: 1, maxBitrate: profile.bitrate, maxFramerate: 30 },
          { rid: "m", scaleResolutionDownBy: 2, maxBitrate: Math.max(1_200_000, Math.round(profile.bitrate * 0.45)), maxFramerate: 30 },
          { rid: "z", scaleResolutionDownBy: 4, maxBitrate: Math.max(500_000, Math.round(profile.bitrate * 0.18)), maxFramerate: 24 },
        ];
      }
      return pc.addTransceiver(track, init);
    });
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
    toast("Broadcast is live");
  } catch (error) {
    console.error(error);
    toast(error.message || "Could not start broadcasting");
    await stopBroadcast(false);
  } finally {
    ui.startShare.disabled = false;
  }
}

async function subscribeToBroadcast() {
  if (!state.media || state.role !== "viewer" || state.subscriptionPending) return;
  closePeerConnection();
  state.subscriptionPending = true;
  const generation = ++state.subscriptionGeneration;
  const requestedVersion = state.media.version;
  hideVideos();
  updateStageEmpty("Connecting to the projection…", "Cloudflare is choosing the best route for you.");
  try {
    const iceServers = await getIceServers();
    const sessionId = await createMediaSession();
    const pc = new RTCPeerConnection({ iceServers, bundlePolicy: "max-bundle" });
    state.pc = pc;
    monitorPeerConnection(pc);
    const stream = new MediaStream();
    ui.remoteVideo.srcObject = stream;
    pc.addEventListener("track", ({ track }) => {
      stream.addTrack(track);
      ui.remoteVideo.style.display = "block";
      ui.stageEmpty.classList.add("hidden");
      setVisible(ui.liveBadge, true);
      ui.remoteVideo.play().catch(() => toast("Tap the video to start audio"));
    });
    const response = await api(`/api/rooms/${state.roomId}/media/subscribe`, {
      method: "POST",
      body: JSON.stringify({ sessionId, quality: ui.qualitySelect.value }),
    });
    if (state.media?.version !== requestedVersion || generation !== state.subscriptionGeneration) {
      pc.close();
      return;
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
    if (generation !== state.subscriptionGeneration || state.pc !== pc) {
      pc.close();
      return;
    }
    startStats();
  } catch (error) {
    if (generation !== state.subscriptionGeneration) return;
    console.error(error);
    updateStageEmpty("The stream couldn't connect", error.message || "Try again in a moment.");
    toast(error.message || "Stream connection failed");
  } finally {
    if (generation === state.subscriptionGeneration) state.subscriptionPending = false;
  }
}

function monitorPeerConnection(pc) {
  pc.addEventListener("connectionstatechange", () => {
    if (state.pc !== pc) return;
    if (pc.connectionState === "connected") setConnection("Stream connected", "online");
    if (["failed", "disconnected"].includes(pc.connectionState)) setConnection("Stream interrupted", "warn");
    if (pc.connectionState === "failed" && state.role === "viewer") {
      setTimeout(() => state.media && subscribeToBroadcast(), 1500);
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
  const hadStream = Boolean(state.localStream);
  const sessionId = state.sessionId;
  const localStream = state.localStream;
  state.localStream = null;
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
  stopStats();
  if (state.pc) {
    try { state.pc.close(); } catch {}
  }
  state.pc = null;
  state.sessionId = "";
  state.previousBytes = null;
}

function hideVideos() {
  ui.remoteVideo.pause();
  ui.remoteVideo.srcObject = null;
  ui.remoteVideo.style.display = "none";
  ui.previewVideo.srcObject = null;
  ui.previewVideo.style.display = "none";
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

function openLocalMovie() {
  ui.movieFile.click();
}

function launchMovieFile() {
  const file = ui.movieFile.files?.[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  const player = window.open(url, "_blank");
  if (player) player.opener = null;
  if (!player) toast("Allow pop-ups, then try again");
  else toast("Movie opened — share that new tab with audio");
  setTimeout(() => URL.revokeObjectURL(url), 12 * 60 * 60 * 1000);
  ui.movieFile.value = "";
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

async function collectStats() {
  const pc = state.pc;
  if (!pc || pc.connectionState === "closed") return;
  try {
    const reports = await pc.getStats();
    let rtp = null;
    let pair = null;
    let remoteInbound = null;
    reports.forEach((report) => {
      const videoKind = report.kind === "video" || report.mediaType === "video";
      if (videoKind && report.type === (state.role === "host" ? "outbound-rtp" : "inbound-rtp") && !report.isRemote) rtp = report;
      if (report.type === "candidate-pair" && report.state === "succeeded" && (report.nominated || report.selected)) pair = report;
      if (videoKind && report.type === "remote-inbound-rtp") remoteInbound = report;
    });
    if (!rtp) return;
    const now = Number(rtp.timestamp) || performance.now();
    const bytes = Number(state.role === "host" ? rtp.bytesSent : rtp.bytesReceived) || 0;
    let bitrateKbps = 0;
    if (state.previousBytes && now > state.previousBytes.time) {
      bitrateKbps = Math.round(((bytes - state.previousBytes.bytes) * 8) / (now - state.previousBytes.time));
    }
    state.previousBytes = { bytes, time: now };

    let route = "direct";
    let transport = "unknown";
    if (pair) {
      const local = reports.get(pair.localCandidateId);
      const remote = reports.get(pair.remoteCandidateId);
      if (local?.candidateType === "relay" || remote?.candidateType === "relay") route = "turn";
      transport = String(local?.protocol || remote?.protocol || "unknown").toLowerCase();
      if (transport === "ssl" || transport === "tls") transport = "tls";
    }
    const received = Number(rtp.packetsReceived) || 0;
    const lost = Math.max(0, Number(rtp.packetsLost) || Number(remoteInbound?.packetsLost) || 0);
    const packetLoss = received + lost > 0 ? Number(((lost / (received + lost)) * 100).toFixed(1)) : 0;
    const rttMs = Math.round(1000 * (Number(pair?.currentRoundTripTime) || Number(remoteInbound?.roundTripTime) || 0));
    const jitterMs = Math.round(1000 * (Number(rtp.jitter) || 0));
    const framesDropped = Number(rtp.framesDropped) || 0;
    const qualityLimitationReason = String(rtp.qualityLimitationReason || "none");
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
    };
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
  ui.routeValue.textContent = quality.route === "turn" ? "SFU via TURN" : "Cloudflare SFU";
  ui.transportValue.textContent = quality.transport.toUpperCase();
  ui.bitrateValue.textContent = quality.bitrateKbps ? `${quality.bitrateKbps} kbps` : "—";
  ui.latencyValue.textContent = quality.rttMs ? `${quality.rttMs} ms` : "—";
  ui.lossValue.textContent = `${quality.packetLoss}%`;
  ui.resolutionValue.textContent = quality.width ? `${quality.width}×${quality.height} · ${quality.fps} fps` : "—";
  ui.frameDropsValue.textContent = Number.isFinite(quality.framesDropped) ? String(quality.framesDropped) : "—";
  ui.limitationValue.textContent = quality.qualityLimitationReason && quality.qualityLimitationReason !== "none"
    ? quality.qualityLimitationReason
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
  if (state.ws) state.ws.close(1000, "Left room");
  if (state.localStream) state.localStream.getTracks().forEach((track) => track.stop());
  closePeerConnection();
  sessionStorage.removeItem("cinema.invite");
  sessionStorage.removeItem("cinema.room");
  location.href = state.role === "host" ? "/host" : "/";
}

function bindEvents() {
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
  ui.movieFile.addEventListener("change", launchMovieFile);
  ui.fullscreenButton.addEventListener("click", () => ui.stage.requestFullscreen?.());
  ui.pictureInPicture.addEventListener("click", async () => {
    const video = state.role === "host" ? ui.previewVideo : ui.remoteVideo;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (video.srcObject) await video.requestPictureInPicture();
    } catch { toast("Picture-in-picture is not available"); }
  });
  ui.qualitySelect.addEventListener("change", () => {
    localStorage.setItem("cinema.quality", ui.qualitySelect.value);
    if (state.role === "viewer" && state.media) subscribeToBroadcast();
    else if (state.localStream) toast("Restart the broadcast to apply host quality");
  });
  ui.copyGuestLink.addEventListener("click", copyGuestInvite);
  ui.lockRoom.addEventListener("click", toggleRoomLock);
  ui.createInvite.addEventListener("click", createInvitation);
  ui.copyNewInvite.addEventListener("click", () => copyText(ui.newInviteLink.value, "Invitation copied"));
  ui.endRoom.addEventListener("click", endScreening);
  ui.leaveRoom.addEventListener("click", leaveRoom);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.localStream && !state.wakeLock) requestWakeLock();
  });
}

initialize();
