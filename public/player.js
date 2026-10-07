const params = new URLSearchParams(location.search);
const channelId = params.get("channel") || "";
const movie = document.getElementById("movie");
const empty = document.getElementById("empty");
let objectUrl = "";
let lastPeriodicUpdate = 0;

if (!channelId || typeof BroadcastChannel === "undefined") {
  empty.innerHTML = "<strong>The controlled player could not connect.</strong><span>Close this tab and open the local movie again.</span>";
} else {
  const channel = new BroadcastChannel(`cinema-player-${channelId}`);
  const report = (reason, force = false) => {
    const now = performance.now();
    if (!force && now - lastPeriodicUpdate < 750) return;
    lastPeriodicUpdate = now;
    channel.postMessage({
      type: "clock",
      reason,
      time: Number(movie.currentTime) || 0,
      paused: movie.paused || movie.ended,
    });
  };

  channel.addEventListener("message", ({ data }) => {
    if (data?.type !== "load" || !(data.file instanceof File)) return;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(data.file);
    movie.src = objectUrl;
    movie.style.display = "block";
    empty.style.display = "none";
    document.title = `${data.name || data.file.name} — Private Cinema`;
    movie.play().catch(() => {});
  });

  for (const event of ["play", "pause", "seeked", "loadedmetadata", "ended"]) {
    movie.addEventListener(event, () => report(event, true));
  }
  movie.addEventListener("timeupdate", () => report("timeupdate"));
  window.addEventListener("beforeunload", () => {
    report("pause", true);
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    channel.close();
  });
  channel.postMessage({ type: "ready" });
}
