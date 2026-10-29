// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Private Cinema contributors.
// Open-source snapshot prepared 2026-10-29; see CHANGELOG.md.
// Read container metadata only: no decoding, transcoding, upload or full-file copy.
// Matroska IDs follow https://www.matroska.org/technical/elements.html.
const IDS = { ebml: 0x1a45dfa3, segment: 0x18538067, seekHead: 0x114d9b74,
  seek: 0x4dbb, seekId: 0x53ab, seekPosition: 0x53ac, tracks: 0x1654ae6b,
  entry: 0xae, type: 0x83, codec: 0x86, language: 0x22b59c, languageIetf: 0x22b59d,
  enabled: 0xb9, default: 0x88, audio: 0xe1, channels: 0x9f };
const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_ELEMENTS = 1024;
const clean = (text) => String(text || "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 120);

function vint(bytes, start, isId = false) {
  const first = bytes[start];
  if (!first) throw new Error("Invalid EBML integer");
  let length = 1, marker = 0x80;
  while (!(first & marker)) { marker /= 2; length++; }
  if (length > (isId ? 4 : 8) || start + length > bytes.length) throw new Error("Truncated EBML integer");
  let value = isId ? first : first & (marker - 1);
  let unknown = !isId && value === marker - 1;
  for (let i = 1; i < length; i++) { value = value * 256 + bytes[start + i]; unknown &&= bytes[start + i] === 255; }
  if (!unknown && !Number.isSafeInteger(value)) throw new Error("EBML integer too large");
  return { value: unknown ? null : value, length };
}

class Reader {
  constructor(file, signal) { this.file = file; this.signal = signal; this.bytesRead = 0; this.elements = 0; this.cachedAt = 0; this.cache = new Uint8Array(); }
  async read(position, length) {
    if (this.signal?.aborted) throw new Error("Inspection cancelled");
    if (!Number.isSafeInteger(position) || position < 0 || length < 0 || position + length > this.file.size) throw new Error("Metadata outside file");
    if (position < this.cachedAt || position + length > this.cachedAt + this.cache.length) {
      const size = Math.min(Math.max(64 * 1024, length), this.file.size - position);
      if (this.bytesRead + size > MAX_READ_BYTES) throw new Error("Metadata read limit");
      this.cache = new Uint8Array(await this.file.slice(position, position + size).arrayBuffer());
      this.cachedAt = position; this.bytesRead += this.cache.length;
      if (this.cache.length < length) throw new Error("Truncated file read");
    }
    return this.cache.subarray(position - this.cachedAt, position - this.cachedAt + length);
  }
  async header(position, limit = this.file.size) {
    if (++this.elements > MAX_ELEMENTS) throw new Error("Metadata element limit");
    const bytes = await this.read(position, Math.min(12, limit - position));
    const id = vint(bytes, 0, true), size = vint(bytes, id.length);
    const data = position + id.length + size.length;
    const end = size.value === null ? null : data + size.value;
    if (data > limit || (end !== null && (!Number.isSafeInteger(end) || end > limit || end < data))) throw new Error("Invalid element length");
    return { id: id.value, data, end, size: size.value };
  }
  async uint(item) {
    if (item.size === null || item.size < 1 || item.size > 8) throw new Error("Invalid metadata number");
    let value = 0; for (const byte of await this.read(item.data, item.size)) value = value * 256 + byte;
    if (!Number.isSafeInteger(value)) throw new Error("Metadata number too large");
    return value;
  }
  async text(item) {
    if (item.size === null || item.size > 256) throw new Error("Metadata text too large");
    return clean(new TextDecoder().decode(await this.read(item.data, item.size)));
  }
  async children(item, callback) {
    if (item.end === null) throw new Error("Unbounded metadata element");
    for (let at = item.data; at < item.end;) {
      const child = await this.header(at, item.end);
      if (child.end === null || child.end <= at) throw new Error("Invalid child element");
      await callback(child); at = child.end;
    }
  }
}

async function readTracks(reader, item) {
  const tracks = [];
  await reader.children(item, async (entry) => {
    if (entry.id !== IDS.entry) return;
    const track = { codec: "", language: "und", channels: 0, enabled: true, default: true };
    await reader.children(entry, async (field) => {
      if (field.id === IDS.type) track.type = await reader.uint(field);
      if (field.id === IDS.codec) track.codec = await reader.text(field);
      if (field.id === IDS.language || field.id === IDS.languageIetf) track.language = await reader.text(field);
      if (field.id === IDS.enabled) track.enabled = Boolean(await reader.uint(field));
      if (field.id === IDS.default) track.default = Boolean(await reader.uint(field));
      if (field.id === IDS.audio) await reader.children(field, async (part) => {
        if (part.id === IDS.channels) track.channels = await reader.uint(part);
      });
    });
    if (!Number.isFinite(track.type)) throw new Error("Missing track type");
    if (track.type === 2) {
      if (tracks.length >= 32) throw new Error("Too many audio tracks");
      tracks.push(track);
    }
  });
  return tracks;
}

export async function inspectAudioFile(file, { signal } = {}) {
  const reader = new Reader(file, signal);
  try {
    if (file.size < 4 || (await reader.read(0, 4)).some((byte, i) => byte !== [0x1a, 0x45, 0xdf, 0xa3][i])) {
      return { status: "unknown", container: "other", tracks: [], bytesRead: reader.bytesRead };
    }
    const ebml = await reader.header(0);
    if (ebml.id !== IDS.ebml || ebml.end === null) throw new Error("Missing EBML header");
    let segment = null, at = ebml.end;
    for (let count = 0; count < 16 && at < file.size; count++) {
      const item = await reader.header(at);
      if (item.id === IDS.segment) { segment = item; break; }
      if (item.end === null) break;
      at = item.end;
    }
    if (!segment) throw new Error("Missing Segment");
    const segmentEnd = segment.end ?? file.size;
    at = segment.data;
    let target = null;
    for (let count = 0; count < 128 && at < segmentEnd; count++) {
      const item = await reader.header(at, segmentEnd);
      if (item.id === IDS.tracks) return { status: "inspected", container: "matroska", tracks: await readTracks(reader, item), bytesRead: reader.bytesRead };
      if (item.id === IDS.seekHead) await reader.children(item, async (entry) => {
        if (entry.id !== IDS.seek) return;
        let id = 0, position = null;
        await reader.children(entry, async (field) => {
          if (field.id === IDS.seekId) id = await reader.uint(field);
          if (field.id === IDS.seekPosition) position = await reader.uint(field);
        });
        if (id === IDS.tracks && position !== null) target = segment.data + position;
      });
      if (target !== null) {
        const tracks = await reader.header(target, segmentEnd);
        if (tracks.id !== IDS.tracks) throw new Error("Incorrect track seek position");
        return { status: "inspected", container: "matroska", tracks: await readTracks(reader, tracks), bytesRead: reader.bytesRead };
      }
      if (item.end === null) break;
      at = item.end;
    }
    throw new Error("Tracks not found within safe inspection limits");
  } catch {
    return { status: "unknown", container: "matroska", tracks: [], bytesRead: reader.bytesRead };
  }
}

export function codecLabel(codec) {
  if (/^A_DTS(?:\/|$)/.test(codec)) return "DTS / DTS-HD";
  if (/^A_AAC(?:\/|$)/.test(codec)) return "AAC";
  return ({ A_AC3: "AC-3", A_EAC3: "E-AC-3", A_TRUEHD: "TrueHD", A_MLP: "MLP",
    A_OPUS: "Opus", A_VORBIS: "Vorbis", A_FLAC: "FLAC", "A_MPEG/L3": "MP3" })[codec] || clean(codec) || "未知编码";
}

export function audioAdvice(inspection, video = {}) {
  const decoded = Number(video.webkitAudioDecodedByteCount) > 0 || video.mozHasAudio === true || Number(video.audioTracks?.length) > 0;
  const tracks = inspection?.status === "inspected" ? inspection.tracks.filter((track) => track.enabled) : [];
  const codecs = [...new Set(tracks.map((track) => codecLabel(track.codec)))].join("、");
  if (decoded) return { status: "decoded", warning: false, summary: `浏览器已识别音频${codecs ? `：${codecs}` : ""}。若仍无声，请检查播放器、网站和系统音量。` };
  if (inspection?.status === "pending") return { status: "pending", warning: false, summary: "正在读取音轨信息，仅检查少量本地元数据，不上传电影。" };
  if (inspection?.status !== "inspected") return { status: "unknown", warning: false, summary: "暂无法可靠识别音频编码，不代表文件没有声音。若源标签页无声，请在本地查看音轨编码。" };
  if (!tracks.length) return { status: "absent", warning: true, summary: "未发现启用的独立音轨。请在本地检查片源；转换音频不能凭空生成原本不存在的声音。" };
  const primary = tracks.find((track) => track.default) || tracks[0];
  const risky = /^A_(DTS|AC3|EAC3|TRUEHD|MLP)(?:\/|$)/.test(primary.codec);
  if (risky) return { status: "risk", warning: true, summary: `检测到${codecLabel(primary.codec)}音轨${primary.channels ? `（${primary.channels}声道）` : ""}，当前浏览器可能只能播放画面。源标签页无声时，请在本地将音频转换为 AAC；兼容的视频无需重压。${tracks.length > 1 ? `文件包含音轨：${codecs}。` : ""}` };
  return { status: "identified", warning: false, summary: `检测到音轨：${codecs}。编码名称不等于已成功解码；请在共享前确认源标签页有声音。` };
}
