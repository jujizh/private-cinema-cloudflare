# Release checklist

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
   **Direct P2P** after ICE negotiation completes.
   Route state should report **P2P first frame ready · SFU remains hot**. Keep
   the stream running and confirm the hidden SFU subscription remains connected.
3. Add a second and then a third viewer. Each should negotiate its own P2P or
   P2P-via-TURN route; monitor Host CPU and upload usage while doing so.
4. On the same Wi-Fi, expect UDP, low RTT and near-zero loss. If the panel says
   **P2P via TURN**, inspect router client isolation or firewall rules.
5. Temporarily block direct ICE or test through restrictive mobile networks;
   playback must remain on/fall back to Cloudflare SFU.
6. Add a fourth viewer. Direct routes should close and all viewers should move
   to Cloudflare SFU so Host upload does not grow without bound.
7. Switch one viewer between Wi-Fi and mobile data. It should reconnect under
   the same logical participant identity and negotiate a new media path.
8. Temporarily block the direct route. Video should change to SFU only after the
   backup has a decoded frame and must not show the empty-stage placeholder.
   Route state should say it is pinned to SFU for ten minutes; P2P must not
   repeatedly reconnect during that cooldown.
9. Leave the room idle for at least two minutes. The control WebSocket heartbeat
   should prevent idle disconnects.
10. Briefly interrupt the Host's control connection. Existing media and screen
    capture should remain alive during the 30-second reconnect grace period.
11. Repeat step 8 while recording the Viewer screen. A small timing jump is
    possible because P2P and SFU have different latency, but a multi-second black
    screen or repeated route flapping is a release blocker.

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
