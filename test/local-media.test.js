// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Private Cinema contributors.
// Open-source snapshot prepared 2026-10-29; see CHANGELOG.md.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { CinemaRoom } from "../src/room.js";
import { normaliseLocalState, localMovieClock, localCaptureDecision, disableEmbeddedTextTracks, formatMovieTime } from "../public/local-media.js";

const state = (overrides = {}, now = 1000) => normaliseLocalState({ type: "player-state", time: 10,
  duration: 120, rate: 1, paused: false, waiting: false, hasFile: true, status: "ready", name: "movie.mp4", ...overrides }, now);

test("local movie clock follows playback speed, pauses, seeks and buffering", () => {
  assert.deepEqual(localMovieClock(state({ rate: 1.5 }), 3000), { time: 13, playing: true, rate: 1.5 });
  for (const overrides of [{ paused: true }, { waiting: true }, { status: "loading" }, { status: "error" }, { status: "closed" }]) {
    const clock = localMovieClock(state(overrides), 3000);
    assert.equal(clock.time, 10);
    assert.equal(clock.playing, false);
  }
  assert.equal(localMovieClock(state({ time: 70, paused: true }), 5000).time, 70);
  assert.equal(localMovieClock(state({ time: 119 }), 5000).time, 120);
});

test("missing player heartbeat freezes clock without rewinding or running indefinitely", () => {
  const initial = state();
  assert.equal(localMovieClock(initial, 11_000).time, 20);
  assert.deepEqual(localMovieClock(initial, 11_001), { time: 20, playing: false, rate: 1 });
  assert.deepEqual(localMovieClock(initial, 99_000), { time: 20, playing: false, rate: 1 });
});

test("player state rejects malformed messages and bounds metadata", () => {
  for (const message of [null, {}, { type: "command", time: 1 }, { type: "player-state", time: NaN }, { type: "player-state", time: -1 }]) assert.equal(normaliseLocalState(message), null);
  assert.equal(state({ rate: Infinity }).rate, 1);
  assert.equal(state({ rate: 8 }).rate, 4);
  assert.equal(state({ name: "\u0000" + "a".repeat(300) }).name.length, 180);
});

test("local subtitle clock attaches only to the verified source or explicit browser tab", () => {
  const origin = "https://cinema.example";
  assert.deepEqual(localCaptureDecision({}, { handle: "player-1", origin }, "player-1", origin), { local: true, verified: true });
  assert.equal(localCaptureDecision({ displaySurface: "browser" }, null, "player-1", origin).local, false);
  assert.ok(localCaptureDecision({ displaySurface: "window" }, null, "player-1", origin, true).error);
  assert.ok(localCaptureDecision({ displaySurface: "monitor" }, null, "player-1", origin, true).error);
  assert.ok(localCaptureDecision({ displaySurface: "browser" }, { handle: "another" }, "player-1", origin, true).error);
  assert.deepEqual(localCaptureDecision({ displaySurface: "browser" }, null, "player-1", origin, true), { local: true, verified: false });
});

test("embedded text tracks are disabled idempotently without editing movie pixels", () => {
  let writes = 0;
  const track = { value: "showing", get mode() { return this.value; }, set mode(value) { this.value = value; writes++; } };
  const other = { mode: "hidden" };
  const video = { textTracks: [track, other] };
  disableEmbeddedTextTracks(video); disableEmbeddedTextTracks(video);
  assert.equal(track.mode, "disabled"); assert.equal(other.mode, "disabled"); assert.equal(writes, 1);
  disableEmbeddedTextTracks({});
});

test("server caption clock supports rate and remains compatible with old clients", () => {
  const cinema = Object.create(CinemaRoom.prototype);
  cinema.room = { captionClock: { time: 20, playing: true, source: "local-player", rate: 2, updatedAt: Date.now() - 2000 } };
  assert.ok(Math.abs(cinema.captionClockState().time - 24) < 0.1);
  assert.equal(cinema.captionClockState().rate, 2);
  cinema.room.captionClock.playing = false;
  assert.equal(cinema.captionClockState().time, 20);
  delete cinema.room.captionClock.rate;
  assert.equal(cinema.captionClockState().rate, 1);
});

test("local player uses a native link before picking files and never sends movie bytes over channel", () => {
  const read = (file) => readFileSync(new URL(`../public/${file}`, import.meta.url), "utf8");
  const html = read("index.html"), app = read("app.js"), player = read("player.js");
  assert.match(html, /<a id="openMovie"[^>]*target="_blank"/);
  assert.doesNotMatch(app, /window\.open\(|launchMovieFile|"movieFile"/);
  assert.match(player, /URL\.createObjectURL\(file\)/);
  assert.doesNotMatch(player, /postMessage\([^;]*(?:\bfile\b|\bobjectUrl\b)\s*[,}]/);
  assert.doesNotMatch(read("player.html"), /captionOverlay|captionSelect/);
  assert.match(app, /!state\.localCaptureChannelId && state\.captionClock\?\.playing/);
});

test("movie time is readable and bounds bad input", () => {
  assert.equal(formatMovieTime(90), "1:30");
  assert.equal(formatMovieTime(3661), "1:01:01");
  assert.equal(formatMovieTime(-2), "0:00");
});
