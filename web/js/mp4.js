// An MP4 file of one H.264 video track, from encoded frames: what web/js/recorder.js saves. The index (moov) comes
// before the frames (mdat), so the file plays as it downloads.
//
//   mp4({ width, height, description, frames: [{ data, timestamp, key }] }) -> Uint8Array
//
// description is the encoder's AVC decoder configuration (avcC, a Uint8Array); each frame's data is in AVC format,
// NAL units with length prefixes, and its timestamp in microseconds. Frames come in display order, which a realtime
// encoder keeps.

const TIMESCALE = 90000; // ticks a second, as video tracks commonly use

export function mp4({ width, height, description, frames }) {
  if (frames.length === 0) throw new Error('No frames to save');
  // An encoder that reordered frames, or wrote start codes instead of lengths, would need more than this writes.
  const lengthSize = (description[4] & 3) + 1;
  frames.forEach((frame, i) => {
    if (i > 0 && frame.timestamp <= frames[i - 1].timestamp) throw new Error('The encoder reordered the frames');
    if (!lengthPrefixed(new Uint8Array(frame.data), lengthSize)) throw new Error('The encoder wrote no AVC lengths');
  });
  const start = frames[0].timestamp;
  const ticks = frames.map((frame) => Math.round(((frame.timestamp - start) * TIMESCALE) / 1e6));
  // Each frame lasts until the next; the last, as long as the one before it.
  const durations = ticks.map((tick, i) => (i + 1 < ticks.length ? Math.max(1, ticks[i + 1] - tick) : null));
  durations[durations.length - 1] = durations.length > 1 ? durations[durations.length - 2] : TIMESCALE / 30;
  const duration = durations.reduce((sum, value) => sum + value, 0);
  const sizes = frames.map((frame) => frame.data.byteLength);

  const ftyp = box('ftyp', ascii('isom'), u32(0x200), ascii('isom'), ascii('iso2'), ascii('avc1'), ascii('mp41'));
  // The frames' offset depends on the index's size, which doesn't depend on the offset: build it twice.
  const moovAt = (offset) => moov({ width, height, description, durations, duration, sizes, frames, offset });
  const offset = ftyp.length + moovAt(0).length + 8;
  const index = moovAt(offset);
  const mdatSize = 8 + sizes.reduce((sum, value) => sum + value, 0);
  const out = new Uint8Array(ftyp.length + index.length + mdatSize);
  let at = 0;
  for (const part of [ftyp, index, u32(mdatSize), ascii('mdat')]) {
    out.set(part, at);
    at += part.length;
  }
  for (const frame of frames) {
    out.set(new Uint8Array(frame.data), at);
    at += frame.data.byteLength;
  }
  return out;
}

function moov({ width, height, description, durations, duration, sizes, frames, offset }) {
  const movieDuration = Math.round((duration * 1000) / TIMESCALE);
  const matrix = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000].map(u32);
  const mvhd = full('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(movieDuration), u32(0x10000), u16(0x100), zeros(10),
    ...matrix, zeros(24), u32(2)); // prettier-ignore
  const tkhd = full('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(movieDuration), zeros(8), u16(0), u16(0), u16(0),
    u16(0), ...matrix, u32(width * 0x10000), u32(height * 0x10000)); // prettier-ignore
  const mdhd = full('mdhd', 0, 0, u32(0), u32(0), u32(TIMESCALE), u32(duration), u16(0x55c4), u16(0)); // und
  const hdlr = full('hdlr', 0, 0, u32(0), ascii('vide'), zeros(12), ascii('VideoHandler\0'));
  const avc1 = box('avc1', zeros(6), u16(1), zeros(16), u16(width), u16(height), u32(0x480000), u32(0x480000), u32(0),
    u16(1), zeros(32), u16(0x18), u16(0xffff), box('avcC', description)); // prettier-ignore
  const stsd = full('stsd', 0, 0, u32(1), avc1);
  // Runs of frames of the same length.
  const runs = [];
  for (const value of durations) {
    if (runs.length > 0 && runs[runs.length - 1][1] === value) runs[runs.length - 1][0] += 1;
    else runs.push([1, value]);
  }
  const stts = full('stts', 0, 0, u32(runs.length), ...runs.flatMap(([count, value]) => [u32(count), u32(value)]));
  const keys = frames.flatMap((frame, i) => (frame.key ? [i + 1] : []));
  const stss = full('stss', 0, 0, u32(keys.length), ...keys.map(u32));
  const stsc = full('stsc', 0, 0, u32(1), u32(1), u32(frames.length), u32(1)); // one chunk of every frame
  const stsz = full('stsz', 0, 0, u32(0), u32(sizes.length), ...sizes.map(u32));
  const stco = full('stco', 0, 0, u32(1), u32(offset));
  const stbl = box('stbl', stsd, stts, stss, stsc, stsz, stco);
  const dinf = box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1)));
  const minf = box('minf', full('vmhd', 0, 1, zeros(8)), dinf, stbl);
  return box('moov', mvhd, box('trak', tkhd, box('mdia', mdhd, hdlr, minf)));
}

// Whether data is NAL units, each after its length in lengthSize bytes, that fill it exactly.
function lengthPrefixed(data, lengthSize) {
  let at = 0;
  while (at < data.length) {
    let length = 0;
    for (let i = 0; i < lengthSize; i += 1) length = length * 256 + (data[at + i] ?? 0);
    if (length === 0) return false;
    at += lengthSize + length;
  }
  return at === data.length && data.length > 0;
}

function box(type, ...parts) {
  const size = 8 + parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  out.set(u32(size), 0);
  out.set(ascii(type), 4);
  let at = 8;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// A box with a version and flags.
function full(type, version, flags, ...parts) {
  return box(type, new Uint8Array([version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]), ...parts);
}

function u32(value) {
  return new Uint8Array([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]);
}

function u16(value) {
  return new Uint8Array([(value >> 8) & 255, value & 255]);
}

function zeros(count) {
  return new Uint8Array(count);
}

function ascii(text) {
  return new Uint8Array([...text].map((character) => character.charCodeAt(0)));
}
