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

test("cinema publishing prioritizes motion and enforces a watchable SFU quality floor", async () => {
  const [app, room] = await Promise.all([read("public/app.js"), read("src/room.js")]);
  assert.match(app, /contentHint = "motion"/);
  assert.match(app, /degradationPreference = "maintain-framerate"/);
  assert.match(app, /function cinemaSfuEncodings/);
  assert.match(app, /rid: "m"[\s\S]*maxBitrate: 2_200_000/);
  assert.doesNotMatch(app, /rid: "z"/);
  assert.match(room, /quality === "high"[\s\S]*preferredRid: "a"[\s\S]*priorityOrdering: "asciibetical"/);
  assert.doesNotMatch(room, /quality === "high"[^\n]*priorityOrdering: "none"/);
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
});

test("small rooms get direct P2P fan-out with SFU fallback", async () => {
  const [app, room] = await Promise.all([read("public/app.js"), read("src/room.js")]);
  assert.match(app, /function reconcileDirectRoute/);
  assert.match(app, /MAX_DIRECT_VIEWERS = 3/);
  assert.match(app, /function directFanoutAvailable/);
  assert.match(app, /for \(const viewerId of viewerIds\) startHostDirectPeer\(viewerId\)/);
  assert.match(app, /Direct P2P/);
  assert.match(app, /P2P via TURN/);
  assert.match(app, /directPeers\.values/);
  assert.match(app, /preferH264ForDirectPlayback/);
  assert.match(app, /state\.media && !state\.subscriptionPending\) subscribeToBroadcast/);
  assert.match(room, /data\.type === "p2p:signal"/);
  assert.match(room, /Only host-to-viewer or viewer-to-host/);
  assert.match(app, /scheduleDirectRetry/);
  assert.match(app, /signal: \{ kind: "retry" \}/);
  assert.match(room, /"hangup", "retry"/);
  assert.match(app, /function requestSfuStandby/);
  assert.match(app, /sender\.replaceTrack\(null\)/);
  assert.match(app, /scheduleSfuStandbyIfAllDirect/);
});

test("network reconnects preserve logical participant identity", async () => {
  const [app, room] = await Promise.all([read("public/app.js"), read("src/room.js")]);
  assert.match(room, /participantId: randomToken\(12\)/);
  assert.match(room, /id: ticket\.participantId \|\| randomToken\(12\)/);
  assert.match(room, /old\.replaced = true/);
  assert.match(room, /if \(meta\.replaced\) return/);
  assert.match(room, /peer:reconnected/);
  assert.match(room, /latestByClient/);
  assert.match(app, /resetHostDirectPeer/);
  assert.match(app, /type: "ping"/);
  assert.match(room, /type: "pong"/);
  assert.match(room, /publisherDisconnect/);
  assert.match(room, /async alarm\(\)/);
});

test("each endpoint can load local SRT or VTT subtitle tracks", async () => {
  const [app, html, styles] = await Promise.all([read("public/app.js"), read("public/index.html"), read("public/styles.css")]);
  assert.match(html, /id="captionFile"[^>]*\.srt,.vtt/);
  assert.match(html, /id="captionSelect"/);
  assert.match(app, /function parseCaptionFile/);
  assert.match(app, /function cueAtTime/);
  assert.match(app, /textContent = cue\?\.text/);
  assert.match(styles, /\.caption-overlay/);
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
