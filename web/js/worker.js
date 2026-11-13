// The inference worker: ONNX Runtime Web runs the two networks, and the C++ pipeline, compiled to WebAssembly, does
// everything around them, off the page's main thread. js/engine.js drives it.
//
// In:  { type: 'init', base, manifest, gpu, small }
//      { type: 'read', id, bitmap, options?, track?, timestamp?, keepInputs? }   bitmap: ImageBitmap, transferred
//      { type: 'options', scoreThreshold, iouThreshold }
//      { type: 'finish-tracks', id }  { type: 'reset-tracks' }
// Out: { type: 'progress', phase, loaded?, total? }
//      { type: 'ready', backend, versions }
//      { type: 'result', id, frame, tracking?, timings, inputs? }
//      { type: 'error', id?, message }

let ort = null;
let pipeline = null;
let detector = null;
let recognizer = null;
let backend = null;
let canvas = null;
let context = null;

// One message at a time, in order: a read keeps its frame in the pipeline while it waits for the networks, so a read
// begun meanwhile would replace it.
let queue = Promise.resolve();
self.onmessage = ({ data }) => {
  queue = queue.then(() => handle(data));
};

async function handle(data) {
  try {
    switch (data.type) {
      case 'init':
        await init(data);
        break;
      case 'read':
        await read(data);
        break;
      case 'options':
        pipeline.setOptions(data.scoreThreshold, data.iouThreshold);
        break;
      case 'finish-tracks':
        self.postMessage({ type: 'result', id: data.id, tracking: JSON.parse(pipeline.finishTracks()) });
        break;
      case 'reset-tracks':
        pipeline.resetTracks();
        break;
      default:
        throw new Error(`unknown message ${data.type}`);
    }
  } catch (error) {
    data.bitmap?.close?.();
    self.postMessage({ type: 'error', id: data.id, message: String(error?.message ?? error) });
  }
}

async function gpuAdapter() {
  try {
    return self.navigator.gpu ? await self.navigator.gpu.requestAdapter() : null;
  } catch {
    return null;
  }
}

async function init({ base, manifest, gpu: allowGpu, small }) {
  if (pipeline) {
    self.postMessage({ type: 'ready', backend, versions: versions() });
    return;
  }
  const adapter = allowGpu ? await gpuAdapter() : null;
  // The WebGPU build is twice the size of the WebAssembly one: load only the one that will run.
  ort = await import(`${base}ort/${adapter ? 'ort.webgpu.min.mjs' : 'ort.wasm.min.mjs'}`);
  ort.env.wasm.wasmPaths = `${base}ort/`;
  // Threads need a cross-origin isolated page, which the service worker makes it (js/isolate.js).
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  ort.env.logLevel = 'error';

  const { default: createPipeline } = await import(`${base}lpr.mjs`);
  pipeline = new (await createPipeline({ locateFile: (file) => `${base}${file}` })).Pipeline();
  // The larger detector, at 640 pixels, finds plates that are small in a large frame.
  const detectorFile = small && manifest['detector-640'] ? manifest['detector-640'] : manifest.detector;
  pipeline.setDetectorSize(detectorFile.input.shape[2]);

  const files = [detectorFile, manifest.recognizer];
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  const loaded = [0, 0];
  const progress = () => self.postMessage({ type: 'progress', phase: 'download', loaded: loaded[0] + loaded[1], total });
  const [detectorBytes, recognizerBytes] = await Promise.all(
    files.map((file, i) =>
      loadModel(`${base}models/${file.file}`, file.sha256, file.bytes, (bytes) => {
        loaded[i] = bytes;
        progress();
      }),
    ),
  );

  self.postMessage({ type: 'progress', phase: 'compile', gpu: Boolean(adapter) });
  const sessionOptions = { logSeverityLevel: 3, graphOptimizationLevel: 'all' };
  if (adapter) {
    try {
      detector = await ort.InferenceSession.create(detectorBytes, { ...sessionOptions, executionProviders: ['webgpu'] });
      recognizer = await ort.InferenceSession.create(recognizerBytes, { ...sessionOptions, executionProviders: ['webgpu'] });
      backend = 'webgpu';
    } catch {
      detector = null;
      recognizer = null;
    }
  }
  if (!detector) {
    detector = await ort.InferenceSession.create(detectorBytes, { ...sessionOptions, executionProviders: ['wasm'] });
    recognizer = await ort.InferenceSession.create(recognizerBytes, { ...sessionOptions, executionProviders: ['wasm'] });
    backend = 'wasm';
  }

  // The first runs compile kernels; do them now, so reads report steady timings.
  self.postMessage({ type: 'progress', phase: 'warm-up' });
  const size = pipeline.detectorSize();
  for (let i = 0; i < 2; i += 1) {
    await detector.run({ images: new ort.Tensor('float32', new Float32Array(3 * size * size), [1, 3, size, size]) });
    await recognizer.run({ input: new ort.Tensor('uint8', new Uint8Array(64 * 128 * 3), [1, 64, 128, 3]) });
  }
  self.postMessage({ type: 'ready', backend, versions: versions() });
}

function versions() {
  return { ort: ort?.env?.versions?.web ?? null, threads: ort?.env?.wasm?.numThreads ?? 1 };
}

async function loadModel(url, sha256, size, onProgress) {
  let cache = null;
  try {
    cache = await caches.open('lpr-models');
  } catch {
    // Without Cache Storage (some private windows), the models download on each visit.
  }
  // The hash names the file in the cache, so a new model never meets an old copy.
  const key = `${url}?sha256=${sha256}`;
  const hit = cache && (await cache.match(key));
  if (hit) {
    const bytes = new Uint8Array(await hit.arrayBuffer());
    onProgress(bytes.length);
    return bytes;
  }

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download ${url} (HTTP ${response.status})`);
  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(Math.min(loaded, size));
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (hex !== sha256) throw new Error(`${url} does not match its SHA-256 in the manifest`);
  if (cache) {
    try {
      for (const request of await cache.keys()) {
        if (request.url.split('?')[0] === new URL(url, self.location.href).href) await cache.delete(request);
      }
      await cache.put(key, new Response(bytes));
    } catch {
      // Over quota: carry on without the cache.
    }
  }
  return bytes;
}

async function read({ id, bitmap, track, timestamp, keepInputs }) {
  const timings = {};
  let start = performance.now();
  const { width, height } = bitmap;
  if (!canvas || canvas.width !== width || canvas.height !== height) {
    canvas = new OffscreenCanvas(width, height);
    context = canvas.getContext('2d', { willReadFrequently: true });
  }
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  pipeline.frame(width, height).set(context.getImageData(0, 0, width, height).data);
  timings.pixels = performance.now() - start;

  start = performance.now();
  const size = pipeline.detectorSize();
  const input = new Float32Array(pipeline.prepare());
  timings.letterbox = performance.now() - start;

  start = performance.now();
  const { predictions } = await detector.run({ images: new ort.Tensor('float32', input, [1, 3, size, size]) });
  timings.detector = performance.now() - start;

  start = performance.now();
  const plates = new Uint8Array(pipeline.detected(predictions.data));
  const count = pipeline.plateCount();
  timings.crops = performance.now() - start;

  let probabilities = new Float32Array(0);
  let regions = new Float32Array(0);
  timings.recognizer = 0;
  if (count > 0) {
    start = performance.now();
    const output = await recognizer.run({ input: new ort.Tensor('uint8', plates, [count, 64, 128, 3]) });
    probabilities = output.plate.data;
    regions = output.region.data;
    timings.recognizer = performance.now() - start;
  }

  start = performance.now();
  const frame = JSON.parse(pipeline.read(probabilities, regions));
  const tracking = track ? JSON.parse(pipeline.track(timestamp)) : null;
  timings.decode = performance.now() - start;

  const message = { type: 'result', id, frame, tracking, timings, backend };
  if (keepInputs && count > 0) {
    message.inputs = plates;
    self.postMessage(message, [plates.buffer]);
  } else {
    self.postMessage(message);
  }
}
