# Jiahao Private Cinema — Cloudflare Edition

This version is designed for Cloudflare Workers and does **not** require your PC to keep a Node/Express server running after deployment.

Architecture:

- Static UI: Cloudflare Workers Static Assets
- Room/signaling/chat: Durable Objects + WebSocket Hibernation
- Movie stream: browser-to-browser WebRTC
- NAT/firewall fallback (optional): Cloudflare Realtime TURN

## Easiest deployment: GitHub + Cloudflare Workers Builds

You do not need to run `npm install` on your own Windows computer.

1. Create a new GitHub repository.
2. Upload **all files in this folder** to that repository.
3. Open Cloudflare Dashboard → Workers & Pages.
4. Create application → Import a repository.
5. Connect GitHub and select your repository.
6. Cloudflare should detect the project.
7. Deploy command: `npx wrangler deploy`
8. Save and Deploy.

Cloudflare runs npm/Wrangler in its own build environment.

After deployment you get a URL similar to:

`https://jiahao-private-cinema.<your-subdomain>.workers.dev`

Send the generated viewer link from inside the app to your friend.

## Cloudflare free tier

Durable Objects are available on the Workers Free plan using the SQLite storage backend. This project uses a SQLite-backed Durable Object migration, although the app itself does not need to persist movie/chat data.


## DRM

This app does not bypass DRM. Protected streaming services may deliberately appear black when screen-captured.


## v1.1 connection fix

This build prevents duplicate room sessions caused by double-clicking **Enter room** while a slow WebSocket connection is still opening. It also:

- assigns a per-page `clientId`;
- replaces an older duplicate socket from the same page;
- ignores stale socket close events;
- de-duplicates chat/join/leave/reaction events in the UI.

If you saw repeated `joined`, `left`, or duplicated chat bubbles in v1.0, deploy this version.
