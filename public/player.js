import { disableEmbeddedTextTracks, formatMovieTime } from "./local-media.js?v=2.3.8-local-player-20261028";

const params = new URLSearchParams(location.search);
const channelId = params.get("channel") || "";
const movie = document.getElementById("movie");
const empty = document.getElementById("empty");
const picker = document.getElementById("localFile");
const status = document.getElementById("playerStatus");
const fileLabel = document.getElementById("fileLabel");
const connection = document.getElementById("roomConnection");
const failure = document.getElementById("playerError");
let objectUrl = "";
let movieName = "";
let lastPeriodicUpdate = 0;
let waiting = false;
let mediaStatus = "empty";
let roomConnected = false;
let channel = null;

if (channelId && typeof BroadcastChannel !== "undefined") {
  channel = new BroadcastChannel(`cinema-player-${channelId}`);
  try {
    navigator.mediaDevices?.setCaptureHandleConfig?.({ exposeOrigin: true, handle: channelId,
      permittedOrigins: [location.origin] });
  } catch { /* The room also has an explicit browser-tab-only fallback. */ }
}

function report(reason, force = false) {
  const now = performance.now();
  if (!force && now - lastPeriodicUpdate < 750) return;
  lastPeriodicUpdate = now;
  channel?.postMessage({ type: "player-state", reason, name: movieName, status: mediaStatus,
    hasFile: Boolean(objectUrl), time: Number(movie.currentTime) || 0,
    duration: Number.isFinite(movie.duration) ? movie.duration : 0, rate: movie.playbackRate,
    paused: movie.paused || movie.ended, waiting: waiting || movie.seeking });
  if (mediaStatus === "ready") status.textContent = `${movie.paused ? "Paused / 已暂停" : waiting ? "Buffering / 正在读取本地文件" : "Playing / 播放中"} · ${formatMovieTime(movie.currentTime)} / ${formatMovieTime(movie.duration)}`;
}

function announce() {
  channel?.postMessage({ type: "ready" });
  report("heartbeat", true);
}

function showPlaybackError() {
  mediaStatus = "error";
  waiting = false;
  document.body.dataset.sharing = "false";
  status.textContent = "Cannot decode this file / 浏览器无法解码这个文件";
  failure.hidden = false;
  failure.textContent = movie.error?.code === 3
    ? "Decoding failed. Try an H.264 + AAC MP4 or a supported WebM. 文件解码失败，请使用 H.264 + AAC 的 MP4，或兼容的 WebM。"
    : "This browser cannot play this container or its audio/video codecs. MKV support depends on its codecs. Convert the file locally to H.264 + AAC MP4; this website does not transcode movies. 浏览器不支持此封装或音视频编码。请在本地转换为兼容的 MP4，网站不会自动转码。";
  report("error", true);
}

picker.addEventListener("change", () => {
  const file = picker.files?.[0];
  if (!file) return;
  movie.pause();
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);
  movieName = file.name;
  mediaStatus = "loading";
  waiting = true;
  failure.hidden = true;
  fileLabel.textContent = movieName;
  document.title = `Local movie / 本地电影 — ${movieName}`;
  empty.hidden = true;
  movie.hidden = false;
  movie.src = objectUrl;
  movie.load();
  disableEmbeddedTextTracks(movie);
  status.textContent = "Loading local file / 正在读取本地文件";
  picker.value = "";
  report("load", true);
});

for (const event of ["play", "pause", "seeked", "loadedmetadata", "ended", "playing", "canplay", "waiting", "stalled", "seeking", "ratechange", "loadeddata"]) {
  movie.addEventListener(event, () => {
    disableEmbeddedTextTracks(movie);
    if (["waiting", "seeking"].includes(event) || (event === "stalled" && movie.readyState < 3)) waiting = true;
    if (["playing", "canplay", "seeked", "loadeddata"].includes(event)) waiting = false;
    if (objectUrl && movie.readyState >= 2 && !movie.error) mediaStatus = "ready";
    report(event, true);
  });
}
movie.addEventListener("timeupdate", () => report("timeupdate"));
movie.addEventListener("error", showPlaybackError);
movie.textTracks?.addEventListener("addtrack", () => disableEmbeddedTextTracks(movie));
movie.textTracks?.addEventListener("change", () => disableEmbeddedTextTracks(movie));

channel?.addEventListener("message", async ({ data }) => {
  if (data?.type === "room-ready") {
    roomConnected = true;
    connection.textContent = "Room linked / 已连接房间";
    report("room-ready", true);
  }
  if (data?.type === "room-detached") {
    roomConnected = false;
    connection.textContent = "Room link closed / 房间连接已关闭";
  }
  if (data?.type === "sharing") document.body.dataset.sharing = data.active ? "true" : "false";
  if (data?.type !== "command" || !roomConnected || !objectUrl || mediaStatus === "error") return;
  if (data.action === "toggle") {
    if (movie.paused) {
      try { await movie.play(); }
      catch { status.textContent = "Click Play on this player once / 请先在此播放器点击一次播放"; }
    } else movie.pause();
  }
  if (data.action === "seek" && Number.isFinite(data.time) && Number.isFinite(movie.duration)) {
    movie.currentTime = Math.max(0, Math.min(movie.duration, data.time));
  }
  report("command", true);
});

document.getElementById("pictureMode").addEventListener("click", () => {
  document.body.dataset.sharing = document.body.dataset.sharing === "true" ? "false" : "true";
});
document.getElementById("fullscreen").addEventListener("click", () => movie.requestFullscreen?.());
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") document.body.dataset.sharing = "false";
});
window.addEventListener("beforeunload", () => {
  mediaStatus = "closed";
  movie.pause();
  report("closed", true);
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  channel?.close();
  channel = null;
});
if (!channel) connection.textContent = "Standalone player / 独立播放，字幕需手动同步";
announce();
setInterval(() => {
  if (!roomConnected) channel?.postMessage({ type: "ready" });
  report("heartbeat", true);
}, 1_000);
