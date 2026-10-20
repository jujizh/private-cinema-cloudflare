// Pure calculations shared by the UI and behavioral regression tests.
export const finite = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;

export function perFrameMs(totalSeconds, totalFrames, previousSeconds, previousFrames) {
  if ([totalSeconds, totalFrames, previousSeconds, previousFrames].some((n) => finite(n) === null)) return null;
  const frames = totalFrames - previousFrames;
  const seconds = totalSeconds - previousSeconds;
  return frames > 0 && seconds >= 0 ? Math.round(seconds * 10000 / frames) / 10 : null;
}

export function actualSourceFps(report, previous) {
  if (!report) return null;
  if (finite(report.framesPerSecond) !== null) return report.framesPerSecond;
  const ms = report.timestamp - (previous?.timestamp ?? report.timestamp);
  if (!previous || finite(report.frames) === null || finite(previous.frames) === null || ms <= 0 || report.frames < previous.frames) return null;
  return Math.round(1000 * (report.frames - previous.frames) / ms);
}

export function smoothHealth(previous, raw, identity) {
  if (!previous || previous.identity !== identity || raw === "connecting" || raw === "offline") {
    return { identity, value: raw, pending: raw, count: 0 };
  }
  if (raw === previous.value) return { ...previous, pending: raw, count: 0 };
  const count = previous.pending === raw ? previous.count + 1 : 1;
  // Only the badge is debounced. Recovery continues using unsmoothed metrics.
  return { identity, value: count >= 2 ? raw : previous.value, pending: raw, count: count >= 2 ? 0 : count };
}

export function viewersConfirmedDirect(viewers, peers, version, now = Date.now()) {
  return viewers.length > 0 && viewers.every((viewer) => {
    const q = viewer.quality;
    return !viewer.reconnecting && peers.get(viewer.id)?.connectionState === "connected"
      && q?.mediaVersion === version && q.playbackRoute === "direct" && q.needsSfu === false
      && Number.isFinite(q.reportedAt) && now >= q.reportedAt && now - q.reportedAt < 20_000;
  });
}
