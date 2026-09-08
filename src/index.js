import {
  base64UrlEncode,
  constantTimeEqual,
  HttpError,
  jsonResponse,
  parseCookies,
  randomToken,
  readBearer,
  readJson,
  safeText,
  signToken,
  verifyToken,
} from "./security.js";
import { AuthRateLimiter, CinemaDirectory } from "./directory.js";
import { CinemaRoom } from "./room.js";
import { realtimeConfigured } from "./sfu.js";

export { AuthRateLimiter, CinemaDirectory, CinemaRoom };

const ADMIN_COOKIE = "cinema_admin";
const ADMIN_SESSION_SECONDS = 12 * 60 * 60;

function securityHeaders(headers = new Headers()) {
  headers.set("Content-Security-Policy", [
    "default-src 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "media-src 'self' blob:",
    "connect-src 'self' wss:",
  ].join("; "));
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), display-capture=(self), fullscreen=(self), picture-in-picture=(self)");
  headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  return headers;
}

function withSecurity(response) {
  if (response.status === 101) return response;
  const headers = securityHeaders(new Headers(response.headers));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function ensureSameOrigin(request) {
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) {
    throw new HttpError(403, "Cross-site request blocked", "csrf_blocked");
  }
}

function ensureCoreSecrets(env) {
  if (!env.APP_AUTH_SECRET || env.APP_AUTH_SECRET.length < 32) {
    throw new HttpError(503, "APP_AUTH_SECRET is missing or too short", "setup_required");
  }
}

async function adminClaims(request, env) {
  const cookie = parseCookies(request.headers.get("Cookie"))[ADMIN_COOKIE];
  const claims = await verifyToken(cookie, env.APP_AUTH_SECRET);
  return claims?.typ === "admin" && claims.role === "owner" ? claims : null;
}

async function requireAdmin(request, env) {
  ensureCoreSecrets(env);
  const claims = await adminClaims(request, env);
  if (!claims) throw new HttpError(401, "Owner sign-in required", "admin_required");
  return claims;
}

function roomStub(env, roomId) {
  const id = env.ROOMS.idFromName(roomId);
  return env.ROOMS.get(id);
}

function directoryStub(env) {
  return env.DIRECTORY.get(env.DIRECTORY.idFromName("main"));
}

function internalHeaders(request, claims) {
  const headers = new Headers();
  headers.set("Content-Type", request.headers.get("Content-Type") || "application/json");
  headers.set("X-Cinema-Claims", base64UrlEncode(JSON.stringify(claims)));
  const clientId = safeText(request.headers.get("X-Cinema-Client"), 100);
  if (clientId) headers.set("X-Cinema-Client", clientId);
  return headers;
}

async function inviteClaims(request, env, roomId) {
  ensureCoreSecrets(env);
  const claims = await verifyToken(readBearer(request), env.APP_AUTH_SECRET);
  if (!claims || claims.typ !== "invite" || claims.room !== roomId) {
    throw new HttpError(401, "A valid invitation is required", "invite_required");
  }
  return claims;
}

async function forwardRoomRequest(request, env, roomId, internalPath, { allowAdmin = false } = {}) {
  const claims = allowAdmin && (await adminClaims(request, env))
    ? { typ: "admin", role: "owner", room: roomId, exp: Math.floor(Date.now() / 1000) + 60 }
    : await inviteClaims(request, env, roomId);
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
  return roomStub(env, roomId).fetch(`https://room${internalPath}`, {
    method: request.method,
    headers: internalHeaders(request, claims),
    body,
  });
}

async function checkLoginRate(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const limiter = env.AUTH_LIMITER.get(env.AUTH_LIMITER.idFromName(ip));
  const status = await limiter.fetch("https://limiter/check");
  const payload = await status.json();
  if (!payload.allowed) throw new HttpError(429, `Too many attempts. Try again in ${payload.retryAfter}s`, "rate_limited");
  return limiter;
}

async function routeApi(request, env) {
  const url = new URL(request.url);
  ensureSameOrigin(request);

  if (url.pathname === "/api/config" && request.method === "GET") {
    return jsonResponse({
      version: "2.0.0",
      realtimeConfigured: realtimeConfigured(env),
      turnConfigured: Boolean(env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN),
      ownerConfigured: Boolean(env.ADMIN_PASSWORD && env.APP_AUTH_SECRET?.length >= 32),
    });
  }

  if (url.pathname === "/api/admin/session" && request.method === "GET") {
    return jsonResponse({ authenticated: Boolean(await adminClaims(request, env)) });
  }

  if (url.pathname === "/api/admin/login" && request.method === "POST") {
    ensureCoreSecrets(env);
    if (!env.ADMIN_PASSWORD) throw new HttpError(503, "ADMIN_PASSWORD is not configured", "setup_required");
    const limiter = await checkLoginRate(request, env);
    const body = await readJson(request, 8192);
    const success = await constantTimeEqual(body.password || "", env.ADMIN_PASSWORD);
    await limiter.fetch("https://limiter/record", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ success }),
    });
    if (!success) throw new HttpError(401, "Wrong owner password", "invalid_password");
    const expiresAt = Math.floor(Date.now() / 1000) + ADMIN_SESSION_SECONDS;
    const token = await signToken({ typ: "admin", role: "owner", jti: randomToken(12), exp: expiresAt }, env.APP_AUTH_SECRET);
    const response = jsonResponse({ authenticated: true });
    response.headers.append(
      "Set-Cookie",
      `${ADMIN_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${ADMIN_SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`,
    );
    return response;
  }

  if (url.pathname === "/api/admin/logout" && request.method === "POST") {
    const response = jsonResponse({ ok: true });
    response.headers.append("Set-Cookie", `${ADMIN_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
    return response;
  }

  if (url.pathname === "/api/admin/rooms" && request.method === "GET") {
    await requireAdmin(request, env);
    return directoryStub(env).fetch("https://directory/");
  }

  if (url.pathname === "/api/admin/rooms" && request.method === "POST") {
    await requireAdmin(request, env);
    if (!realtimeConfigured(env)) {
      throw new HttpError(503, "Create a Cloudflare Realtime SFU app and add its two secrets first", "realtime_not_configured");
    }
    const body = await readJson(request, 16384);
    const roomId = randomToken(18);
    const owner = { typ: "admin", role: "owner", room: roomId, exp: Math.floor(Date.now() / 1000) + 60 };
    return roomStub(env, roomId).fetch("https://room/internal/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cinema-Claims": base64UrlEncode(JSON.stringify(owner)),
      },
      body: JSON.stringify({
        roomId,
        title: safeText(body.title, 100),
        expiresInHours: Math.max(1, Math.min(168, Number(body.expiresInHours) || 24)),
      }),
    });
  }

  const roomMatch = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]{16,80})\/(.+)$/);
  if (roomMatch) {
    const [, roomId, action] = roomMatch;
    if (action === "ticket" && request.method === "POST") {
      return forwardRoomRequest(request, env, roomId, "/internal/ticket");
    }
    if (action === "status" && request.method === "GET") {
      return forwardRoomRequest(request, env, roomId, "/internal/status");
    }
    if (action.startsWith("control/")) {
      return forwardRoomRequest(request, env, roomId, `/internal/${action}`, { allowAdmin: true });
    }
    if (action.startsWith("media/")) {
      return forwardRoomRequest(request, env, roomId, `/internal/${action}`);
    }
  }

  throw new HttpError(404, "API route not found", "not_found");
}

async function routeWebSocket(request, env) {
  const url = new URL(request.url);
  const roomId = safeText(url.searchParams.get("room"), 80);
  const ticket = safeText(url.searchParams.get("ticket"), 120);
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(roomId) || !ticket) {
    return new Response("Invalid room connection", { status: 400 });
  }
  const target = new URL("https://room/internal/ws");
  target.searchParams.set("ticket", ticket);
  return roomStub(env, roomId).fetch(new Request(target, request));
}

async function serveAsset(request, env) {
  const url = new URL(request.url);
  if (url.pathname === "/host") {
    const target = new URL(request.url);
    target.pathname = "/";
    return env.ASSETS.fetch(new Request(target, request));
  }
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      let response;
      if (url.pathname === "/ws") response = await routeWebSocket(request, env);
      else if (url.pathname.startsWith("/api/")) response = await routeApi(request, env);
      else response = await serveAsset(request, env);
      return withSecurity(response);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const code = error instanceof HttpError ? error.code : "internal_error";
      if (!(error instanceof HttpError)) console.error("Worker error", error);
      return withSecurity(jsonResponse({ error: error.message || "Unexpected error", code }, { status }));
    }
  },
};
