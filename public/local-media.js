// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Private Cinema contributors.
// Open-source snapshot prepared 2026-10-29; see CHANGELOG.md.
// Shared local-only helpers. Movie bytes and object URLs never leave the player.
export const LOCAL_MEDIA_RELEASE = "2.4.0-open-source-20261029";

export function normaliseLocalState(data, now = performance.now()) {
  if (data?.type !== "player-state" || !Number.isFinite(data.time) || data.time < 0) return null;
  const status = ["empty", "loading", "ready", "error", "closed"].includes(data.status) ? data.status : "empty";
  const duration = Number.isFinite(data.duration) && data.duration > 0 ? data.duration : 0;
  const rate = Number.isFinite(data.rate) && data.rate > 0 ? Math.max(0.25, Math.min(4, data.rate)) : 1;
  const hasFile = Boolean(data.hasFile) && !["empty", "error", "closed"].includes(status);
  const paused = Boolean(data.paused);
  const waiting = Boolean(data.waiting);
  return { status, time: data.time, duration, rate, hasFile, paused, waiting,
    ready: hasFile && status === "ready", playing: hasFile && status === "ready" && !paused && !waiting,
    name: String(data.name || "").replace(/[\u0000-\u001f]/g, "").slice(0, 180),
    audioStatus: String(data.audioStatus || "unknown").slice(0, 24),
    audioWarning: String(data.audioWarning || "").replace(/[\u0000-\u001f]/g, "").slice(0, 240), receivedAt: now };
}

export function localMovieClock(state, now = performance.now()) {
  if (!state) return { time: 0, playing: false, rate: 1 };
  const age = Math.max(0, now - state.receivedAt);
  const fresh = age <= 10_000;
  const time = state.time + (state.playing ? Math.min(age, 10_000) / 1000 * state.rate : 0);
  return { time: Math.max(0, state.duration > 0 ? Math.min(time, state.duration) : time),
    playing: Boolean(state.playing && fresh), rate: state.rate };
}

export function localCaptureDecision(settings, handle, channelId, origin, explicit = false) {
  if (handle?.handle === channelId && handle.origin === origin && channelId) return { local: true, verified: true };
  if (!explicit) return { local: false, verified: false };
  if (settings?.displaySurface !== "browser") return { local: false, error: "Choose the local player under Chrome Tab, not Window or Entire Screen. 请选择本地播放器的 Chrome 标签页，不要选择窗口或整个屏幕。" };
  if (handle?.handle) return { local: false, error: "This is a different tab. Choose the Private Cinema local player. 选中的不是本地播放器，请重新选择。" };
  return { local: true, verified: false };
}

export function disableEmbeddedTextTracks(video) {
  for (const track of Array.from(video.textTracks || [])) {
    if (track.mode !== "disabled") track.mode = "disabled";
  }
}

export function formatMovieTime(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor(value % 3600 / 60);
  const remaining = String(value % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${remaining}` : `${minutes}:${remaining}`;
}
