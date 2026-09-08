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

## Optional: Cloudflare Realtime TURN

Direct WebRTC sometimes fails across restrictive NAT/firewall networks. This can matter for a Taiwan ↔ Iran connection.

Cloudflare Realtime provides managed TURN.

1. In Cloudflare, create a TURN key.
2. Add these **Worker secrets**:
   - `TURN_KEY_ID`
   - `TURN_KEY_API_TOKEN`
3. Do not put these secrets in frontend code or GitHub.
4. The Worker endpoint `/api/turn` automatically generates short-lived credentials (6-hour TTL).
5. The browser automatically uses the returned TURN servers.

The frontend removes port 53 TURN/STUN URLs because browsers commonly block or time them out.

## If you want to test the old local Node version instead

Your previous npm error happened because you ran:

`npm install`

from:

`C:\Users\Administrator`

There is no `package.json` there.

You must first `cd` into the extracted project folder, for example:

```bat
cd /d D:\Downloads\jiahao-private-cinema
npm install
npm start
```

That error does not mean npm is broken.

## Sharing audio

Best reliability:

1. Open the MP4 directly in Chrome or Edge (drag the MP4 into a browser tab).
2. In the cinema, click Start sharing.
3. Share that video tab.
4. Enable "Share tab audio".

Sharing a VLC/mpv window can work for video, but system-audio capture depends on browser + Windows behavior.

## DRM

This app does not bypass DRM. Protected streaming services may deliberately appear black when screen-captured.


## v1.1 connection fix

This build prevents duplicate room sessions caused by double-clicking **Enter room** while a slow WebSocket connection is still opening. It also:

- assigns a per-page `clientId`;
- replaces an older duplicate socket from the same page;
- ignores stale socket close events;
- de-duplicates chat/join/leave/reaction events in the UI.

If you saw repeated `joined`, `left`, or duplicated chat bubbles in v1.0, deploy this version.
