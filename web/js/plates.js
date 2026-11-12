// The sidebar: the plates found, what the reader saw for one of them, and where the time went.

import { $, clock, element, icon, milliseconds, percent, sureness } from './format.js';

// A license plate drawn in HTML: a band with the region's code, then the characters, each underlined by how sure the
// reader is of it.
export function plateChip(plate) {
  const chars = element('span', { class: 'plate-chars' });
  if (plate.text) {
    for (const character of plate.characters) {
      chars.append(
        element('span', {
          'data-sure': sureness(character.confidence),
          title: describeCharacter(character),
          text: character.char,
        }),
      );
    }
  } else {
    chars.append(element('span', { class: 'plate-unread', text: 'unreadable' }));
  }
  const band = plate.region?.code ? element('span', { class: 'plate-band', text: plate.region.code }) : null;
  return element('span', { class: 'plate-chip', 'aria-label': plate.text || 'unreadable plate' }, band, chars);
}

function describeCharacter(character) {
  const others = character.alternatives
    .filter(([, probability]) => probability >= 0.005)
    .map(([symbol, probability]) => `${symbol === '_' ? 'nothing' : symbol} ${percent(probability)}`);
  return `${character.char}: ${percent(character.confidence)}${others.length ? `; then ${others.join(', ')}` : ''}`;
}

function thumbnail(bitmap, crop) {
  const canvas = element('canvas', { width: 192, height: 96 });
  if (bitmap && crop) {
    const [x, y, w, h] = crop;
    const context = canvas.getContext('2d');
    // Keep the plate's proportions, padded with a little of the scene around it.
    const scale = Math.min(192 / w, 96 / h) * 0.86;
    const sw = 192 / scale;
    const sh = 96 / scale;
    context.fillStyle = '#000';
    context.fillRect(0, 0, 192, 96);
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, x + w / 2 - sw / 2, y + h / 2 - sh / 2, sw, sh, 0, 0, 192, 96);
  }
  return canvas;
}

// The plates in a photo, most confident detection first.
export function renderPlates(list, plates, { bitmap, labels, selected, onSelect, onHover }) {
  list.replaceChildren(
    ...plates.map((plate, index) => {
      const sure = plate.text ? sureness(plate.confidence) : 'low';
      const card = element(
        'li',
        {
          class: 'plate-card',
          role: 'option',
          tabindex: 0,
          'aria-selected': String(index === selected),
          style: { animationDelay: `${index * 50}ms` },
          onclick: () => onSelect(index),
          onkeydown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onSelect(index);
            }
          },
          onpointerenter: () => onHover(index),
          onpointerleave: () => onHover(-1),
        },
        element('div', { class: 'plate-crop' }, thumbnail(bitmap, plate.crop)),
        element(
          'div',
          { class: 'plate-body' },
          element(
            'div',
            { class: 'plate-line' },
            plateChip(plate),
            element('span', {
              class: 'confidence',
              'data-sure': sure,
              title: 'The reader’s probability for exactly this text',
              text: plate.text ? percent(plate.confidence) : '—',
            }),
          ),
          element(
            'div',
            { class: 'plate-meta' },
            plate.region
              ? element('span', {}, element('b', { text: plate.region.name }), ` ${percent(plate.region.confidence, 0)}`)
              : null,
            element('span', { text: `plate ${percent(plate.score, 0)}`, title: 'The detector’s confidence' }),
          ),
          labels ? truth(plate, labels) : null,
        ),
      );
      return card;
    }),
  );
}

function truth(plate, labels) {
  const match = labels.includes(plate.text);
  return element(
    'span',
    { class: 'truth', 'data-match': String(match) },
    icon(match ? 'check' : 'cross'),
    match ? 'matches the label' : 'not a labeled plate',
  );
}

// What the reader saw: its 128x64 input, and its likeliest symbols for each slot.
export function renderInspector(plate, input) {
  const panel = $('#inspector');
  if (!plate) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  $('#inspector-note').textContent = plate.text ? `${plate.text} · ${percent(plate.confidence)}` : 'unreadable';
  const canvas = $('#network-input');
  const context = canvas.getContext('2d');
  if (input) {
    const rgba = new ImageData(128, 64);
    for (let i = 0, j = 0; i < input.length; i += 3, j += 4) {
      rgba.data[j] = input[i];
      rgba.data[j + 1] = input[i + 1];
      rgba.data[j + 2] = input[i + 2];
      rgba.data[j + 3] = 255;
    }
    const staging = new OffscreenCanvas(128, 64);
    staging.getContext('2d').putImageData(rgba, 0, 0);
    context.imageSmoothingEnabled = false;
    context.drawImage(staging, 0, 0, 256, 128);
  } else {
    context.clearRect(0, 0, 256, 128);
  }

  const slots = [];
  for (let slot = 0; slot < 10; slot += 1) {
    const character = plate.characters[slot];
    if (!character) {
      slots.push(
        element(
          'div',
          { class: 'slot', 'data-empty': 'true', title: 'Padding: the plate has ended' },
          element('span', { class: 'slot-top', text: '·' }),
          element('span', { class: 'slot-bar' }),
          element('span', { class: 'slot-alt', text: ' ' }),
        ),
      );
      continue;
    }
    const [next] = character.alternatives;
    slots.push(
      element(
        'div',
        { class: 'slot', 'data-sure': sureness(character.confidence), title: describeCharacter(character) },
        element('span', { class: 'slot-top', text: character.char }),
        element(
          'span',
          { class: 'slot-bar' },
          element('span', { style: { width: `${Math.round(character.confidence * 100)}%` } }),
        ),
        element('span', {
          class: 'slot-alt',
          text: next && next[1] >= 0.01 ? `${next[0] === '_' ? '∅' : next[0]} ${Math.round(next[1] * 100)}` : ' ',
        }),
      ),
    );
  }
  $('#slots').replaceChildren(...slots);
}

const STAGES = [
  ['pixels', 'Pixels', 'browser', 'Draw the image and copy its pixels'],
  ['letterbox', 'Letterbox', 'cpp', 'Scale to 384 x 384 and pad: C++ in WebAssembly'],
  ['detector', 'Detector', 'network', 'YOLOv9-t finds the plates'],
  ['crops', 'Crops', 'cpp', 'Suppress overlaps, map boxes back, cut out each plate at 128 x 64: C++'],
  ['recognizer', 'Reader', 'network', 'CCT-S reads every plate at once'],
  ['decode', 'Decoding', 'cpp', 'Characters, confidences, and regions: C++'],
];

export function renderStages(timings, backend) {
  const container = $('#stages');
  if (!timings) {
    container.replaceChildren(element('p', { class: 'stages-empty', text: 'Read a photo to see where the time goes.' }));
    $('#pipeline-total').textContent = '';
    return;
  }
  const total = STAGES.reduce((sum, [key]) => sum + (timings[key] ?? 0), 0);
  const longest = Math.max(...STAGES.map(([key]) => timings[key] ?? 0), 1);
  $('#pipeline-total').textContent = milliseconds(total);
  const network = backend === 'webgpu' ? 'network on WebGPU' : 'network on WebAssembly';
  container.replaceChildren(
    ...STAGES.map(([key, name, kind, title]) =>
      element(
        'div',
        { class: 'stage-row', 'data-kind': kind, title },
        element('span', { class: 'stage-name' }, element('b', { text: name })),
        element(
          'span',
          { class: 'stage-track' },
          element('span', {
            class: 'stage-fill',
            style: { width: `${Math.max(1.5, (100 * (timings[key] ?? 0)) / longest)}%` },
          }),
        ),
        element('span', { class: 'stage-time', text: milliseconds(timings[key] ?? 0) }),
      ),
    ),
    element(
      'div',
      { class: 'legend' },
      element('span', { style: { '--swatch': 'linear-gradient(90deg, #3ddc97, #22c3ee)' }, text: network }),
      element('span', { style: { '--swatch': '#8b5cf6' }, text: 'C++ in WebAssembly' }),
      element('span', { style: { '--swatch': 'var(--faint)' }, text: 'browser' }),
    ),
  );
}

// The plates a camera or video has shown: one entry per plate text, newest first, with its best view. A plate lost and
// found again, or whose reading came to match an entry's, joins that entry with its track.
export class PlateLog {
  constructor(list, { onSelect, onHover }) {
    this.list = list;
    this.entries = [];
    this.byTrack = new Map();
    this.labels = null;
    this.onSelect = onSelect;
    this.onHover = onHover;
  }

  // Empties the log; a sample video's labels, if given, are checked against each plate logged.
  clear(labels = null) {
    this.entries = [];
    this.byTrack.clear();
    this.labels = labels;
    this.list.replaceChildren();
  }

  get size() {
    return this.entries.length;
  }

  // A reported, changed, or ended track, with the frame it was read in (none once it has ended).
  update(track, frame) {
    const previous = this.byTrack.get(track.id);
    let entry = this.entries.find((other) => other.text === track.text);
    if (!entry && previous?.tracks.size === 1) {
      entry = previous;
    }
    if (!entry) {
      entry = { text: track.text, tracks: new Map(), card: null, view: null, best: -1 };
      this.entries.push(entry);
    }
    if (previous && previous !== entry) {
      previous.tracks.delete(track.id);
      if (previous.tracks.size > 0) {
        this.render(previous);
      } else {
        if (previous.best > entry.best) {
          entry.best = previous.best;
          entry.view = previous.view;
        }
        previous.card.remove();
        this.entries.splice(this.entries.indexOf(previous), 1);
      }
    }
    entry.text = track.text;
    entry.tracks.set(track.id, track);
    this.byTrack.set(track.id, entry);
    if (frame && track.confidence > entry.best) {
      entry.best = track.confidence;
      entry.view = thumbnail(frame, [
        track.box[0],
        track.box[1],
        track.box[2] - track.box[0],
        track.box[3] - track.box[1],
      ]);
    }
    this.render(entry);
  }

  // The tracks in view, each frame: a logged plate whose reading of its text has grown surer since it was logged gets
  // that reading, and a view from this frame.
  refresh(tracks, frame) {
    for (const track of tracks) {
      const entry = this.byTrack.get(track.id);
      if (entry && track.reported && track.text === entry.text && track.confidence > entry.best + 0.005) {
        this.update(track, frame);
      }
    }
  }

  // Marks which logged plates are in view.
  visible(ids) {
    for (const entry of this.entries) {
      const live = [...entry.tracks.keys()].some((id) => ids.has(id));
      entry.card?.setAttribute('data-live', String(live));
    }
  }

  // An entry's most confident reading, and its tracks' reads and times together.
  static summary(entry) {
    const tracks = [...entry.tracks.values()];
    return {
      reading: tracks.reduce((best, track) => (track.confidence > best.confidence ? track : best)),
      reads: tracks.reduce((sum, track) => sum + track.reads, 0),
      first: Math.min(...tracks.map((track) => track.first_seen_ms)),
      last: Math.max(...tracks.map((track) => track.last_seen_ms)),
    };
  }

  render(entry) {
    const { reading, reads, first } = PlateLog.summary(entry);
    const ids = [...entry.tracks.keys()];
    const card = element(
      'li',
      {
        class: 'plate-card',
        role: 'option',
        tabindex: 0,
        'data-live': entry.card?.dataset.live ?? 'true',
        onclick: () => this.onSelect(ids),
        onpointerenter: () => this.onHover(ids),
        onpointerleave: () => this.onHover([]),
      },
      element('div', { class: 'plate-crop' }, entry.view ?? thumbnail(null)),
      element(
        'div',
        { class: 'plate-body' },
        element(
          'div',
          { class: 'plate-line' },
          plateChip(reading),
          element('span', {
            class: 'confidence',
            'data-sure': sureness(reading.confidence),
            text: percent(reading.confidence),
          }),
        ),
        element(
          'div',
          { class: 'plate-meta' },
          reading.region ? element('span', {}, element('b', { text: reading.region.name })) : null,
          element('span', { class: 'plate-time', text: `${clock(first)} · ${reads} reads` }),
        ),
        this.labels ? truth(reading, this.labels) : null,
      ),
    );
    if (entry.card) {
      card.classList.add('settled');
      entry.card.replaceWith(card);
    } else {
      this.list.prepend(card);
    }
    entry.card = card;
  }

  csv() {
    const rows = [['plate', 'confidence', 'region', 'first_seen_s', 'last_seen_s', 'reads']];
    for (const entry of [...this.entries].reverse()) {
      const { reading, reads, first, last } = PlateLog.summary(entry);
      rows.push([
        reading.text,
        reading.confidence.toFixed(4),
        reading.region?.name ?? '',
        (first / 1000).toFixed(2),
        (last / 1000).toFixed(2),
        reads,
      ]);
    }
    return rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(',')).join('\n');
  }
}
