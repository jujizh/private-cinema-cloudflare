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

1. Join with exactly one viewer and begin broadcasting.
2. The viewer should start on the SFU and then switch automatically to
   **Direct P2P** after ICE negotiation completes.
3. On the same Wi-Fi, expect UDP, low RTT and near-zero loss. If the panel says
   **P2P via TURN**, inspect router client isolation or firewall rules.
4. Temporarily block direct ICE or test through restrictive mobile networks;
   playback must remain on/fall back to Cloudflare SFU.
5. Add a second viewer. The direct connection must close and all viewers should
   show Cloudflare SFU, preventing per-viewer Host upload scaling.
6. Remove the second viewer and restart the broadcast to retest the direct path.
