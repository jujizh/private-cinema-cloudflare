# Verification — 2.3.8-local-player-20261028

Completed locally on 2026-10-28:

- `npm ci --ignore-scripts --no-audit --no-fund`: passed against the included lockfile.
- `npm run check`: 57 checks passed, zero failed; includes static/source assertions,
  runtime local-media clocks/source checks, join/controller integration,
  server clock compatibility, server reconnect grace and security tests.
- `wrangler deploy --dry-run`: passed; existing three Durable Object bindings
  and static assets were recognized. No production deployment was performed.
- Real Chrome 156.0.8078.48, headless, local HTTP/WebSocket fixture with matching
  CSP/COOP: native source tab opens before file selection, BroadcastChannel
  handshake works without opener access, and a browser-generated WebM decodes.
- Real native media element: room controls pause/resume and seek; 1.5x playback
  rate updates the room clock; captions stop advancing while paused.
- Real TextTrack API: a showing cue is disabled and remains hidden.
- English/Russian SRT uploads through the local fixture: separate room pages
  choose different languages; source player contains no room caption overlay.
  Movie bytes do not travel over the room API. This test does not imply the
  shared video is uncompressed or that no WebRTC video packets are sent.
- Unsupported media: explicit decode/format error, not popup error. Closing a
  player disables controls via close message or heartbeat expiry. Unload-time
  BroadcastChannel messages are best-effort, not a guaranteed signal.
- Desktop 1280px and mobile 390px screenshots inspected. Player has no horizontal
  overflow, local controls fit, and room caption controls wrap on small screens.
- Zero page errors in integration. Synthetic test media is excluded from ZIP.
- `src/sfu.js`, `src/security.js`, `src/directory.js` and `wrangler.jsonc`
  remain byte-identical to the deployed local v2.3.7 join-fix copy. Room server
  only adds optional caption playback rate; migrations/bindings are unchanged.

Not verified: actual browser screen-capture chooser and tab audio, Anna's
network, China–Russia routing, long-duration movie playback, the user's actual
MKV/codecs, PGS/ASS/VobSub support, Windows/GPU lag, or permanently blocked
WebSockets. No OS settings/drivers, credentials or production service changed.
The browser test uses real native playback but simulated selected media and a
local room API; it does not establish a production WebRTC session.
