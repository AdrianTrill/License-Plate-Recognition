// Tests for the MP4 a saved video is written into, from frames as an H.264 encoder gives them:
//
//   node --test web/mp4.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mp4 } from './js/mp4.js';

// An avcC with 4-byte lengths, as encoders write it: version, profile, compatibility, level, lengths, no parameter sets.
const description = new Uint8Array([1, 0x64, 0, 0x28, 0xff, 0xe0, 0]);
// A frame of NAL units, each after its 4-byte length.
const frame = (timestamp, key, ...units) => {
  const parts = units.map((size, i) => [0, 0, 0, size, ...new Array(size).fill(i + 1)]);
  return { data: new Uint8Array(parts.flat()).buffer, timestamp, key };
};

// The boxes in data from at to end, by type, each with where its contents start and end.
function boxes(data, at = 0, end = data.length) {
  const view = new DataView(data.buffer, data.byteOffset);
  const found = [];
  while (at < end) {
    const size = view.getUint32(at);
    found.push({ type: String.fromCharCode(...data.subarray(at + 4, at + 8)), start: at + 8, end: at + size });
    at += size;
  }
  return found;
}
const child = (data, parent, path) =>
  path.reduce((box, type) => boxes(data, box.start, box.end).find((next) => next.type === type), parent);
const u32 = (data, at) => new DataView(data.buffer, data.byteOffset).getUint32(at);

const frames = [frame(1_000_000, true, 5, 3), frame(1_033_367, false, 4), frame(1_066_733, false, 6), frame(1_100_100, false, 2)];
const file = mp4({ width: 1280, height: 720, description, frames });
const top = boxes(file);
const moov = top.find((box) => box.type === 'moov');
const stbl = child(file, moov, ['trak', 'mdia', 'minf', 'stbl']);
const table = (type) => child(file, stbl, [type]);

test('a file type, then the index, then the frames, which fill the file', () => {
  assert.deepEqual(
    top.map((box) => box.type),
    ['ftyp', 'moov', 'mdat'],
  );
  assert.equal(top.at(-1).end, file.length);
});

test('the frames are where the index says, in order, with their sizes', () => {
  const mdat = top.find((box) => box.type === 'mdat');
  const stco = table('stco');
  assert.equal(u32(file, stco.start + 4), 1);
  assert.equal(u32(file, stco.start + 8), mdat.start);
  const stsz = table('stsz');
  const sizes = frames.map((_, i) => u32(file, stsz.start + 12 + 4 * i));
  assert.deepEqual(
    sizes,
    frames.map((entry) => entry.data.byteLength),
  );
  let at = mdat.start;
  for (const entry of frames) {
    assert.deepEqual(file.subarray(at, at + entry.data.byteLength), new Uint8Array(entry.data));
    at += entry.data.byteLength;
  }
});

test('frames last until the next, on a 90 kHz clock from the first, and the last as long as the one before', () => {
  const stts = table('stts');
  const runs = [];
  for (let i = 0; i < u32(file, stts.start + 4); i += 1) {
    runs.push([u32(file, stts.start + 8 + 8 * i), u32(file, stts.start + 12 + 8 * i)]);
  }
  const durations = runs.flatMap(([count, value]) => new Array(count).fill(value));
  assert.deepEqual(durations, [3003, 3003, 3003, 3003]);
  const mdhd = child(file, moov, ['trak', 'mdia', 'mdhd']);
  assert.equal(u32(file, mdhd.start + 12), 90000);
  assert.equal(u32(file, mdhd.start + 16), 4 * 3003);
});

test('only the key frames are sync samples', () => {
  const stss = table('stss');
  assert.equal(u32(file, stss.start + 4), 1);
  assert.equal(u32(file, stss.start + 8), 1);
});

test("the sample entry has the video's size and the encoder's configuration", () => {
  const stsd = table('stsd');
  const avc1 = boxes(file, stsd.start + 8, stsd.end)[0];
  assert.equal(avc1.type, 'avc1');
  const view = new DataView(file.buffer);
  assert.equal(view.getUint16(avc1.start + 24), 1280);
  assert.equal(view.getUint16(avc1.start + 26), 720);
  const avcC = boxes(file, avc1.start + 78, avc1.end)[0];
  assert.equal(avcC.type, 'avcC');
  assert.deepEqual(file.subarray(avcC.start, avcC.end), description);
});

test('frames out of order, or with start codes instead of lengths, are refused', () => {
  assert.throws(() => mp4({ width: 64, height: 64, description, frames: [frames[1], frames[0]] }), /reordered/);
  const annexB = { data: new Uint8Array([0, 0, 0, 1, 0x65, 9, 9, 9, 9, 9, 9]).buffer, timestamp: 0, key: true };
  assert.throws(() => mp4({ width: 64, height: 64, description, frames: [annexB] }), /lengths/);
  assert.throws(() => mp4({ width: 64, height: 64, description, frames: [] }), /No frames/);
});
