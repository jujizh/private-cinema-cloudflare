# Verification — 2.3.11-caption-sync-20261029

2026-10-29: `npm run check` passed 67 tests and JavaScript syntax checks.
Wrangler `deploy --dry-run` passed, recognizing the existing three Durable
Object bindings and 10 public assets. No deployment or GitHub write performed.

Chrome 156.0.8078.48 passed a local HTTP/WebSocket integration fixture with
real native video and external audio elements using synthetic VP8/Opus WebM:

- Seek to 5 seconds BEFORE starting capture; a simulated browser-tab track
  has no Capture Handle. Host confirmation binds subtitles to the source
  clock rather than zero; a clock-snapshot request refreshes that state.
- Room play/pause/seek and 1.5x rate propagate through the real source player;
  external audio follows play/pause/seek. Paused caption time remains fixed.
- 100 forced updates plus a final paused seek coalesce to a bounded number of
  sends; a separate viewer receives the final paused time of 9 seconds.
- Independent English/Russian captions, embedded text-track disabling, no
  movie upload requests, readable unsupported-file errors and mobile layouts.
- Zero page errors. The source chooser is mocked; no actual SFU/P2P session,
  China-Russia path, full movie endurance test or receiver-delay measurement.

Source changes are limited to subtitle-clock flow, source confirmation, its
server message budget and release markers/docs/tests. No native audio tool,
codec settings, routing policy, migrations or credentials are changed.

## Historical v2.3.10 verification (not rerun in this release)

66 existing automated checks passed. Chrome 156 tested the complete episode-8
MKV with generated AAC M4A: play/pause, seeks to 10/1000/2600 seconds, 1.5x
speed, volume and detach passed with no page errors. One sampled drift was
0.078 seconds, not a worst-case bound. Room/subtitle regression fixture passed.
Desktop/mobile screenshots inspected. Cross-country tab-audio capture and
continuous full-episode playback were not tested.

CinemaAudio 1.1 exported the full audio in 81.938 seconds: 69,246,914 bytes.
Output AAC stereo duration 2834.667 seconds; input container duration 2852.433.
Cache reuse passed with the final executable; failures now preserve details.

Deployment completed before the user's later GitHub-first instruction could
stop it. Version: 1cf6bb42-26c1-4046-bff8-66fd61aed1dc. No further direct
deploy or rollback was performed after that instruction. GitHub unchanged.

## Historical audio-check verification

2026-10-28: 66 automated checks passed, including Matroska audio track parser,
unknown/malformed metadata, bounded 5+ GiB offset reads and decoded-audio
override. Real Chrome 156 local fixture read the user's 7.3 GB MKV and found
`A_DTS` by reading 65,536 bytes of metadata. The room UI showed the warning;
switching to another file cleared it. No movie upload occurred. Browser test
also covered native player, clock controls, independent subtitles and mobile UI.
Wrangler dry run passed; this release has not been deployed. This is a risk
indicator, not a universal codec-support guarantee; other containers are not
parsed and current sound output is not automatically proven.

## Historical v2.3.8 verification

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
