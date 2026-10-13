import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("every JavaScript UI reference exists in the page", async () => {
  const [app, html] = await Promise.all([read("public/app.js"), read("public/index.html")]);
  const declaration = app.match(/const ui = Object\.fromEntries\(\[([\s\S]*?)\]\.map/);
  assert.ok(declaration, "UI declaration should be discoverable");
  const ids = [...declaration[1].matchAll(/"([A-Za-z][A-Za-z0-9]+)"/g)].map((match) => match[1]);
  const missing = ids.filter((id) => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, []);
});

test("browser bundle never receives permanent Cloudflare secrets", async () => {
  const app = await read("public/app.js");
  assert.doesNotMatch(app, /CF_REALTIME_APP_SECRET|TURN_KEY_API_TOKEN|ADMIN_PASSWORD|APP_AUTH_SECRET/);
});

test("chat history has a fixed panel and its own scrollbar", async () => {
  const [styles, app] = await Promise.all([read("public/styles.css"), read("public/app.js")]);
  assert.match(styles, /\.chat-panel\{height:\d+px;min-height:0;[^}]*overflow:hidden/);
  assert.match(styles, /\.chat-log\{min-height:0;[^}]*overflow-y:auto/);
  assert.match(styles, /\.chat-log::-webkit-scrollbar/);
  assert.match(app, /ui\.chatLog\.scrollTop = ui\.chatLog\.scrollHeight/);
});

test("direct cinema publishing preserves resolution while SFU keeps a watchable quality floor", async () => {
  const [app, room] = await Promise.all([read("public/app.js"), read("src/room.js")]);
  assert.match(app, /contentHint = "motion"/);
  assert.match(app, /degradationPreference = "maintain-framerate"/);
  assert.match(app, /degradationPreference = "maintain-resolution"/);
  assert.match(app, /preferResolutionForDirect/);
  assert.match(app, /scaleResolutionDownBy: 1/);
  assert.match(app, /function cinemaSfuEncodings/);
  assert.match(app, /rid: "m"[\s\S]*maxBitrate: 2_200_000/);
  assert.doesNotMatch(app, /rid: "z"/);
  assert.match(room, /quality === "high"[\s\S]*preferredRid: "a"[\s\S]*priorityOrdering: "asciibetical"/);
  assert.doesNotMatch(room, /quality === "high"[^\n]*priorityOrdering: "none"/);
});

test("owner can purge room state and stale history is pruned", async () => {
  const [worker, room, directory, app] = await Promise.all([
    read("src/index.js"), read("src/room.js"), read("src/directory.js"), read("public/app.js"),
  ]);
  assert.match(worker, /adminRoomMatch/);
  assert.match(room, /async deleteRoom\(request\)/);
  assert.match(room, /storage\.deleteAll\(\)/);
  assert.match(directory, /request\.method === "DELETE"/);
  assert.match(directory, /7 \* 24 \* 60 \* 60 \* 1000/);
  assert.match(app, /deleteRecentRoom/);
});

test("TURN credential request uses Cloudflare's documented body", async () => {
  const sfu = await read("src/sfu.js");
  assert.match(sfu, /body: JSON\.stringify\(\{ ttl \}\)/);
  assert.doesNotMatch(sfu, /JSON\.stringify\(\{ ttl, customIdentifier/);
});

test("diagnostics report interval loss and the largest active simulcast layer", async () => {
  const app = await read("public/app.js");
  assert.match(app, /rtpCandidates\.sort/);
  assert.match(app, /lostDelta/);
  assert.match(app, /state\.role === "host" \? rtp\.packetsSent : rtp\.packetsReceived/);
  assert.match(app, /framesDropped[^\n]*\? Math\.max/);
  assert.match(app, /\$\{quality\.framesDropped\} \/ 5s/);
  assert.match(app, /visibilityState !== "visible"[\s\S]*previousRtp\.clear/);
  assert.match(app, /function viewerRouteName[\s\S]*"P2P\/TURN"[\s\S]*"SFU\/TURN"/);
  assert.match(app, /Host → SFU hot backup/);
});

test("small rooms get direct P2P fan-out with a hot SFU fallback", async () => {
  const [app, room] = await Promise.all([read("public/app.js"), read("src/room.js")]);
  assert.match(app, /function reconcileDirectRoute/);
  assert.match(app, /MAX_DIRECT_VIEWERS = 3/);
  assert.match(app, /function directFanoutAvailable/);
  assert.match(app, /for \(const viewerId of viewerIds\) startHostDirectPeer\(viewerId\)/);
  assert.match(app, /Direct P2P/);
  assert.match(app, /P2P via TURN/);
  assert.match(app, /directPeers\.values/);
  assert.match(app, /preferH264ForDirectPlayback/);
  assert.match(app, /state\.sfuReady/);
  assert.match(app, /pendingSfuPc/);
  assert.match(room, /data\.type === "p2p:signal"/);
  assert.match(room, /Only host-to-viewer or viewer-to-host/);
  assert.match(app, /scheduleDirectRetry/);
  assert.match(app, /kind: "defer"/);
  assert.match(room, /"hangup", "retry", "defer"/);
  assert.match(app, /function requestSfuStandby/);
  assert.doesNotMatch(app, /sender\.replaceTrack\(null\)/);
  assert.match(app, /scheduleSfuStandbyIfAllDirect/);
});

test("route switching is make-before-break and waits for a decoded frame", async () => {
  const [app, html, styles] = await Promise.all([read("public/app.js"), read("public/index.html"), read("public/styles.css")]);
  assert.match(html, /id="directVideo"/);
  assert.match(html, /id="routeStatusValue"/);
  assert.match(styles, /\.stage video\.is-active/);
  assert.match(app, /function waitForVideoFrame/);
  assert.match(app, /requestVideoFrameCallback/);
  assert.match(app, /async function switchViewerRoute/);
  assert.match(app, /P2P health probe passed · SFU remains hot/);
  assert.match(app, /background P2P retry in/);
  assert.match(app, /DIRECT_FAILURE_COOLDOWN_MS = 10 \* 60_000/);
  assert.match(app, /state\.activeRoute !== "direct" \|\| state\.directPc\?\.connectionState !== "connected"/);
  assert.doesNotMatch(app, /function activateDirectViewer[\s\S]{0,400}state\.pc\.close/);
});

test("SFU playback stays visible while background P2P is measured and retried adaptively", async () => {
  const app = await read("public/app.js");
  assert.match(app, /DIRECT_PROBE_RETRY_DELAYS_MS = \[60_000, 3 \* 60_000, 10 \* 60_000\]/);
  assert.match(app, /DIRECT_PROBE_SAMPLE_MS = 6_000/);
  assert.match(app, /async function measureInboundPath/);
  assert.match(app, /async function validateDirectCandidate/);
  assert.match(app, /Promise\.all\(\[[\s\S]*measureInboundPath\(pc\)[\s\S]*measureInboundPath\(backupPc\)/);
  assert.match(app, /state\.activeRoute === "sfu"[\s\S]*validateDirectCandidate\(pc\)/);
  assert.match(app, /if \(!result\.preferred\)[\s\S]*rejectDirectCandidate/);
  assert.match(app, /direct\.packetLoss \+ 2 <= backup\.packetLoss/);
  assert.match(app, /resolutionHealthy/);
  assert.doesNotMatch(app, /pinned to SFU for 10 minutes/);
});

test("viewer playback watchdog repairs connected-but-frozen media without a page refresh", async () => {
  const app = await read("public/app.js");
  assert.match(app, /MEDIA_STALL_WITH_AUDIO_MS = 7_500/);
  assert.match(app, /MEDIA_STALL_HARD_MS = 15_000/);
  assert.match(app, /function readInboundMediaCounters/);
  assert.match(app, /framesDecoded/);
  assert.match(app, /getVideoPlaybackQuality/);
  assert.match(app, /presentedFrames/);
  assert.match(app, /function recordInboundProgress/);
  assert.match(app, /async function checkViewerPlaybackHealth/);
  assert.match(app, /async function recoverStalledPlayback/);
  assert.match(app, /P2P video stopped decoding/);
  assert.match(app, /subscribeToBroadcast\(true\)/);
  assert.match(app, /make-before-break/);
  assert.match(app, /startPlaybackWatchdog\(\)/);
});

test("network reconnects preserve logical participant identity", async () => {
  const [app, room] = await Promise.all([read("public/app.js"), read("src/room.js")]);
  assert.match(room, /participantId: randomToken\(12\)/);
  assert.match(room, /id: ticket\.participantId \|\| randomToken\(12\)/);
  assert.match(room, /old\.replaced = true/);
  assert.match(room, /if \(meta\.replaced\) return/);
  assert.match(room, /peer:reconnected/);
  assert.match(room, /latestByClient/);
  assert.match(room, /PARTICIPANT_RECONNECT_GRACE_MS = 45_000/);
  assert.match(room, /participantDisconnects/);
  assert.match(room, /reconnecting: Boolean\(meta\.reconnecting\)/);
  assert.match(room, /replacingConnection \|\| pendingReconnect/);
  assert.match(app, /Do not close an existing media route/);
  assert.doesNotMatch(app, /peer:joined[\s\S]{0,300}resetHostDirectPeer/);
  assert.match(app, /type: "ping"/);
  assert.match(room, /type: "pong"/);
  assert.match(room, /publisherDisconnect/);
  assert.match(room, /async alarm\(\)/);
});

test("multiple tabs cannot kick each other into an endless reconnect loop", async () => {
  const app = await read("public/app.js");
  assert.match(app, /sessionStorage\.getItem\(key\)/);
  assert.match(app, /event\.code === 4000 && event\.reason === "Replaced by a newer connection"/);
  assert.match(app, /This room is active in another tab/);
  assert.match(app, /function noteControlRestored/);
  assert.match(app, /controlRestoreNotice\.textContent = text/);
});

test("sustained direct-route packet loss switches only when the hot backup measures better", async () => {
  const app = await read("public/app.js");
  assert.match(app, /DIRECT_HIGH_LOSS_PERCENT = 8/);
  assert.match(app, /DIRECT_HIGH_LOSS_SAMPLES = 2/);
  assert.match(app, /function monitorDirectPathQuality/);
  assert.match(app, /async function recoverPoorDirectQuality/);
  assert.match(app, /async function ensureFreshSfuBackup/);
  assert.match(app, /measureInboundPath\(pc\)/);
  assert.match(app, /measureInboundPath\(state\.pc\)/);
  assert.match(app, /backup\.packetLoss \+ 2 <= direct\.packetLoss/);
  assert.match(app, /SFU is not measurably better, keeping P2P/);
  assert.match(app, /monitorDirectPathQuality\(quality, pc\)/);
  assert.match(app, /P2P measured \$\{direct\.packetLoss\.toFixed\(1\)\}% loss/);
});

test("viewer owns adaptive P2P retries and host honors an explicit retry immediately", async () => {
  const app = await read("public/app.js");
  assert.match(app, /DIRECT_PROBE_RETRY_DELAYS_MS = \[60_000, 3 \* 60_000, 10 \* 60_000\]/);
  assert.match(app, /function scheduleViewerDirectProbe/);
  assert.match(app, /state\.ws\?\.readyState !== WebSocket\.OPEN/);
  assert.match(app, /scheduleViewerDirectProbe\(15_000, "waiting for the control connection"\)/);
  assert.match(app, /signal: \{ kind: "retry" \}/);
  assert.match(app, /state\.directPeerCooldowns\.delete\(from\)/);
  assert.match(app, /await startHostDirectPeer\(from\)/);
});

test("candidate probes are generation-safe and P2P is retired only after SFU has a visible frame", async () => {
  const app = await read("public/app.js");
  assert.match(app, /state\.media\?\.version === requestedVersion/);
  assert.match(app, /generation === state\.directActivationGeneration/);
  assert.match(app, /ui\.directVideo\.srcObject === stream/);
  assert.match(app, /state\.routeSwitchGeneration/);
  assert.match(app, /Only retire P2P after the SFU video has produced a real frame/);
  const switchIndex = app.indexOf('const switched = await switchViewerRoute("sfu"');
  const deferIndex = app.indexOf('signal: { kind: "defer", retryAfterMs: probeDelay }', switchIndex);
  assert.ok(switchIndex >= 0 && deferIndex > switchIndex, "defer must be sent only after the SFU switch succeeds");
});

test("room caption library stores shared SRT or VTT tracks while each endpoint chooses independently", async () => {
  const [app, html, styles, worker, room] = await Promise.all([
    read("public/app.js"), read("public/index.html"), read("public/styles.css"), read("src/index.js"), read("src/room.js"),
  ]);
  assert.match(html, /id="captionFile"[^>]*\.srt,.vtt/);
  assert.match(html, /id="captionSelect"/);
  assert.match(html, /Add room subtitles/);
  assert.match(app, /function parseCaptionFile/);
  assert.match(app, /function cueAtTime/);
  assert.match(app, /function syncCaptionLibrary/);
  assert.match(app, /captions:update/);
  assert.match(app, /\/control\/captions/);
  assert.match(app, /textContent = cue\?\.text/);
  assert.match(styles, /\.caption-overlay/);
  assert.match(worker, /action === "captions" \|\| action\.startsWith\("captions\/"\)/);
  assert.match(room, /CAPTION_MAX_TRACKS = 12/);
  assert.match(room, /storeCaptionContent/);
  assert.match(room, /this\.assertClaim\(claims, \["host", "owner"\]\)/);
  assert.match(room, /type: "captions:update"/);
});

test("room captions have responsive sizing and a host-synchronised playback clock", async () => {
  const [app, html, styles, room, player] = await Promise.all([
    read("public/app.js"), read("public/index.html"), read("public/styles.css"), read("src/room.js"), read("public/player.js"),
  ]);
  assert.match(html, /id="captionSize"/);
  assert.match(html, /id="captionClockToggle"/);
  assert.match(styles, /caption-overlay\[data-size="standard"\]/);
  assert.match(styles, /font-size:clamp\(12px,1\.15vw,20px\)/);
  assert.match(app, /function currentCaptionTime/);
  assert.match(app, /type: "caption:clock"/);
  assert.match(room, /captionClockState/);
  assert.match(room, /data\.type === "caption:clock"/);
  assert.match(player, /BroadcastChannel/);
  assert.match(player, /"play", "pause", "seeked"/);
});

test("host is warned when an otherwise healthy browser capture is background-throttled", async () => {
  const [app, html, styles] = await Promise.all([read("public/app.js"), read("public/index.html"), read("public/styles.css")]);
  assert.match(html, /共享源可能被浏览器降速，请把电影标签页移到独立窗口并保持活动/);
  assert.match(app, /function updateSourceThrottleWarning/);
  assert.match(app, /sourceFps >= 24/);
  assert.match(app, /quality\.fps > 0 && quality\.fps <= 20/);
  assert.match(app, /sourceThrottleSamples >= 3/);
  assert.match(styles, /\.source-warning\.is-active/);
});

test("server enforces invitations and host publishing", async () => {
  const [worker, room] = await Promise.all([read("src/index.js"), read("src/room.js")]);
  assert.match(worker, /valid invitation is required/i);
  assert.match(room, /Host permission required/);
  assert.match(room, /Another host is already broadcasting/);
  assert.match(room, /Invitation revoked/);
  assert.match(room, /Join the room before using media/);
});

test("deployment preserves the original room migration and adds long-term services", async () => {
  const config = JSON.parse(await read("wrangler.jsonc"));
  assert.deepEqual(config.migrations[0], { tag: "v1", new_sqlite_classes: ["CinemaRoom"] });
  assert.deepEqual(config.migrations[1], {
    tag: "v2",
    new_sqlite_classes: ["CinemaDirectory", "AuthRateLimiter"],
  });
  assert.deepEqual(
    config.durable_objects.bindings.map((binding) => binding.name).sort(),
    ["AUTH_LIMITER", "DIRECTORY", "ROOMS"],
  );
});
