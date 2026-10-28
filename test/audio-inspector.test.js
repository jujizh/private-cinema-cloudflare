import test from "node:test";
import assert from "node:assert/strict";
import { inspectAudioFile, audioAdvice, codecLabel } from "../public/audio-inspector.js";

const id = (hex) => Buffer.from(hex, "hex");
function size(value) {
  for (let length = 1; length <= 8; length++) {
    if (BigInt(value) < (1n << BigInt(7 * length)) - 1n) {
      let number = BigInt(value) | (1n << BigInt(7 * length));
      const bytes = Buffer.alloc(length);
      for (let i = length - 1; i >= 0; i--) { bytes[i] = Number(number & 255n); number >>= 8n; }
      return bytes;
    }
  }
  throw new Error("Too large");
}
const element = (hex, content = Buffer.alloc(0)) => Buffer.concat([id(hex), size(content.length), content]);
const uint = (value) => { let text = value.toString(16); return id(text.length % 2 ? `0${text}` : text); };
const field = (hex, value) => element(hex, typeof value === "number" ? uint(value) : Buffer.from(value));
const track = (codec, options = {}) => element("ae", Buffer.concat([
  field("83", options.type || 2), field("86", codec), field("22b59c", "eng"),
  field("b9", options.enabled ?? 1), field("88", options.default ?? 1),
  element("e1", field("9f", options.channels || 6)),
]));
const fixture = (...tracks) => new Blob([element("1a45dfa3"), element("18538067", element("1654ae6b", Buffer.concat(tracks)))]);

test("reads DTS from Matroska metadata, not the filename", async () => {
  const file = fixture(track("A_DTS")); file.name = "misleading-AAC.mp4";
  const result = await inspectAudioFile(file);
  assert.equal(result.status, "inspected");
  assert.equal(result.tracks[0].codec, "A_DTS");
  assert.equal(result.tracks[0].channels, 6);
  const advice = audioAdvice(result);
  assert.equal(advice.warning, true); assert.match(advice.summary, /DTS.*AAC/);
});

test("AAC and Opus do not get an unsupported or missing-audio diagnosis", async () => {
  for (const codec of ["A_AAC", "A_AAC/MPEG4/LC", "A_OPUS", "A_FLAC"]) {
    const result = await inspectAudioFile(fixture(track(codec)));
    assert.equal(audioAdvice(result).warning, false);
    assert.equal(audioAdvice(result).status, "identified");
  }
});

test("TrueHD and AC-3 family get a compatibility risk, not an absolute decode failure", async () => {
  for (const codec of ["A_TRUEHD", "A_AC3", "A_EAC3"]) {
    const result = await inspectAudioFile(fixture(track(codec)));
    assert.equal(audioAdvice(result).status, "risk");
    assert.match(audioAdvice(result).summary, /可能/);
  }
});

test("a real decoded audio signal overrides the codec compatibility warning", async () => {
  const result = await inspectAudioFile(fixture(track("A_DTS")));
  const advice = audioAdvice(result, { webkitAudioDecodedByteCount: 3000 });
  assert.equal(advice.warning, false); assert.equal(advice.status, "decoded");
});

test("multiple tracks respect enabled and default flags without claiming all are unsupported", async () => {
  const result = await inspectAudioFile(fixture(track("A_DTS", { default: 0 }), track("A_AAC", { default: 1 })));
  assert.equal(result.tracks.length, 2); assert.equal(audioAdvice(result).warning, false);
  const disabled = await inspectAudioFile(fixture(track("A_DTS", { enabled: 0 })));
  assert.equal(audioAdvice(disabled).status, "absent");
});

test("no audio is reported only after a complete valid Tracks element", async () => {
  const result = await inspectAudioFile(fixture(track("V_MPEG4/ISO/AVC", { type: 1 })));
  assert.equal(audioAdvice(result).status, "absent");
  for (const bytes of [Buffer.from("not media"), id("1a45dfa3ff"), id("1a45dfa38018538067ff1654ae6bff"), Buffer.alloc(0)]) {
    const incomplete = await inspectAudioFile(new Blob([bytes]));
    assert.equal(incomplete.status, "unknown");
    assert.equal(audioAdvice(incomplete).warning, false);
    assert.equal(audioAdvice(incomplete).status, "unknown");
  }
});

test("SeekHead can locate Tracks beyond 4 GiB without reading the movie body", async () => {
  const position = 5 * 1024 ** 3 + 7;
  const ebml = element("1a45dfa3");
  const segment = Buffer.concat([id("18538067"), id("ff")]);
  const start = ebml.length + segment.length;
  const seek = element("114d9b74", element("4dbb", Buffer.concat([
    element("53ab", id("1654ae6b")), field("53ac", position),
  ])));
  const header = Buffer.concat([ebml, segment, seek]);
  const tracks = element("1654ae6b", track("A_DTS"));
  const blocks = [[0, header], [start + position, tracks]];
  const readCalls = [];
  const fakeLargeFile = { size: start + position + tracks.length, slice(from, to) {
    readCalls.push([from, to]);
    return { async arrayBuffer() {
      const bytes = new Uint8Array(to - from);
      for (const [offset, block] of blocks) {
        const left = Math.max(offset, from), right = Math.min(offset + block.length, to);
        if (right > left) bytes.set(block.subarray(left - offset, right - offset), left - from);
      }
      return bytes.buffer;
    } };
  } };
  const result = await inspectAudioFile(fakeLargeFile);
  assert.equal(result.status, "inspected"); assert.equal(result.tracks[0].codec, "A_DTS");
  assert.ok(result.bytesRead < 128 * 1024); assert.ok(readCalls.length <= 2);
});

test("unknown Segment length is supported and aborted inspection stays bounded", async () => {
  const source = new Blob([element("1a45dfa3"), id("18538067ff"), element("1654ae6b", track("A_OPUS"))]);
  assert.equal((await inspectAudioFile(source)).status, "inspected");
  const controller = new AbortController(); controller.abort();
  const result = await inspectAudioFile(source, { signal: controller.signal });
  assert.equal(result.status, "unknown"); assert.equal(result.bytesRead, 0);
});

test("codec text remains inert, bounded text", () => {
  assert.equal(codecLabel("A_DTS"), "DTS / DTS-HD");
  assert.ok(codecLabel("x".repeat(1000)).length <= 120);
  assert.equal(codecLabel("\u0000A_OPUS"), "A_OPUS");
});
