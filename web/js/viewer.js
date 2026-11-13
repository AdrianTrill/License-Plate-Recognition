// The viewer: the photo, or the live video beneath it, with the plates outlined and labeled on a canvas.

import { percent, sureness } from './format.js';

const COLORS = { high: '#3ddc97', mid: '#f5b544', low: '#f87171', unread: '#94a3b8' };
const LABEL_FONT = '700 15px ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace';
const SMALL_FONT = '600 11px ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace';
// A plate in a video is drawn where it has moved to since its frame was read, for no longer than this.
const LONGEST_GUESS = 250;

export class Viewer {
  constructor(canvas, video) {
    this.canvas = canvas;
    this.video = video;
    this.context = canvas.getContext('2d');
    this.bitmap = null;
    this.frame = null; // a video's frame, shown in place of the video, behind its time
    this.source = null; // { width, height } of what the plates' boxes refer to
    this.live = false;
    this.time = null; // a video's time on screen, on the tracker's clock
    this.plates = [];
    this.labels = true;
    this.selected = -1;
    this.pinned = false;
    this.hover = -1;
    this.appear = 1;
    this.onHover = () => {};
    this.onSelect = () => {};
    new ResizeObserver(() => this.draw()).observe(canvas);
    canvas.addEventListener('pointermove', (event) => this.pointer(event, false));
    canvas.addEventListener('pointerleave', () => this.setHover(-1, true));
    canvas.addEventListener('click', (event) => this.pointer(event, true));
  }

  // The photo to show, as an ImageBitmap; whoever made it closes it.
  showImage(bitmap) {
    this.bitmap = bitmap;
    this.source = { width: bitmap.width, height: bitmap.height };
    this.canvas.parentElement.style.setProperty('--aspect', `${bitmap.width} / ${bitmap.height}`);
    this.live = false;
    this.plates = [];
    this.selected = -1;
    this.hover = -1;
    this.draw();
  }

  // Overlays the playing video, whose frames are width x height.
  showVideo(width, height) {
    this.bitmap = null;
    this.source = { width, height };
    this.canvas.parentElement.style.setProperty('--aspect', `${width} / ${height}`);
    this.live = true;
    this.frame = null;
    this.time = null;
    this.plates = [];
    this.selected = -1;
    this.draw();
  }

  // A frame of a video, drawn in place of the playing video, with its plates where they are in it. Whoever made the
  // frame closes it, after showing the next.
  showFrame(bitmap, plates) {
    if (!this.live || this.source?.width !== bitmap.width || this.source?.height !== bitmap.height) {
      this.source = { width: bitmap.width, height: bitmap.height };
      this.canvas.parentElement.style.setProperty('--aspect', `${bitmap.width} / ${bitmap.height}`);
      this.live = true;
    }
    this.frame = bitmap;
    this.time = null;
    this.plates = plates;
    if (this.selected >= plates.length) this.selected = -1;
    this.draw();
  }

  // A frame of a video with its plates where they are in it, filling another canvas, as a saved video shows it:
  // outlines and labels are sized as on a screen a thousand pixels across.
  renderFrame(context, bitmap, plates) {
    const { width, height } = context.canvas;
    const zoom = Math.max(width, height) / 1000;
    context.save();
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, width, height);
    context.scale(zoom, zoom);
    const scale = width / bitmap.width / zoom;
    const layout = { scale, left: 0, top: 0, right: bitmap.width * scale };
    for (const plate of plates) this.drawPlate(plate, plate.box, layout, { context, appear: 1 });
    context.restore();
  }

  clearFrame() {
    this.frame = null;
    this.draw();
  }

  // A new frame of the camera is on screen.
  present(time) {
    this.time = time;
    if (this.live && this.plates.length > 0) this.draw();
  }

  clear() {
    this.bitmap = null;
    this.frame = null;
    this.source = null;
    this.live = false;
    this.time = null;
    this.plates = [];
    this.selected = -1;
    this.hover = -1;
    this.draw();
  }

  // Plates as { box: [x1, y1, x2, y2], text, confidence, faded? }, in the source's pixels; a video's plates also have
  // the time their box was seen at and their velocity, in pixels per millisecond (last_seen_ms, velocity).
  setPlates(plates, { animate = false } = {}) {
    this.plates = plates;
    if (this.selected >= plates.length) this.selected = -1;
    if (animate) {
      const start = performance.now();
      const step = (now) => {
        this.appear = Math.min(1, (now - start) / 380);
        this.draw();
        if (this.appear < 1) requestAnimationFrame(step);
      };
      this.appear = 0;
      requestAnimationFrame(step);
    } else {
      this.appear = 1;
      this.draw();
    }
  }

  setLabels(visible) {
    this.labels = visible;
    this.draw();
  }

  // The plate the sidebar shows; a pinned one, chosen by the visitor, is also brought forward on the image.
  setSelected(index, pinned = true) {
    this.selected = index;
    this.pinned = pinned && index >= 0;
    this.draw();
  }

  setHover(index, notify = false) {
    if (index === this.hover) return;
    this.hover = index;
    this.canvas.dataset.hover = String(index >= 0);
    if (notify) this.onHover(index);
    this.draw();
  }

  // Where the source sits in the canvas, in CSS pixels: scaled to fit, and centered.
  layout() {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (!this.source || width === 0 || height === 0) return null;
    const scale = Math.min(width / this.source.width, height / this.source.height);
    const left = (width - this.source.width * scale) / 2;
    return { scale, left, top: (height - this.source.height * scale) / 2, right: left + this.source.width * scale };
  }

  pointer(event, click) {
    const layout = this.layout();
    if (!layout) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left - layout.left) / layout.scale;
    const y = (event.clientY - rect.top - layout.top) / layout.scale;
    const margin = 6 / layout.scale;
    let found = -1;
    let smallest = Infinity;
    this.plates.forEach((plate, index) => {
      const [x1, y1, x2, y2] = this.shown(plate);
      const area = (x2 - x1) * (y2 - y1);
      if (x >= x1 - margin && x <= x2 + margin && y >= y1 - margin && y <= y2 + margin && area < smallest) {
        found = index;
        smallest = area;
      }
    });
    if (click) {
      if (found >= 0) this.onSelect(found);
    } else {
      this.setHover(found, true);
    }
  }

  draw() {
    const ratio = window.devicePixelRatio || 1;
    const cssWidth = this.canvas.clientWidth;
    const cssHeight = this.canvas.clientHeight;
    const width = Math.round(cssWidth * ratio);
    const height = Math.round(cssHeight * ratio);
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    const context = this.context;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, width, height);
    const layout = this.layout();
    if (!layout) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);

    const image = this.live ? this.frame : this.bitmap;
    if (image) {
      context.imageSmoothingQuality = 'high';
      try {
        context.drawImage(image, layout.left, layout.top, this.source.width * layout.scale, this.source.height * layout.scale);
      } catch {
        // A video's frame closed as it stopped: nothing to show.
      }
    }

    const focus = this.hover >= 0 ? this.hover : this.pinned ? this.selected : -1;
    if (focus >= 0 && !this.live) {
      // Dim everything but the plate in focus.
      const [x1, y1, x2, y2] = this.screenBox(this.shown(this.plates[focus]), layout);
      context.save();
      context.fillStyle = 'rgba(3, 5, 8, 0.45)';
      context.beginPath();
      context.rect(layout.left, layout.top, this.source.width * layout.scale, this.source.height * layout.scale);
      context.roundRect(x1 - 4, y1 - 4, x2 - x1 + 8, y2 - y1 + 8, 6);
      context.fill('evenodd');
      context.restore();
    }

    const order = this.plates.map((_, index) => index).sort((a, b) => (a === focus) - (b === focus));
    context.save();
    if (this.live) {
      // A plate drawn ahead of its last frame may be leaving the video: keep it to the video's area.
      context.beginPath();
      context.rect(layout.left, layout.top, this.source.width * layout.scale, this.source.height * layout.scale);
      context.clip();
    }
    for (const index of order) {
      this.drawPlate(this.plates[index], this.shown(this.plates[index]), layout, {
        context,
        appear: this.appear,
        focused: index === focus,
        dimmed: focus >= 0 && index !== focus,
      });
    }
    context.restore();
  }

  // Where a plate is on screen now, in the source's pixels: in a video, moved on at its velocity since it was seen.
  shown(plate) {
    if (!this.live || this.time === null || !plate.velocity) return plate.box;
    const elapsed = Math.min(LONGEST_GUESS, Math.max(0, this.time - plate.last_seen_ms));
    const dx = plate.velocity[0] * elapsed;
    const dy = plate.velocity[1] * elapsed;
    const [x1, y1, x2, y2] = plate.box;
    return [x1 + dx, y1 + dy, x2 + dx, y2 + dy];
  }

  screenBox(box, layout) {
    return [
      layout.left + box[0] * layout.scale,
      layout.top + box[1] * layout.scale,
      layout.left + box[2] * layout.scale,
      layout.top + box[3] * layout.scale,
    ];
  }

  // A plate's outline and label, at box in the source's pixels; appear grows new readings from 0 to 1.
  drawPlate(plate, box, layout, { context, appear, focused = false, dimmed = false }) {
    let [x1, y1, x2, y2] = this.screenBox(box, layout);
    // New readings grow out of their centers.
    const grow = 0.6 + 0.4 * easeOut(appear);
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;
    x1 = cx + (x1 - cx) * grow;
    x2 = cx + (x2 - cx) * grow;
    y1 = cy + (y1 - cy) * grow;
    y2 = cy + (y2 - cy) * grow;
    const color = plate.text ? COLORS[sureness(plate.confidence)] : COLORS.unread;
    const alpha = (dimmed ? 0.55 : 1) * (plate.faded ? 0.5 : 1) * Math.min(1, appear * 2);

    context.save();
    context.globalAlpha = alpha;
    const w = x2 - x1;
    const h = y2 - y1;
    context.fillStyle = hexAlpha(color, focused ? 0.16 : 0.08);
    context.fillRect(x1, y1, w, h);
    context.strokeStyle = hexAlpha(color, 0.65);
    context.lineWidth = 1.25;
    context.strokeRect(x1, y1, w, h);

    // Corner brackets, as a camera's focus marks.
    const arm = Math.max(6, Math.min(16, Math.min(w, h) * 0.45));
    context.strokeStyle = color;
    context.lineWidth = focused ? 3.5 : 2.75;
    context.lineCap = 'round';
    context.beginPath();
    for (const [x, y, dx, dy] of [
      [x1, y1, 1, 1],
      [x2, y1, -1, 1],
      [x1, y2, 1, -1],
      [x2, y2, -1, -1],
    ]) {
      context.moveTo(x - dx * 3, y + dy * arm);
      context.lineTo(x - dx * 3, y - dy * 3);
      context.lineTo(x + dx * arm, y - dy * 3);
    }
    context.stroke();

    if (this.labels || focused) {
      this.drawLabel(plate, x1, y1, y2, color, layout, context);
    }
    context.restore();
  }

  drawLabel(plate, x, top, bottom, color, layout, context) {
    const text = plate.text || 'unreadable';
    const detail = plate.text ? percent(plate.confidence) : '';
    context.font = LABEL_FONT;
    const textWidth = context.measureText(text).width;
    context.font = SMALL_FONT;
    const detailWidth = detail ? context.measureText(detail).width + 8 : 0;
    const width = textWidth + detailWidth + 22;
    const height = 26;
    let y = top - height - 8;
    if (y < layout.top + 2) y = bottom + 8;
    const left = Math.max(layout.left + 2, Math.min(x - 3, layout.right - width - 2));

    context.fillStyle = 'rgba(7, 10, 15, 0.86)';
    context.beginPath();
    context.roundRect(left, y, width, height, 7);
    context.fill();
    context.fillStyle = color;
    context.beginPath();
    context.roundRect(left, y, 4, height, [7, 0, 0, 7]);
    context.fill();

    context.textBaseline = 'middle';
    context.font = LABEL_FONT;
    context.fillStyle = plate.text ? '#f8fafc' : '#cbd5e1';
    context.fillText(text, left + 12, y + height / 2 + 1);
    if (detail) {
      context.font = SMALL_FONT;
      context.fillStyle = color;
      context.fillText(detail, left + 12 + textWidth + 8, y + height / 2 + 1);
    }
  }
}

function easeOut(t) {
  return 1 - (1 - t) ** 3;
}

function hexAlpha(hex, alpha) {
  const value = parseInt(hex.slice(1), 16);
  return `rgba(${value >> 16}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}
