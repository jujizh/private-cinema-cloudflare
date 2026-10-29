// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Private Cinema contributors.
// Open-source snapshot prepared 2026-10-29; see CHANGELOG.md.
import assert from "node:assert/strict";
import test from "node:test";
import { CinemaRoom } from "../src/room.js";

function fakeSocket(meta, messages = []) {
  return {
    deserializeAttachment: () => meta,
    serializeAttachment: () => {},
    send: (message) => messages.push(JSON.parse(message)),
    close: () => {},
  };
}

function fixture() {
  const now = Date.now();
  const room = {
    schema: 4,
    id: "room-test",
    title: "Test",
    createdAt: now,
    expiresAt: now + 60_000,
    cleanupAt: now + 120_000,
    endedAt: null,
    locked: false,
    invites: {},
    bannedClients: {},
    admittedClients: {},
    participantDisconnects: {},
    activeMedia: null,
    pendingMedia: null,
    captions: [],
  };
  const values = new Map([["room", structuredClone(room)]]);
  const messages = [];
  const host = fakeSocket({
    id: "host-id",
    clientId: "host-client",
    role: "host",
    name: "Host",
    joinedAt: now,
    quality: null,
  }, messages);
  const sockets = [host];
  const storage = {
    get: async (key) => values.get(key),
    put: async (key, value) => values.set(key, structuredClone(value)),
    delete: async (key) => values.delete(key),
    setAlarm: async () => {},
  };
  const ctx = {
    storage,
    blockConcurrencyWhile: (callback) => callback(),
    getWebSockets: () => sockets,
    waitUntil: () => {},
  };
  return { cinema: new CinemaRoom(ctx, {}), messages, values };
}

test("subtitle clock budget accepts four updates per second and the final paused seek", async () => {
  const { cinema } = fixture();
  await cinema.ready;
  const host = cinema.ctx.getWebSockets()[0];
  for (let i = 0; i < 40; i++) {
    await cinema.webSocketMessage(host, JSON.stringify({ type: "caption:clock", clock: {
      time: 1000 + i, playing: true, source: "local-player", rate: 1,
    } }));
  }
  await cinema.webSocketMessage(host, JSON.stringify({ type: "caption:clock", clock: {
    time: 1600, playing: false, source: "local-player", rate: 1,
  } }));
  assert.equal(cinema.room.captionClock.time, 1600);
  assert.equal(cinema.room.captionClock.playing, false);
});

test("temporary viewer control loss is held in presence until the grace expires", async () => {
  const { cinema, messages } = fixture();
  await cinema.ready;
  const viewerFixture = fakeSocket({
    id: "viewerFixture-id",
    clientId: "viewerFixture-client",
    role: "viewer",
    name: "Viewer",
    joinedAt: Date.now() - 10_000,
    quality: { state: "good" },
  });

  await cinema.webSocketClose(viewerFixture, 1006, "Network changed");

  assert.ok(cinema.room.participantDisconnects["viewerFixture-client"]);
  assert.equal(messages.some((message) => message.type === "peer:left"), false);
  const presence = messages.findLast((message) => message.type === "room:presence");
  const pendingViewer = presence.participants.find((participant) => participant.id === "viewerFixture-id");
  assert.equal(pendingViewer.reconnecting, true);

  cinema.room.participantDisconnects["viewerFixture-client"].deadline = Date.now() - 1;
  await cinema.alarm();
  assert.equal(messages.some((message) => message.type === "peer:left" && message.peer.id === "viewerFixture-id"), true);
});

test("explicit Leave bypasses the reconnect grace", async () => {
  const { cinema, messages } = fixture();
  await cinema.ready;
  const viewerFixture = fakeSocket({
    id: "viewerFixture-id",
    clientId: "viewerFixture-client",
    role: "viewer",
    name: "Viewer",
    joinedAt: Date.now(),
    quality: null,
  });

  await cinema.webSocketClose(viewerFixture, 1000, "Left room");

  assert.equal(cinema.room.participantDisconnects["viewerFixture-client"], undefined);
  assert.equal(messages.some((message) => message.type === "peer:left" && message.peer.id === "viewerFixture-id"), true);
});
