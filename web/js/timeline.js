// Where each plate is in a frame of a video, from the reads around it. A video is shown a little behind its reads, so
// that most frames lie between two of them: a plate is placed between the read before the frame and the next read that
// found it, along a curve through the reads before and after those too, so that its outline follows it as it moves,
// speeds up, and grows. A frame with no read after it yet has its plates moved on from the read before, at their
// velocities.

// How far past the read that last found it a plate is carried, when no read after it has found it yet.
export const COAST_MS = 250;

// reads: [{ time, tracks }] in time order, with the tracks each read found (visible ones). Returns the tracks in the
// frame at `time`, each with its box there, in the order of their ids.
export function platesAt(reads, time) {
  const plates = [];
  const placed = new Set();
  let last = -1;
  for (let i = 0; i < reads.length && reads[i].time <= time; i++) last = i;
  // Each plate from the latest read at or before the frame that found it.
  for (let i = last; i >= 0 && time - reads[i].time <= 2 * COAST_MS; i--) {
    for (const track of reads[i].tracks) {
      if (placed.has(track.id)) continue;
      placed.add(track.id);
      const plate = place(reads, i, track, time);
      if (plate) plates.push(plate);
    }
  }
  return plates.sort((a, b) => a.id - b.id);
}

function place(reads, index, track, time) {
  const read = reads[index];
  const elapsed = time - read.time;
  // The next read that found it, past any that missed it.
  const next = sighting(reads, index, track.id, 1);
  if (next) {
    const share = elapsed / (next.time - read.time);
    const box = curve(sighting(reads, index, track.id, -1), { time: read.time, track }, next, sighting(reads, next.index, track.id, 1), time);
    return { ...(share < 0.5 ? track : next.track), box };
  }
  // Not found again: carried on, but only so far, and no further than halfway to a read that missed it. A plate seen
  // once may be a false detection, and has no velocity yet.
  const later = reads[index + 1];
  const limit = later ? (later.time - read.time) / 2 : COAST_MS;
  if (track.seen <= 1 || elapsed > limit) return null;
  const [dx, dy] = (track.velocity ?? [0, 0]).map((speed) => speed * elapsed);
  const [x1, y1, x2, y2] = track.box;
  return { ...track, box: [x1 + dx, y1 + dy, x2 + dx, y2 + dy] };
}

// The nearest read before (step -1) or after (step 1) reads[index] that found the track, within reach of it.
function sighting(reads, index, id, step) {
  for (let j = index + step; j >= 0 && j < reads.length; j += step) {
    if (Math.abs(reads[j].time - reads[index].time) > 2 * COAST_MS) break;
    const track = reads[j].tracks.find((other) => other.id === id);
    if (track) return { index: j, time: reads[j].time, track };
  }
  return null;
}

// The box at `time`, between the sightings `from` and `to`, on a Catmull-Rom curve: each end's slope comes from the
// sightings on either side of it, or, without one, from the line between the two.
function curve(before, from, to, after, time) {
  const span = to.time - from.time;
  const s = (time - from.time) / span;
  const h00 = 2 * s ** 3 - 3 * s ** 2 + 1;
  const h10 = s ** 3 - 2 * s ** 2 + s;
  const h01 = -2 * s ** 3 + 3 * s ** 2;
  const h11 = s ** 3 - s ** 2;
  return from.track.box.map((start, i) => {
    const end = to.track.box[i];
    const line = (end - start) / span;
    const slopeFrom = before ? (end - before.track.box[i]) / (to.time - before.time) : line;
    const slopeTo = after ? (after.track.box[i] - start) / (after.time - from.time) : line;
    return h00 * start + h10 * span * slopeFrom + h01 * end + h11 * span * slopeTo;
  });
}
