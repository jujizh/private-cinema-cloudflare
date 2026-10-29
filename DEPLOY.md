# Deploying v2.3.11 Caption Sync on Cloudflare

For this upgrade, see [UPGRADE-2.3.11.md](UPGRADE-2.3.11.md). Use your existing
GitHub-to-Cloudflare deployment; the supplied ZIP contains source, not a live
deployment. Existing bindings and secrets must remain unchanged.

Read [UPGRADE-2.3.8.md](UPGRADE-2.3.8.md) first. Deploy the complete package,
including `public/local-media.js`, the player assets, and the included tests.
Do not mix old and new files or upload node_modules/.wrangler/build-output.

Verify `/api/config` reports `version: "2.3.11"` and
`release: "2.3.11-caption-sync-20261029"`; a version number alone is not sufficient.

This package targets the existing `jujizh-jiahao-private-cinema-cloudflare`
Worker and `cinema.mofangnet.eu.org` domain. Preserve the existing Durable
Object migrations, bindings and secrets. Do not create a differently named Worker.

## 1. Create a Cloudflare Realtime SFU app

In Cloudflare Dashboard, open **Realtime** and create an SFU application. Copy its application ID and application secret. Cloudflare's current API guide is:

https://developers.cloudflare.com/realtime/sfu/https-api/

The application secret must stay server-side. Never put it in `public/app.js`, a GitHub variable committed to the repository, or a screenshot.

## 2. Keep the rotated TURN key

The TURN key you already recreated can be reused. Its long-lived API token also stays server-side. Temporary browser credentials are generated only after a valid invite has joined a live room.

Cloudflare's TURN credential guide is:

https://developers.cloudflare.com/realtime/turn/generate-credentials/

## 3. Add six Worker secrets

Open:

**Cloudflare Dashboard → Workers & Pages → jujizh-jiahao-private-cinema-cloudflare → Settings → Variables and Secrets**

Add every item below as **Secret**, not plain text:

| Secret name | Value |
| --- | --- |
| `APP_AUTH_SECRET` | A new random value of at least 32 characters; 64 random characters is better |
| `ADMIN_PASSWORD` | The password used only at `/host` |
| `CF_REALTIME_APP_ID` | Realtime SFU application ID |
| `CF_REALTIME_APP_SECRET` | Realtime SFU application secret |
| `TURN_KEY_ID` | Existing rotated TURN key ID |
| `TURN_KEY_API_TOKEN` | Existing rotated TURN API token |

Optional plain setting:

| Variable | Default | Purpose |
| --- | ---: | --- |
| `TURN_TTL_SECONDS` | `14400` | Lifetime of temporary TURN credentials; clamped to 1–24 hours |

If `APP_AUTH_SECRET` is later changed, all existing owner sessions and room invitations immediately stop validating. That is useful for emergency rotation, but do it deliberately.

## 4. Replace the repository contents

The repository root should contain exactly this shape:

```text
public/
src/
test/
.gitignore
DEPLOY.md
README.md
SECURITY.md
TESTING.md
package.json
wrangler.jsonc
```

Do not upload an extra outer `jiahao-private-cinema-v2/` directory. If Cloudflare is connected to GitHub, committing these files triggers a new build automatically.

The `wrangler.jsonc` file deliberately preserves the original `v1` `CinemaRoom` Durable Object migration and adds new classes in `v2`. Do not delete or rename those migration tags during the upgrade.

Build settings:

- Build command: `npm run check`
- Deploy command: `npx wrangler deploy`
- Root directory: repository root

If the Cloudflare project already uses its standard Wrangler build settings, committing the new `package.json` and `wrangler.jsonc` is enough.

## 5. Verify the deployment

Open `/host`. Before creating a real room, confirm:

1. The owner login accepts only `ADMIN_PASSWORD`.
2. `/` shows a closed invitation-only entrance.
3. A newly created room produces separate viewer and guest-host permissions.
4. A viewer link works in a private window or second device.
5. Revoking that invitation disconnects the viewer and prevents re-entry.
6. A viewer cannot start broadcasting, even after changing the page URL or browser code.
7. Locking the room blocks a brand-new device, while a previously admitted viewer can reconnect.
8. Add two small subtitle files from the Host controls and confirm both appear
   on the invited viewer without exposing a public download URL.

No new Cloudflare binding or secret is required for v2.3.0. Room subtitle data
uses the existing `ROOMS` Durable Object storage. Existing v2 rooms without a
`captions` field are migrated lazily and continue to work.

v2.3.4 also needs no new binding or secret. Deploy the Worker and refresh every
open cinema tab. Its SFU path stays live as a hot backup during small-room P2P
playback, so Realtime usage can be higher than v2.3.1 by design.

## 6. Test on a real cross-country path

Testing two tabs on one computer does not measure international network quality. Use two devices on different networks for at least ten minutes:

- Start at **Balanced** quality.
- Share a Chrome/Edge tab and enable **Share tab audio**.
- Watch the Network panel for bitrate, latency, packet loss, resolution, and transport.
- Ask a viewer on the restricted network to try without a VPN first.
- If the route reports `SFU via TURN`, the fallback is actually in use.
- If packet loss is high, choose Data saver. If packet loss is low but playback still stutters, check the viewer's CPU, Wi-Fi, and browser decoding.

## Usage and cost awareness

The Worker and Durable Objects carry authentication, room state, chat, and signaling—not every movie frame. Realtime SFU/TURN egress is the part that scales with viewers.

Approximate egress per viewer:

```text
GB ≈ bitrate in Mbps × hours × 0.45
```

At 2.5 Mbps, one viewer for two hours is about 2.25 GB. Ten viewers for two hours is about 22.5 GB. Auto/simulcast may lower the real total for slower viewers.

Current pricing and included usage should always be checked before a large screening:

https://developers.cloudflare.com/realtime/sfu/pricing/

## Rollback

Cloudflare retains deployments, so the fastest emergency rollback is to select the previous successful Worker deployment. Do not delete Durable Object migrations while rolling back. Existing v2 rooms may not be understood by the v1 interface; end active screenings before a planned rollback.
