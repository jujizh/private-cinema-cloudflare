# Verification — 2.3.7-join-fix-20261026

Completed locally on 2026-10-26:

- `npm ci --ignore-scripts --no-audit --no-fund`: passed against the included lockfile.
- `npm run check`: 49 checks passed, zero failed; includes static/source assertions
  as well as runtime connection/controller, page-wiring and server/security tests.
- `wrangler deploy --dry-run`: passed; existing three Durable Object bindings
  and static assets were recognized. No production deployment was performed.
- Headless Chrome: real localhost HTTP and WebSocket upgrade integration passed.
  First upgrade rejected with 503, second fresh ticket entered the room; later
  control disconnect reconnected without reloading the page.
- Mobile viewport in the same browser: three rejected upgrades stopped retrying,
  restored the join button, and exposed a copyable redacted report. Cancel during
  a pending handshake dismissed the overlay and allowed another manual attempt.
- Browser clipboard report: no fixture ticket or room ID included; no page errors.
- Upload-overlay simulation: copying this release over the retired v2.3.7 source
  passed all 49 checks, including replacement of `test/media-health.test.js`.
- `src/room.js`, `src/sfu.js`, `src/security.js`, `src/directory.js`,
  `wrangler.jsonc` and local-player assets match v2.3.6 byte-for-byte.

Not verified: Anna's network, China–Russia production routing, long-duration
movie playback, or a network/security rule permanently rejecting WebSockets.
The browser tests use a local fixture, not Cloudflare or the production room.
