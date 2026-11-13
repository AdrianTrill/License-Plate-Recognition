// Tests for where the page draws a video's plates, between the reads around each frame:
//
//   node --test web/timeline.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COAST_MS, platesAt } from './js/timeline.js';

const track = (id, box, extra = {}) => ({
  id,
  box,
  text: 'AB123',
  confidence: 0.99,
  seen: 3,
  reported: true,
  velocity: [0, 0],
  ...extra,
});

test('before the first read, no plates', () => {
  assert.deepEqual(platesAt([], 50), []);
  assert.deepEqual(platesAt([{ time: 100, tracks: [track(1, [0, 0, 10, 10])] }], 50), []);
});

test('between two reads, a plate is placed in proportion, moving and growing', () => {
  const reads = [
    { time: 0, tracks: [track(1, [0, 0, 100, 20])] },
    { time: 100, tracks: [track(1, [200, 100, 400, 140])] },
  ];
  assert.deepEqual(platesAt(reads, 0)[0].box, [0, 0, 100, 20]);
  assert.deepEqual(platesAt(reads, 25)[0].box, [50, 25, 175, 50]);
  assert.deepEqual(platesAt(reads, 100)[0].box, [200, 100, 400, 140]);
});

test('a plate speeding up is followed along a curve through the reads around it', () => {
  // x = t² / 100: halfway between the reads at 100 and 200 ms, at 150 ms, it is at 225, not at the line's 250.
  const at = (t) => track(1, [t ** 2 / 100, 0, t ** 2 / 100 + 50, 20]);
  const reads = [0, 100, 200, 300].map((time) => ({ time, tracks: [at(time)] }));
  const [x1] = platesAt(reads, 150)[0].box;
  assert.ok(Math.abs(x1 - 225) < 1e-9, `x1 = ${x1}`);
});

test('the reading shown is that of the nearer read', () => {
  const reads = [
    { time: 0, tracks: [track(1, [0, 0, 100, 20], { text: 'EP724', reported: false })] },
    { time: 100, tracks: [track(1, [100, 0, 200, 20], { text: 'EP7242' })] },
  ];
  assert.equal(platesAt(reads, 40)[0].text, 'EP724');
  assert.equal(platesAt(reads, 40)[0].reported, false);
  assert.equal(platesAt(reads, 60)[0].text, 'EP7242');
});

test('a read that missed a plate is bridged by the next one that found it', () => {
  const reads = [
    { time: 0, tracks: [track(1, [0, 0, 100, 20])] },
    { time: 100, tracks: [] },
    { time: 200, tracks: [track(1, [200, 0, 300, 20])] },
  ];
  assert.deepEqual(platesAt(reads, 150)[0].box, [150, 0, 250, 20]);
});

test('with no read after the frame yet, a plate moves on at its velocity, for a while', () => {
  const reads = [{ time: 0, tracks: [track(1, [0, 0, 100, 20], { velocity: [2, 0.5] })] }];
  assert.deepEqual(platesAt(reads, 40)[0].box, [80, 20, 180, 40]);
  assert.equal(platesAt(reads, COAST_MS + 1).length, 0);
});

test('a plate no later read found is gone halfway to the read that missed it', () => {
  const reads = [
    { time: 0, tracks: [track(1, [0, 0, 100, 20])] },
    { time: 100, tracks: [] },
  ];
  assert.equal(platesAt(reads, 50).length, 1);
  assert.equal(platesAt(reads, 51).length, 0);
});

test('plates come in the order of their ids, whichever read last found them', () => {
  const reads = [
    { time: 0, tracks: [track(2, [0, 0, 10, 10]), track(1, [50, 0, 60, 10])] },
    { time: 100, tracks: [track(2, [0, 0, 10, 10])] },
    { time: 200, tracks: [track(1, [50, 0, 60, 10]), track(2, [0, 0, 10, 10])] },
  ];
  assert.deepEqual(
    platesAt(reads, 150).map((plate) => plate.id),
    [1, 2],
  );
});

test('a plate seen once, and not again, is not drawn', () => {
  const reads = [{ time: 0, tracks: [track(1, [0, 0, 100, 20], { seen: 1 })] }];
  assert.equal(platesAt(reads, 10).length, 0);
});
