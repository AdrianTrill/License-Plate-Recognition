// The page's side of the inference worker (js/worker.js): it starts the worker, forwards its progress, and turns
// requests into promises.

export class Engine {
  constructor(base) {
    this.base = base;
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    this.pending = new Map();
    this.nextId = 1;
    this.backend = null;
    this.onProgress = () => {};
    this.ready = null;
    this.worker.onmessage = ({ data }) => this.receive(data);
    this.worker.onerror = (event) => this.fail(new Error(event.message || 'The inference worker stopped'));
  }

  receive(message) {
    if (message.type === 'progress') {
      this.onProgress(message);
      return;
    }
    const id = message.type === 'ready' || (message.type === 'error' && message.id === undefined) ? 0 : message.id;
    const request = this.pending.get(id);
    if (!request) return;
    this.pending.delete(id);
    if (message.type === 'error') {
      request.reject(new Error(message.message));
    } else {
      request.resolve(message);
    }
  }

  fail(error) {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  request(message, transfer = []) {
    const id = message.type === 'init' ? 0 : this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...message, id: id || undefined }, transfer);
    });
  }

  // Downloads and checks the models, and compiles them for WebGPU or WebAssembly.
  init({ gpu, small = false, onProgress }) {
    this.onProgress = onProgress ?? (() => {});
    this.ready ??= (async () => {
      const response = await fetch(`${this.base}models/manifest.json`);
      if (!response.ok) throw new Error(`Could not load the models' manifest (HTTP ${response.status})`);
      this.manifest = await response.json();
      const ready = await this.request({ type: 'init', base: this.base, manifest: this.manifest, gpu, small });
      this.backend = ready.backend;
      this.versions = ready.versions;
      return ready;
    })();
    return this.ready;
  }

  // Reads the plates in a bitmap, which is transferred to the worker and closed there.
  read(bitmap, { track = false, timestamp = 0, keepInputs = false } = {}) {
    return this.request({ type: 'read', bitmap, track, timestamp, keepInputs }, [bitmap]);
  }

  setOptions(scoreThreshold, iouThreshold) {
    this.worker.postMessage({ type: 'options', scoreThreshold, iouThreshold });
  }

  async finishTracks() {
    return (await this.request({ type: 'finish-tracks' })).tracking;
  }

  resetTracks() {
    this.worker.postMessage({ type: 'reset-tracks' });
  }
}
