import assert from "node:assert/strict";
import test from "node:test";

import {
  constantTimeEqual,
  parseCookies,
  randomToken,
  safeText,
  signToken,
  verifyToken,
} from "../src/security.js";

const secret = "test-secret-that-is-longer-than-thirty-two-characters";

test("signed invitations validate and detect tampering", async () => {
  const token = await signToken({ typ: "invite", room: "room-a", role: "viewer", exp: 4_000_000_000 }, secret);
  const claims = await verifyToken(token, secret, 1_000);
  assert.equal(claims.room, "room-a");
  assert.equal(claims.role, "viewer");

  const [payload, signature] = token.split(".");
  const tampered = `${payload.slice(0, -1)}A.${signature}`;
  assert.equal(await verifyToken(tampered, secret, 1_000), null);
});

test("expired invitations are rejected", async () => {
  const token = await signToken({ typ: "invite", room: "room-a", role: "viewer", exp: 10 }, secret);
  assert.equal(await verifyToken(token, secret, 11_000), null);
});

test("tokens are random and URL-safe", () => {
  const first = randomToken(24);
  const second = randomToken(24);
  assert.match(first, /^[A-Za-z0-9_-]{32}$/);
  assert.notEqual(first, second);
});

test("password comparison and input normalization behave safely", async () => {
  assert.equal(await constantTimeEqual("correct horse", "correct horse"), true);
  assert.equal(await constantTimeEqual("correct horse", "wrong horse"), false);
  assert.equal(safeText("  hello\n\u0000world  ", 40), "hello world");
  assert.deepEqual(parseCookies("a=1; cinema_admin=a%2Eb; broken"), { a: "1", cinema_admin: "a.b" });
});
