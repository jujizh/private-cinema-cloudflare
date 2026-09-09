import { HttpError } from "./security.js";

const REALTIME_BASE = "https://rtc.live.cloudflare.com/v1";

export function realtimeConfigured(env) {
  return Boolean(env.CF_REALTIME_APP_ID && env.CF_REALTIME_APP_SECRET);
}

export async function realtimeRequest(env, path, { method = "POST", body } = {}) {
  if (!realtimeConfigured(env)) {
    throw new HttpError(503, "Cloudflare Realtime SFU is not configured", "realtime_not_configured");
  }

  const response = await fetch(`${REALTIME_BASE}/apps/${env.CF_REALTIME_APP_ID}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.CF_REALTIME_APP_SECRET}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }

  if (!response.ok || payload.errorCode) {
    const message = payload.errorDescription || payload.message || `Realtime API returned ${response.status}`;
    throw new HttpError(502, message, "realtime_api_error");
  }

  return payload;
}

export async function createRealtimeSession(env, correlationId) {
  const suffix = correlationId ? `?correlationId=${encodeURIComponent(correlationId)}` : "";
  return realtimeRequest(env, `/sessions/new${suffix}`);
}

export async function generateIceServers(env, _customIdentifier) {
  const fallback = [{ urls: ["stun:stun.cloudflare.com:3478"] }];
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) {
    return { enabled: false, iceServers: fallback, expiresAt: Date.now() + 60 * 60 * 1000 };
  }

  const configuredTtl = Number(env.TURN_TTL_SECONDS || 14400);
  const ttl = Math.max(3600, Math.min(86400, Number.isFinite(configuredTtl) ? configuredTtl : 14400));
  const response = await fetch(
    `${REALTIME_BASE}/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      // Cloudflare's credential endpoint currently documents `ttl` as the
      // request body. Passing analytics-only fields here causes a 400.
      body: JSON.stringify({ ttl }),
    },
  );

  if (!response.ok) {
    return {
      enabled: false,
      iceServers: fallback,
      warning: `TURN API returned ${response.status}`,
      expiresAt: Date.now() + 5 * 60 * 1000,
    };
  }

  const payload = await response.json();
  const iceServers = Array.isArray(payload.iceServers) ? payload.iceServers : fallback;
  for (const server of iceServers) {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    server.urls = urls.filter((url) => url && !String(url).includes(":53"));
  }

  return {
    enabled: true,
    iceServers,
    expiresAt: Date.now() + ttl * 1000,
  };
}
