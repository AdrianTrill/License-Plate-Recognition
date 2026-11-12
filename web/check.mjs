// Checks the WebAssembly build against the native one. On every image, the pipeline compiled to WebAssembly, running
// the networks in ONNX Runtime Web, must give the detector the same input, bit for bit, and read the same plates as
// the command line does with ONNX Runtime. Both decode the files with the same stb_image, so they start from the same
// pixels; the networks' kernels add in different orders, so scores may differ in their last digits.
//
//   npm ci --prefix web && node web/check.mjs SITE_DIR LPR IMAGE... [--models DIR]
//
// SITE_DIR holds lpr.mjs (and models/, unless --models says otherwise); LPR is the native command line.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as ort from 'onnxruntime-web';

const args = process.argv.slice(2);
const modelsFlag = args.indexOf('--models');
const modelsDir = modelsFlag >= 0 ? args.splice(modelsFlag, 2)[1] : null;
const [siteDir, lpr, ...images] = args;
if (!siteDir || !lpr || images.length === 0) {
  console.error('usage: node web/check.mjs SITE_DIR LPR IMAGE... [--models DIR]');
  process.exit(2);
}
const site = resolve(siteDir);
const models = resolve(modelsDir ?? join(site, 'models'));

const createPipeline = (await import(pathToFileURL(join(site, 'lpr.mjs')).href)).default;
const pipeline = new (await createPipeline()).Pipeline();
ort.env.wasm.numThreads = 1;
ort.env.logLevel = 'error';
const detector = await ort.InferenceSession.create(readFileSync(join(models, 'detector.onnx')));
const recognizer = await ort.InferenceSession.create(readFileSync(join(models, 'recognizer.onnx')));
const size = pipeline.detectorSize();

async function readInWebAssembly(file) {
  pipeline.decode(readFileSync(file));
  const input = new Float32Array(pipeline.prepare());
  const { predictions } = await detector.run({ images: new ort.Tensor('float32', input, [1, 3, size, size]) });
  const plates = new Uint8Array(pipeline.detected(predictions.data));
  const count = pipeline.plateCount();
  let json;
  if (count > 0) {
    const output = await recognizer.run({ input: new ort.Tensor('uint8', plates, [count, 64, 128, 3]) });
    json = pipeline.read(output.plate.data, output.region.data);
  } else {
    json = pipeline.read(new Float32Array(0), new Float32Array(0));
  }
  return { ...JSON.parse(json), trace: JSON.parse(pipeline.fingerprints()) };
}

const native = JSON.parse(
  execFileSync(resolve(lpr), ['--json', '--trace', '--threads', '1', '--models', models, ...images], {
    maxBuffer: 256 * 1024 * 1024,
  }).toString(),
);

const failures = [];
let plates = 0;
let sameRecognizerInput = 0;
let sameCrops = 0;
let sameDetectorInput = 0;
const largest = { box: 0, score: 0, confidence: 0 };
for (const [index, file] of images.entries()) {
  const expected = native[index];
  const actual = await readInWebAssembly(file);
  const fail = (message) => failures.push(`${file}: ${message}`);
  if (actual.width !== expected.width || actual.height !== expected.height) {
    fail(`decoded as ${actual.width}x${actual.height}, natively ${expected.width}x${expected.height}`);
    continue;
  }
  if (actual.trace.detector_input === expected.trace.detector_input) {
    sameDetectorInput += 1;
  } else {
    fail('the detector input differs from the native one');
  }
  if (actual.plates.length !== expected.plates.length) {
    fail(`${actual.plates.length} plates, natively ${expected.plates.length}`);
    continue;
  }
  const cropsMatch = actual.plates.every((plate, i) => plate.crop.join() === expected.plates[i].crop.join());
  if (cropsMatch) {
    sameCrops += 1;
    if (actual.trace.recognizer_input === expected.trace.recognizer_input) {
      sameRecognizerInput += 1;
    } else {
      fail('the same crops gave the recognizer different input');
    }
  }
  for (const [i, plate] of actual.plates.entries()) {
    const other = expected.plates[i];
    plates += 1;
    if (plate.text !== other.text) {
      fail(`plate ${i} read ${plate.text}, natively ${other.text}`);
    }
    largest.box = Math.max(largest.box, ...plate.box.map((value, k) => Math.abs(value - other.box[k])));
    largest.score = Math.max(largest.score, Math.abs(plate.score - other.score));
    largest.confidence = Math.max(largest.confidence, Math.abs(plate.confidence - other.confidence));
  }
}
// The JSON rounds boxes to 0.1 px and probabilities to 4 decimals; allow a step of each beyond the kernels' noise.
if (largest.box > 0.2) failures.push(`boxes differ by up to ${largest.box.toFixed(1)} px`);
if (largest.score > 2e-4) failures.push(`detector scores differ by up to ${largest.score.toFixed(4)}`);
if (largest.confidence > 2e-3) failures.push(`reading confidences differ by up to ${largest.confidence.toFixed(4)}`);

console.log(
  `${images.length} images, ${plates} plates: detector inputs identical on ${sameDetectorInput}; recognizer inputs identical ` +
    `on ${sameRecognizerInput} of ${sameCrops} images with the same crops (${images.length - sameCrops} crops moved ` +
    `a pixel); every text the same; largest differences: boxes ${largest.box.toFixed(1)} px, scores ` +
    `${largest.score.toFixed(4)}, confidences ${largest.confidence.toFixed(4)}`,
);
if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
