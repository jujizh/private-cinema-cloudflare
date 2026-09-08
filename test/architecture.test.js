import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("every JavaScript UI reference exists in the page", async () => {
  const [app, html] = await Promise.all([read("public/app.js"), read("public/index.html")]);
  const declaration = app.match(/const ui = Object\.fromEntries\(\[([\s\S]*?)\]\.map/);
  assert.ok(declaration, "UI declaration should be discoverable");
  const ids = [...declaration[1].matchAll(/"([A-Za-z][A-Za-z0-9]+)"/g)].map((match) => match[1]);
  const missing = ids.filter((id) => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, []);
});

test("browser bundle never receives permanent Cloudflare secrets", async () => {
  const app = await read("public/app.js");
  assert.doesNotMatch(app, /CF_REALTIME_APP_SECRET|TURN_KEY_API_TOKEN|ADMIN_PASSWORD|APP_AUTH_SECRET/);
});

test("server enforces invitations and host publishing", async () => {
  const [worker, room] = await Promise.all([read("src/index.js"), read("src/room.js")]);
  assert.match(worker, /valid invitation is required/i);
  assert.match(room, /Host permission required/);
  assert.match(room, /Another host is already broadcasting/);
  assert.match(room, /Invitation revoked/);
  assert.match(room, /Join the room before using media/);
});

test("deployment preserves the original room migration and adds long-term services", async () => {
  const config = JSON.parse(await read("wrangler.jsonc"));
  assert.deepEqual(config.migrations[0], { tag: "v1", new_sqlite_classes: ["CinemaRoom"] });
  assert.deepEqual(config.migrations[1], {
    tag: "v2",
    new_sqlite_classes: ["CinemaDirectory", "AuthRateLimiter"],
  });
  assert.deepEqual(
    config.durable_objects.bindings.map((binding) => binding.name).sort(),
    ["AUTH_LIMITER", "DIRECTORY", "ROOMS"],
  );
});
