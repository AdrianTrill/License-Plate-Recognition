// The page: modes, samples, files, settings, and shortcuts, around the engine (the worker), the viewer, and the sidebar.

import { Engine } from './engine.js';
import { isolate } from './isolate.js';
import { $, bytes, clock, element, icon, milliseconds, toast } from './format.js';
import { Live } from './live.js';
import { PlateLog, renderInspector, renderPlates, renderStages } from './plates.js';
import { COAST_MS } from './timeline.js';
import { Viewer } from './viewer.js';

const base = new URL('./', document.baseURI).href;
// Larger photos are scaled down before reading: plates in them stay far larger than the reader's 128x64 input.
const MAX_SIDE = 4096;

const settings = loadSettings();
const state = {
  mode: 'photo',
  samples: [],
  sample: -1,
  videos: [],
  video: -1, // the sample video playing, or -1 for the visitor's own
  videoLabels: null,
  photo: null, // { bitmap, result, inputs, labels, credit }
  selected: -1,
  pinned: false,
  reading: 0,
  ready: false,
  pending: null,
  liveTracks: [],
};

const engine = new Engine(base);
const viewer = new Viewer($('#canvas'), $('#video'));
const log = new PlateLog($('#plates'), {
  onSelect: (ids) => viewer.setSelected(liveTrack(ids)),
  onHover: (ids) => viewer.setHover(liveTrack(ids)),
});
const live = new Live({
  engine,
  video: $('#video'),
  onResult: liveResult,
  onEvents: liveEvents,
  onState: liveState,
  onPresent: (time) => viewer.present(time),
  onDisplay: liveDisplay,
});
const SPEEDS = [
  { rate: 1, label: '1×' },
  { rate: 0.5, label: '½×' },
  { rate: 0.25, label: '¼×' },
];

function loadSettings() {
  const defaults = { threshold: 0.4, iou: 0.45, gpu: true, small: false, labels: true };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem('lpr-settings') ?? '{}') };
  } catch {
    return defaults;
  }
}

function saveSettings() {
  try {
    localStorage.setItem('lpr-settings', JSON.stringify(settings));
  } catch {
    // Settings last for this visit only.
  }
}

/* Loading */

function showProgress(message) {
  const title = $('#loading-title');
  const detail = $('#loading-detail');
  const bar = $('#progress-bar');
  const progress = bar.parentElement;
  if (message.phase === 'download') {
    progress.dataset.indeterminate = 'false';
    title.textContent = 'Downloading the networks';
    bar.style.width = `${(100 * message.loaded) / Math.max(1, message.total)}%`;
    detail.textContent = `${bytes(message.loaded)} of ${bytes(message.total)}, checked against their SHA-256 and kept for next time`;
  } else if (message.phase === 'compile') {
    progress.dataset.indeterminate = 'true';
    title.textContent = message.gpu ? 'Compiling for WebGPU' : 'Preparing WebAssembly';
    detail.textContent = 'ONNX Runtime Web builds the two networks for this device';
  } else if (message.phase === 'warm-up') {
    progress.dataset.indeterminate = 'true';
    title.textContent = 'Warming up';
    detail.textContent = 'A first run of each network, so timings are steady';
  }
}

async function start() {
  $('#progress-bar').parentElement.dataset.indeterminate = 'true';
  await isolate();
  try {
    const [ready] = await Promise.all([
      engine.init({ gpu: settings.gpu, small: settings.small, onProgress: showProgress }),
      loadSamples(),
    ]);
    state.ready = true;
    engine.setOptions(settings.threshold, settings.iou);
    state.backend = ready.backend;
    const label = ready.backend === 'webgpu' ? 'WebGPU' : 'WebAssembly';
    $('#runtime').dataset.state = 'ready';
    $('#runtime-label').textContent = label;
    const threads = ready.backend !== 'webgpu' && ready.versions.threads > 1 ? ` on ${ready.versions.threads} threads` : '';
    $('#runtime').title = `The networks run in this page on ${label}${threads}, with ONNX Runtime Web ${ready.versions.ort ?? ''}`;
    const { recognizer } = engine.manifest;
    const detector = (settings.small && engine.manifest['detector-640']) || engine.manifest.detector;
    $('#fact-runtime').textContent =
      `ONNX Runtime Web ${ready.versions.ort ?? ''} on ${label}: YOLOv9-t detector at ${detector.input.shape[2]} pixels ` +
      `(${bytes(detector.bytes)}) and CCT-S reader (${bytes(recognizer.bytes)})`;
    $('#loading').hidden = true;
    document.body.dataset.ready = 'true';
    if (state.pending) {
      const next = state.pending;
      state.pending = null;
      next();
    }
  } catch (error) {
    $('#runtime').dataset.state = 'error';
    $('#runtime-label').textContent = 'Unavailable';
    $('#loading-title').textContent = 'The reader could not start';
    $('#loading-detail').textContent = String(error.message ?? error);
    $('#progress-bar').parentElement.dataset.indeterminate = 'false';
    console.error(error);
  }
}

// Runs a task once the engine is ready, or right away if it is.
function whenReady(task) {
  if (state.ready) task();
  else state.pending = task;
}

/* Samples */

async function loadSamples() {
  const [photos, videos] = await Promise.all([
    fetch(`${base}samples/samples.json`),
    fetch(`${base}samples/videos.json`),
  ]);
  if (!photos.ok) return;
  state.samples = await photos.json();
  state.videos = videos.ok ? await videos.json() : [];
  renderVideoSamples();
  $('#samples').replaceChildren(
    ...state.samples.map((sample, index) =>
      element(
        'button',
        {
          class: 'sample',
          role: 'option',
          'aria-selected': 'false',
          'aria-label': `${sample.title}: ${sample.plates.join(', ')}`,
          title: sample.title,
          onclick: () => openSample(index),
        },
        element('img', { src: `${base}samples/${sample.file}`, alt: '', loading: 'lazy', decoding: 'async' }),
        element('span', { class: 'sample-flag', text: sample.country }),
      ),
    ),
  );
  const params = new URLSearchParams(location.search);
  const video = state.videos.findIndex((sample) => sample.id === params.get('video'));
  const index = Math.max(0, state.samples.findIndex((sample) => sample.id === params.get('sample')));
  if (video >= 0) whenReady(() => openVideoSample(video, { scroll: false }));
  else if (state.samples.length > 0) whenReady(() => openSample(index, { scroll: false }));
}

function renderVideoSamples() {
  $('#video-samples').replaceChildren(
    ...state.videos.map((sample, index) =>
      element(
        'button',
        {
          class: 'sample',
          role: 'option',
          'aria-selected': 'false',
          'aria-label': `${sample.title}, ${clock(sample.duration * 1000)}`,
          title: sample.title,
          onclick: () => openVideoSample(index),
        },
        element('img', { src: `${base}samples/${sample.poster}`, alt: '', loading: 'lazy', decoding: 'async' }),
        element('span', { class: 'sample-play' }, icon('play')),
        element('span', { class: 'sample-flag', text: sample.country }),
        element('span', { class: 'sample-time', text: clock(sample.duration * 1000) }),
      ),
    ),
  );
}

function setAddress(name, value) {
  const url = new URL(location.href);
  for (const key of ['sample', 'video']) url.searchParams.delete(key);
  if (name) url.searchParams.set(name, value);
  history.replaceState(null, '', url);
}

async function openVideoSample(index, { scroll = true } = {}) {
  const sample = state.videos[index];
  if (!sample) return;
  setMode('video', { autoplay: false });
  state.video = index;
  document.querySelectorAll('#video-samples .sample').forEach((button, i) => {
    button.setAttribute('aria-selected', String(i === index));
    if (i === index && scroll) button.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  });
  setAddress('video', sample.id);
  await playVideo(`${base}samples/${sample.file}`, {
    labels: sample.plates,
    credit: { text: `Video: ${sample.author}, ${sample.license}`, href: sample.source },
  });
}

// Plays a sample's URL or the visitor's file, with an empty plate log.
async function playVideo(source, { labels = null, credit = null } = {}) {
  state.videoLabels = labels;
  log.clear(labels);
  state.liveTracks = [];
  $('#plate-count').textContent = '0';
  $('#plates-empty').hidden = false;
  showCredit(credit);
  try {
    await live.startVideo(source);
  } catch (error) {
    toast(error.message, 'error');
    return;
  }
  if (state.backend !== 'webgpu' && live.speed === 1 && !state.speedHinted) {
    state.speedHinted = true;
    toast('Without WebGPU fewer frames are read: at ½× speed, plates that pass quickly are read too');
  }
}

async function openSample(index, { scroll = true } = {}) {
  const sample = state.samples[index];
  if (!sample) return;
  setMode('photo', { autoplay: false });
  state.sample = index;
  document.querySelectorAll('#samples .sample').forEach((button, i) => {
    button.setAttribute('aria-selected', String(i === index));
    if (i === index && scroll) button.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  });
  setAddress('sample', sample.id);
  const response = await fetch(`${base}samples/${sample.file}`);
  await readPhoto(await response.blob(), {
    labels: sample.plates,
    credit: { text: `Photo: ${sample.author}, ${sample.license}`, href: sample.source },
  });
}

/* Photos */

async function decode(blob) {
  const probe = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const longest = Math.max(probe.width, probe.height);
  if (longest <= MAX_SIDE) return probe;
  const scale = MAX_SIDE / longest;
  const width = Math.round(probe.width * scale);
  const height = Math.round(probe.height * scale);
  probe.close();
  return createImageBitmap(blob, { imageOrientation: 'from-image', resizeWidth: width, resizeHeight: height, resizeQuality: 'high' });
}

async function readPhoto(blob, { labels = null, credit = null } = {}) {
  if (!state.ready) {
    state.pending = () => readPhoto(blob, { labels, credit });
    return;
  }
  const reading = ++state.reading;
  let bitmap;
  try {
    bitmap = await decode(blob);
  } catch {
    toast('That file is not an image this browser can open', 'error');
    return;
  }
  if (reading !== state.reading) {
    bitmap.close();
    return;
  }
  state.photo?.bitmap?.close?.();
  state.photo = { bitmap, result: null, inputs: null, labels, credit };
  state.selected = -1;
  state.pinned = false;
  // The camera or video may have been chosen while the photo was opening: it is read, and shown when photos are again.
  if (state.mode === 'photo') {
    $('#viewer').dataset.state = 'photo';
    viewer.showImage(bitmap);
    showCredit(credit);
    $('#busy').hidden = false;
  }
  try {
    const result = await engine.read(await createImageBitmap(bitmap), { keepInputs: true });
    if (reading !== state.reading) return;
    state.photo.result = result;
    state.photo.inputs = result.inputs ?? null;
    if (state.mode === 'photo') showPhoto({ animate: true });
  } catch (error) {
    toast(`Could not read the photo: ${error.message}`, 'error');
  } finally {
    if (reading === state.reading) $('#busy').hidden = true;
  }
}

// Reads the photo on screen again, after a setting changed.
async function rereadPhoto() {
  const photo = state.photo;
  if (!photo?.result || state.mode !== 'photo' || !state.ready) return;
  const reading = ++state.reading;
  const result = await engine.read(await createImageBitmap(photo.bitmap), { keepInputs: true });
  if (reading !== state.reading || state.photo !== photo) return;
  photo.result = result;
  photo.inputs = result.inputs ?? null;
  showPhoto({ animate: false });
}

function showPhoto({ animate }) {
  const photo = state.photo;
  if (!photo?.result) return;
  const { plates } = photo.result.frame;
  // A stamp for each reading shown, which the site's checks wait on.
  state.shown = (state.shown ?? 0) + 1;
  $('#plates').dataset.read = String(state.shown);
  viewer.setPlates(plates, { animate });
  $('#plate-count').textContent = String(plates.length);
  $('#plates-empty').hidden = plates.length > 0;
  $('#plates-empty').textContent = 'No plates found. Plates should be at least about 40 pixels wide.';
  renderStages(photo.result.timings, photo.result.backend);
  select(plates.length > 0 ? Math.min(Math.max(state.selected, 0), plates.length - 1) : -1, state.pinned);
}

// Shows a plate in the sidebar; a pinned plate, which the visitor chose, is also brought forward on the image.
function select(index, pinned = true) {
  const photo = state.photo;
  if (state.mode !== 'photo' || !photo?.result) return;
  const plates = photo.result.frame.plates;
  state.selected = index >= 0 && index < plates.length ? index : -1;
  state.pinned = pinned && state.selected >= 0;
  viewer.setSelected(state.selected, state.pinned);
  renderPlates($('#plates'), plates, {
    bitmap: photo.bitmap,
    labels: photo.labels,
    selected: state.selected,
    onSelect: select,
    onHover: (i) => viewer.setHover(i),
  });
  const bytesPerPlate = 64 * 128 * 3;
  const input =
    state.selected >= 0 && photo.inputs
      ? photo.inputs.subarray(state.selected * bytesPerPlate, (state.selected + 1) * bytesPerPlate)
      : null;
  renderInspector(plates[state.selected], input);
}

function showCredit(credit) {
  const link = $('#credit');
  link.hidden = !credit;
  if (credit) {
    link.textContent = credit.text;
    link.href = credit.href;
  }
}

/* Camera and video */

function liveResult(result, info, frame) {
  if (state.mode === 'photo') return;
  // Frames shown behind their reads are drawn by liveDisplay; in a browser without frame callbacks, here.
  if (!info.delayed) {
    if (!viewer.live || viewer.source?.width !== info.width || viewer.source?.height !== info.height) {
      viewer.showVideo(info.width, info.height);
    }
    // Drawn: plates seen twice, so that they have a velocity to be drawn where they have moved to, and kept a moment
    // when a frame misses them; logged views come only from the frames that found them.
    const tracks = result.tracking.tracks.filter(
      (track) => track.seen > 1 && info.timestamp - track.last_seen_ms <= COAST_MS,
    );
    state.liveTracks = tracks;
    viewer.setPlates(tracks.map((track) => ({ ...track, faded: !track.reported })));
    log.visible(new Set(tracks.map((track) => track.id)));
  }
  log.refresh(
    result.tracking.tracks.filter((track) => track.visible),
    frame,
  );
  $('#hud-stats').textContent = `${info.fps.toFixed(1)} fps · ${milliseconds(info.latency)}`;
  const now = performance.now();
  if (!state.stagesShown || now - state.stagesShown > 400) {
    state.stagesShown = now;
    renderStages(result.timings, result.backend);
  }
}

// A frame of the camera or video, shown a little behind, with its plates where they are in it.
function liveDisplay({ bitmap, plates }) {
  if (state.mode === 'photo') return;
  state.liveTracks = plates;
  viewer.showFrame(
    bitmap,
    plates.map((track) => ({ ...track, faded: !track.reported })),
  );
  log.visible(new Set(plates.map((track) => track.id)));
}

function liveEvents(events, frame) {
  for (const { event, track } of events) {
    log.update(track, event === 'ended' ? null : frame);
  }
  $('#plate-count').textContent = String(log.size);
  $('#plates-empty').hidden = log.size > 0;
}

function liveState({ running, paused, kind, ended, error }) {
  const hud = $('#hud');
  hud.hidden = !running;
  hud.dataset.paused = String(Boolean(paused));
  $('#hud-label').textContent = paused ? 'Paused' : kind === 'camera' ? 'Live' : 'Reading';
  const cameraToggle = $('#camera-toggle');
  cameraToggle.querySelector('span').textContent = running && kind === 'camera' ? 'Stop the camera' : 'Start the camera';
  cameraToggle.querySelector('use').setAttribute('href', running && kind === 'camera' ? '#i-stop' : '#i-camera');
  const videoToggle = $('#video-toggle');
  videoToggle.hidden = !(running || ended) || kind !== 'video';
  $('#video-speed').hidden = videoToggle.hidden;
  videoToggle.querySelector('span').textContent = ended ? 'Play again' : paused ? 'Play' : 'Pause';
  videoToggle.querySelector('use').setAttribute('href', ended || paused ? '#i-play' : '#i-pause');
  $('#timeline').hidden = kind !== 'video';
  if (running) {
    $('#viewer').dataset.state = 'live';
  } else if (!ended && state.mode !== 'photo') {
    viewer.clearFrame();
    viewer.setPlates([]);
    $('#viewer').dataset.state = 'empty';
  }
  if (error) toast(`Reading stopped: ${error.message}`, 'error');
}

// Which of the tracks in view is one of these, or -1.
function liveTrack(ids) {
  return state.liveTracks.findIndex((track) => ids.includes(track.id));
}

async function startCamera(facing) {
  try {
    await live.startCamera(facing);
    $('#camera-switch').hidden = (await live.cameraCount()) < 2;
  } catch (error) {
    const denied = error.name === 'NotAllowedError';
    toast(denied ? 'The camera is blocked: allow it in the address bar, then try again' : error.message, 'error');
  }
}

/* Modes */

// Switches modes; the video mode starts its first sample unless something else is about to play.
function setMode(mode, { autoplay = true } = {}) {
  if (mode === state.mode) return;
  if (state.mode !== 'photo') live.stop();
  state.mode = mode;
  document.querySelectorAll('.mode').forEach((button) => {
    button.setAttribute('aria-selected', String(button.dataset.mode === mode));
  });
  document.querySelectorAll('#tray > div').forEach((part) => {
    part.hidden = part.dataset.for !== mode;
  });
  $('#export-button').hidden = mode === 'photo';
  $('#copy-link').hidden = mode !== 'photo';
  $('#plates-title').textContent = mode === 'photo' ? 'Plates' : 'Plates seen';
  $('#plates').replaceChildren();
  renderInspector(null);
  if (mode === 'photo') {
    $('#viewer').dataset.state = state.photo ? 'photo' : 'empty';
    if (state.photo) {
      viewer.showImage(state.photo.bitmap);
      showCredit(state.photo.credit);
      showPhoto({ animate: false });
    } else {
      viewer.clear();
      if (autoplay && state.samples.length > 0) whenReady(() => openSample(0, { scroll: false }));
    }
    setAddress(state.sample >= 0 ? 'sample' : null, state.samples[state.sample]?.id);
  } else {
    log.clear();
    viewer.clear();
    showCredit(null);
    $('#viewer').dataset.state = 'empty';
    $('#plate-count').textContent = '0';
    $('#plates-empty').hidden = false;
    $('#plates-empty').textContent =
      mode === 'camera'
        ? 'Plates appear here once they have been read confidently over a few frames.'
        : 'Each plate in the video appears here once, read over all the frames it is in.';
    $('#empty').querySelector('.empty-title').textContent = mode === 'camera' ? 'Start the camera' : 'Open a video';
    renderStages(null);
    setAddress(null);
    state.video = -1;
    document.querySelectorAll('#video-samples .sample').forEach((button) => button.setAttribute('aria-selected', 'false'));
    if (mode === 'video' && autoplay && state.videos.length > 0) whenReady(() => openVideoSample(0, { scroll: false }));
  }
  if (mode === 'photo') $('#empty').querySelector('.empty-title').textContent = 'Drop a photo here';
}

/* Files, drops, and the clipboard */

function openFile(file) {
  if (!file) return;
  if (file.type.startsWith('video/')) {
    setMode('video', { autoplay: false });
    state.video = -1;
    document.querySelectorAll('#video-samples .sample').forEach((button) => button.setAttribute('aria-selected', 'false'));
    setAddress(null);
    whenReady(() => playVideo(file));
    return;
  }
  setMode('photo', { autoplay: false });
  state.sample = -1;
  document.querySelectorAll('#samples .sample').forEach((button) => button.setAttribute('aria-selected', 'false'));
  setAddress(null);
  readPhoto(file);
}

let dragDepth = 0;
window.addEventListener('dragenter', (event) => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  dragDepth += 1;
  $('#drop').hidden = false;
});
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) $('#drop').hidden = true;
});
window.addEventListener('drop', (event) => {
  event.preventDefault();
  dragDepth = 0;
  $('#drop').hidden = true;
  openFile(event.dataTransfer?.files?.[0]);
});
window.addEventListener('paste', (event) => {
  const item = [...(event.clipboardData?.items ?? [])].find((entry) => entry.type.startsWith('image/'));
  if (item) openFile(item.getAsFile());
});

/* Controls */

document.querySelectorAll('.mode').forEach((button) => {
  button.addEventListener('click', () => setMode(button.dataset.mode));
});
$('#open-photo').addEventListener('click', () => $('#photo-input').click());
$('#photo-input').addEventListener('change', (event) => {
  openFile(event.target.files[0]);
  event.target.value = '';
});
$('#open-video').addEventListener('click', () => $('#video-input').click());
$('#video-input').addEventListener('change', (event) => {
  openFile(event.target.files[0]);
  event.target.value = '';
});
$('#camera-toggle').addEventListener('click', () => {
  if (live.running && live.kind === 'camera') live.stop();
  else whenReady(() => startCamera());
});
$('#camera-switch').addEventListener('click', () => startCamera(live.facing === 'environment' ? 'user' : 'environment'));
$('#video-toggle').addEventListener('click', async () => {
  if (!live.running && live.kind === 'video') {
    // Played again from the start, the tracker numbers its plates from one again, so the log starts over too.
    log.clear(state.videoLabels);
    $('#plate-count').textContent = '0';
    $('#plates-empty').hidden = false;
    live.video.currentTime = 0;
    await live.video.play();
    live.begin('video');
  } else {
    live.toggle();
  }
});
$('#video-speed').addEventListener('click', () => {
  const index = SPEEDS.findIndex((speed) => speed.rate === live.speed);
  const next = SPEEDS[(index + 1) % SPEEDS.length];
  live.setSpeed(next.rate);
  $('#video-speed').textContent = next.label;
  $('#video-speed').setAttribute('aria-label', `Speed ${next.label}`);
});
$('#video').addEventListener('timeupdate', () => {
  const video = $('#video');
  if (!video.duration) return;
  const position = (100 * video.currentTime) / video.duration;
  $('#timeline-fill').style.width = `${position}%`;
  $('#timeline').setAttribute('aria-valuenow', String(Math.round(position)));
});
$('#timeline').addEventListener('click', async (event) => {
  const video = $('#video');
  if (!video.duration) return;
  const rect = event.currentTarget.getBoundingClientRect();
  // A jump in time ends the plates in view; their reads stay in the log.
  liveEvents((await engine.finishTracks()).events, null);
  video.currentTime = ((event.clientX - rect.left) / rect.width) * video.duration;
});
$('#export-button').addEventListener('click', () => {
  if (log.size === 0) {
    toast('No plates to export yet');
    return;
  }
  const link = element('a', {
    href: URL.createObjectURL(new Blob([log.csv()], { type: 'text/csv' })),
    download: 'plates.csv',
  });
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});
$('#copy-link').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    toast('Link copied');
  } catch {
    toast('Could not copy the link', 'error');
  }
});

viewer.onSelect = (index) => {
  if (state.mode === 'photo') select(index, !(index === state.selected && state.pinned));
};
viewer.onHover = (index) => {
  document.querySelectorAll('.plate-card').forEach((card, i) => {
    card.dataset.hover = String(state.mode === 'photo' && i === index);
  });
};

/* Settings */

const settingsPanel = $('#settings');
function toggleSettings(open = settingsPanel.hidden) {
  settingsPanel.hidden = !open;
  $('#settings-button').setAttribute('aria-expanded', String(open));
}
$('#settings-button').addEventListener('click', (event) => {
  event.stopPropagation();
  toggleSettings();
});
document.addEventListener('click', (event) => {
  if (!settingsPanel.hidden && !settingsPanel.contains(event.target)) toggleSettings(false);
});

let rereadTimer = null;
function bindRange(id, key) {
  const input = $(`#${id}`);
  const output = $(`#${id}-value`);
  input.value = settings[key];
  output.textContent = Number(settings[key]).toFixed(2);
  input.addEventListener('input', () => {
    settings[key] = Number(input.value);
    output.textContent = settings[key].toFixed(2);
    saveSettings();
    engine.setOptions(settings.threshold, settings.iou);
    clearTimeout(rereadTimer);
    rereadTimer = setTimeout(rereadPhoto, 120);
  });
}
bindRange('threshold', 'threshold');
bindRange('iou', 'iou');

$('#gpu').checked = settings.gpu;
$('#gpu').addEventListener('change', () => {
  settings.gpu = $('#gpu').checked;
  saveSettings();
  toast('Restarting the reader…');
  setTimeout(() => location.reload(), 500);
});
$('#small').checked = settings.small;
$('#small').addEventListener('change', () => {
  settings.small = $('#small').checked;
  saveSettings();
  toast('Restarting the reader…');
  setTimeout(() => location.reload(), 500);
});
$('#labels').checked = settings.labels;
viewer.setLabels(settings.labels);
$('#labels').addEventListener('change', () => {
  settings.labels = $('#labels').checked;
  saveSettings();
  viewer.setLabels(settings.labels);
});


/* Theme and help */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').content = theme === 'light' ? '#f4f6fa' : '#07090d';
  $('#theme-button use').setAttribute('href', theme === 'light' ? '#i-moon' : '#i-sun');
  try {
    localStorage.setItem('lpr-theme', theme);
  } catch {
    // The theme lasts for this visit only.
  }
}
applyTheme(document.documentElement.dataset.theme);
$('#theme-button').addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
});

const help = $('#help');
$('#help-button').addEventListener('click', () => help.showModal());
help.querySelector('[data-close]').addEventListener('click', () => help.close());
help.addEventListener('click', (event) => {
  if (event.target === help) help.close();
});

/* Keyboard */

document.addEventListener('keydown', (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || help.open) return;
  const key = event.key;
  const plates = state.photo?.result?.frame.plates ?? [];
  if (key === 'p' || key === 'P') setMode('photo');
  else if (key === 'c' || key === 'C') setMode('camera');
  else if (key === 'v' || key === 'V') setMode('video');
  else if (key === 'o' || key === 'O') (state.mode === 'video' ? $('#video-input') : $('#photo-input')).click();
  else if (key === 't' || key === 'T') $('#theme-button').click();
  else if (key === 's' || key === 'S') toggleSettings();
  else if (key === 'l' || key === 'L') $('#labels').click();
  else if (key === '?') help.showModal();
  else if (key === 'ArrowRight' && state.mode === 'photo' && state.samples.length > 0) {
    openSample((state.sample + 1) % state.samples.length);
  } else if (key === 'ArrowLeft' && state.mode === 'photo' && state.samples.length > 0) {
    openSample((state.sample - 1 + state.samples.length) % state.samples.length);
  } else if (key === 'ArrowRight' && state.mode === 'video' && state.videos.length > 0) {
    openVideoSample((state.video + 1) % state.videos.length);
  } else if (key === 'ArrowLeft' && state.mode === 'video' && state.videos.length > 0) {
    openVideoSample((Math.max(state.video, 0) - 1 + state.videos.length) % state.videos.length);
  } else if (/^[1-9]$/.test(key) && state.mode === 'photo' && Number(key) <= plates.length) select(Number(key) - 1);
  else if (key === ' ' && state.mode !== 'photo') live.toggle();
  else if (key === 'Escape') {
    toggleSettings(false);
    if (state.mode === 'photo') select(state.selected, false);
  } else return;
  event.preventDefault();
});

renderStages(null);
start();
