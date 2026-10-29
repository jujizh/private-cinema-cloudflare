# Release checklist

## v2.3.11 caption-sync scope

67 automated checks passed. Real Chrome local integration tested a synthetic
video plus sidecar audio: seek before sharing, explicit source confirmation,
clock snapshot, room play/pause/seek/rate, final paused seek after an event burst,
independent English/Russian captions and mobile overflow. The fixture simulates
the selected capture track and uses local WebSockets, not production WebRTC.

Manual acceptance after deployment: refresh both endpoints and reopen the local
player, load matching video/audio/subtitle versions, seek to the middle BEFORE
sharing, then use Share local player and enable tab audio. Check cue alignment
on both endpoints, then pause, resume and seek forward/back. Verify the release
ID is `2.3.11-caption-sync-20261029`. Test real network/video buffering separately;
this change does not guarantee frame-exact subtitles during receiver freezes.

## v2.3.8 local-player scope

`npm run check` covers 57 checks, including local source validation, playback
clock rate/pause/buffering, heartbeat expiry, disabled embedded text tracks and
the previous join/security/route regressions. See RELEASE-VERIFICATION.md for
real-browser integration results and explicit exclusions.

Manual production acceptance:
1. Refresh both endpoints after verifying the release ID. Open a supported local
   movie from the room link; the tab must open before any file is chosen.
2. Choose the file inside that player. Return to the room and click Share local
   player; select its Chrome Tab and enable audio, not Window/Entire Screen.
3. Check actual sound on the viewer, captured FPS and decoded FPS over 30+ min.
4. Upload matching English/Russian SRT/VTT; choose a different language at each
   endpoint. Pause, resume and seek via room controls and native source controls.
5. Close the source tab. Controls must disable immediately if the close message
   arrives, or within approximately 11 seconds on heartbeat expiry.
6. Try an unsupported file: the player must show a decode/format error, not the
   old popup-permission message. Do not claim every MKV can play.
7. Repeat after a temporary control-network loss; media routing must retain the
   v2.3.7 join-fix behavior. A browser/headless fixture cannot prove this on Anna's network.

## v2.3.7 join-fix regression scope

The previous v2.3.7 `npm run check` covered 49 checks (architecture/source assertions, connection
controller runtime tests, app integration with a simulated DOM, server reconnect
grace, and security). These checks do not prove China–Russia reachability.

After deployment, verify the release ID in `/api/config`, then test initial join,
Cancel, manual retry after failure, and a temporary network loss/recovery with
both endpoints. A successful initial join must include the server's `welcome`,
not just a WebSocket `open`. Ask for the built-in connection report if it fails.
An HTTP 403 shown in the report is an admission response, not proof of a WAF rule;
the browser generally hides the HTTP status of a rejected WebSocket upgrade.

## Original baseline checklist

## Automated

Run:

```text
npm install
npm run check
npx wrangler deploy --dry-run
```

This checks every JavaScript file, token signing and tamper rejection, expiry handling, input normalization, page/UI wiring, secret isolation, role enforcement markers, and Durable Object migration continuity.

## Browser smoke test

Use current Chrome or Edge.

1. Open `/host`, sign in, and create a six-hour room.
2. Open the viewer invitation in a private window with a different client identity.
3. Verify the presence count is two and no duplicate join/leave messages appear.
4. Start a tab share with audio and confirm video/audio arrive.
5. Switch viewer quality among Data saver, Balanced, Best quality, and Auto.
6. Confirm the Network panel updates every five seconds.
7. Stop sharing and verify the viewer returns to the waiting screen.
8. Reconnect both sides after briefly disabling Wi-Fi.
9. Lock the room; confirm the admitted viewer reconnects but a new private-window identity is rejected.
10. Create a second viewer invite, revoke it, and confirm its connected viewer is removed.
11. Confirm a viewer cannot call publish or host-control endpoints.
12. End the room and confirm all invitations stop working.

## Cross-border test

Use actual separate networks. Run a ten-minute Balanced-quality clip, then record:

- Route: Cloudflare SFU or SFU via TURN
- Transport: UDP, TCP, or TLS
- Bitrate
- RTT
- Packet loss and jitter
- Resolution and FPS

Interpretation:

- High packet loss: lower quality; compare Wi-Fi and mobile data.
- Very high RTT but low loss: the route is long; TURN or a different viewer network may help.
- Low bitrate with low loss: browser adaptation or local bandwidth/CPU is the likely constraint.
- Good metrics but visual stutter: check hardware decoding, browser load, and whether the shared tab itself is smooth.

## Mobile congestion test

1. Start with both Host and viewer set to **Auto (recommended)**.
2. On the viewer phone, disable Low Power Mode and keep the page in the foreground.
3. Test on Wi-Fi for two minutes, then repeat on mobile data if available.
4. A short quality drop is acceptable; sustained packet loss above 5% is not.
5. Confirm Best quality automatically steps down instead of remaining stuck at
   1080p when packet loss rises.
6. Frame drops are now shown per five-second interval. A large old total should
   no longer make a recovered connection look permanently unhealthy.

## Hybrid P2P test

1. Join with one viewer and begin broadcasting.
2. The viewer should start on the SFU and then switch automatically to
   **Direct P2P** only after ICE negotiation, a decoded frame, and a six-second
   P2P/SFU comparison complete. Route state should report that the P2P health
   probe passed. Keep the stream running and confirm the hidden SFU subscription
   remains connected.
3. Add a second and then a third viewer. Each should negotiate its own P2P or
   P2P-via-TURN route; monitor Host CPU and upload usage while doing so.
4. On the same Wi-Fi, expect UDP, low RTT and near-zero loss. If the panel says
   **P2P via TURN**, inspect router client isolation or firewall rules.
5. Temporarily block direct ICE or test through restrictive mobile networks;
   playback must remain on/fall back to Cloudflare SFU.
6. Add a fourth viewer. Direct routes should close and all viewers should move
   to Cloudflare SFU so Host upload does not grow without bound.
7. Switch one viewer between Wi-Fi and mobile data. For up to 45 seconds the
   participant row should say **reconnecting** without emitting `left` or
   destroying a still-healthy media path. When the control socket returns it
   should reconnect under the same logical participant identity.
8. Temporarily block the direct route. Video should change to SFU only after the
   backup has a decoded frame and must not show the empty-stage placeholder.
   The Viewer should request a hidden P2P probe after one minute, then back off
   to three and ten minutes after measured failures. SFU must remain visible
   throughout each probe and switch back only when P2P measures healthier.
9. Leave the room idle for at least two minutes. The control WebSocket heartbeat
   should prevent idle disconnects.
10. Briefly interrupt either endpoint's control connection. Existing media and
    screen capture should remain alive during the 45-second reconnect grace
    period. The chat must not alternate repeated `left` and `joined` events.
11. Repeat step 8 while recording the Viewer screen. A small timing jump is
    possible because P2P and SFU have different latency, but a multi-second black
    screen or repeated route flapping is a release blocker.
12. While the Viewer is on Direct P2P, block only its P2P UDP path without
    closing or refreshing the page. If the PeerConnection remains `connected`
    but decoded/presented frames stop, the status should report automatic
    recovery and move to a frame-ready SFU route.
13. Repeat with the Viewer on SFU. A frozen-but-connected SFU subscription
    should be replaced while the last picture remains visible. The Viewer must
    not need to refresh, and a deliberately paused source should not repeatedly
    switch routes.
14. Create loss on both routes, with SFU worse than P2P. Even after the P2P loss
    threshold is reached, the Viewer must keep P2P. Then make SFU clearly better
    and confirm the switch occurs only after its first frame is visible.
15. Disconnect the Viewer control WebSocket when a P2P retry becomes due. The
    visible SFU media must continue. After control reconnects, the Viewer should
    request another background probe without a page refresh.

## Room Caption Library test

1. As Host, choose **Add room subtitles** and select English `.srt` and Russian
   `.vtt` files together.
2. Confirm both tracks appear on every connected endpoint without a refresh.
3. Choose English on one device and Russian on another. Confirm each selection
   and offset remain independent.
4. As Host, remove one selected track. Confirm it disappears everywhere.
5. Confirm a Viewer cannot POST or DELETE Room Caption Library entries.
6. Use −1s/+1s until dialogue aligns with the captured movie.
7. Enter fullscreen and confirm captions remain above the video.
8. Open a supported local MP4/WebM with **Open local video**, share the new
   player tab, then pause and seek. Confirm every endpoint's selected subtitle
   follows automatically.
9. Share an external Tencent/streaming tab. Confirm **Pause subtitles** and
   **Resume subtitles** freeze and resume every endpoint's caption clock. A
   cross-origin service does not expose its private playback state to this app.
10. Change subtitle size independently on desktop and mobile. Confirm the
   default Smaller setting remains readable without covering the picture.

## Capture-source throttling test

1. Share a 24/30 fps movie tab and keep it inside the same window as several
   foreground tabs. Move away from the movie tab and observe diagnostics for at
   least 20 seconds.
2. If capture source remains 24/30 fps while encoded output falls to 20 fps or
   below without packet loss, confirm the source warning becomes highlighted.
3. Move the movie tab to a dedicated browser window and leave the window
   visible. Confirm output recovers to at least 23 fps and the highlight clears
   after two healthy samples.
