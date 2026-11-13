// Checks the site itself in headless Chrome, as GitHub Pages serves it: it must start without errors, read every sample
// as labeled and as the native command line does, answer its keys and settings, read uploaded photos, one or several,
// run the camera and a video through the tracker, save a video with its plates, and fit a phone's screen.
//
//   npm ci --prefix web && node web/ui-check.mjs SITE_DIR NATIVE_JSON [--screenshots DIR]
//
// NATIVE_JSON is `lpr --json samples/*.jpg`. Chrome comes from CHROME_PATH, or else from where it is usually installed.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { serve } from './serve.mjs';

const args = process.argv.slice(2);
const screenshotsFlag = args.indexOf('--screenshots');
const screenshots = screenshotsFlag >= 0 ? args.splice(screenshotsFlag, 2)[1] : null;
const [siteDir, nativeJson] = args;
if (!siteDir || !nativeJson) {
  console.error('usage: node web/ui-check.mjs SITE_DIR NATIVE_JSON [--screenshots DIR]');
  process.exit(2);
}
if (screenshots) mkdirSync(screenshots, { recursive: true });

const native = new Map(JSON.parse(readFileSync(nativeJson, 'utf8')).map((image) => [basename(image.image), image]));
const samples = JSON.parse(readFileSync(join(siteDir, 'samples', 'samples.json'), 'utf8'));
const videos = JSON.parse(readFileSync(join(siteDir, 'samples', 'videos.json'), 'utf8'));
const { server, url: site } = await serve(siteDir);

const chrome = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((path) => path && existsSync(path));
if (!chrome) {
  console.error('Chrome not found: set CHROME_PATH');
  process.exit(2);
}
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  // A fake camera, granted without asking. GitHub's Ubuntu runners don't allow Chrome's sandbox; the page is our own.
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
  ],
});
const page = await browser.newPage();
const problems = [];
page.on('pageerror', (error) => problems.push(`uncaught: ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error') problems.push(`console: ${message.text()}`);
});
page.on('response', (response) => {
  if (response.status() >= 400) problems.push(`HTTP ${response.status()}: ${response.url()}`);
});

let failures = 0;
const sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};
async function check(name, body) {
  const start = Date.now();
  try {
    await body();
    console.log(`ok    ${name} (${Date.now() - start} ms)`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${name}: ${error.message}`);
  }
  if (problems.length > 0) {
    failures += 1;
    console.log(`FAIL  ${name}: ${problems.splice(0).join('; ')}`);
  }
}
async function shoot(name) {
  if (screenshots) await page.screenshot({ path: join(screenshots, `${name}.png`) });
}
const plates = () =>
  page.$$eval('.plate-card', (cards) =>
    cards.map((card) => ({
      text: card.querySelector('.plate-chip').getAttribute('aria-label'),
      confidence: card.querySelector('.confidence').textContent,
    })),
  );
async function waitForRead(previous) {
  await page.waitForFunction(
    (before) => document.querySelector('#busy').hidden && document.querySelector('#plates').dataset.read !== before,
    { timeout: 60000 },
    previous,
  );
}

await page.setViewport({ width: 1440, height: 900 });
// The WebAssembly path: runners have no GPU, and its results don't depend on one.
await page.evaluateOnNewDocument(() => {
  localStorage.setItem('lpr-settings', JSON.stringify({ gpu: false }));
});

await check('the page starts, isolates itself, downloads and checks the networks, and reads the first sample', async () => {
  // Served like GitHub Pages, without isolation's headers: the service worker adds them, and the page reloads once.
  await page.goto(site, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === 'true', { timeout: 120000 });
  await page.waitForFunction(() => document.querySelectorAll('.plate-card').length > 0, { timeout: 60000 });
  expect((await page.$eval('#runtime-label', (node) => node.textContent)) === 'WebAssembly', 'runs on WebAssembly');
  expect(await page.evaluate(() => crossOriginIsolated), 'the service worker isolates the page');
  const runtime = await page.$eval('#runtime', (node) => node.title);
  expect(/on [2-9] threads/.test(runtime), `WebAssembly runs on several threads: "${runtime}"`);
  expect(await page.$eval('#loading', (node) => node.hidden), 'the loading card is gone');
  await shoot('photo');
});

await check('every sample reads as labeled, and as the command line reads it', async () => {
  for (const [index, sample] of samples.entries()) {
    const before = await page.$eval('#plates', (node) => node.dataset.read ?? '');
    await page.click(`#samples .sample:nth-child(${index + 1})`);
    await waitForRead(before);
    const read = (await plates()).map((plate) => plate.text);
    for (const label of sample.plates) {
      expect(read.includes(label), `${sample.file}: ${label} not read; read ${read.join(', ')}`);
    }
    const expected = native.get(sample.file).plates.map((plate) => plate.text);
    expect(
      JSON.stringify([...read].sort()) === JSON.stringify([...expected].sort()),
      `${sample.file}: read ${read.join(', ')} in the page, ${expected.join(', ')} natively`,
    );
    expect(new URL(page.url()).searchParams.get('sample') === sample.id, `${sample.file}: the address names the sample`);
  }
});

await check('a plate can be inspected, from the list or the image', async () => {
  await page.click('.plate-card:nth-child(1)');
  expect(!(await page.$eval('#inspector', (node) => node.hidden)), 'the inspector opens');
  const slots = await page.$$eval('.slot', (nodes) => nodes.length);
  expect(slots === 10, `ten slots, not ${slots}`);
  const stages = await page.$$eval('.stage-row', (rows) => rows.length);
  expect(stages === 6, `six pipeline stages, not ${stages}`);
});

await check('keys move between samples, open the shortcuts, settings, and theme', async () => {
  const first = await page.$eval('#samples .sample[aria-selected="true"]', (node) => node.getAttribute('aria-label'));
  const before = await page.$eval('#plates', (node) => node.dataset.read ?? '');
  await page.keyboard.press('ArrowRight');
  await waitForRead(before);
  const second = await page.$eval('#samples .sample[aria-selected="true"]', (node) => node.getAttribute('aria-label'));
  expect(first !== second, 'ArrowRight opens the next sample');
  await page.keyboard.press('?');
  expect(await page.$eval('#help', (node) => node.open), '? opens the shortcuts');
  await page.keyboard.press('Escape');
  expect(!(await page.$eval('#help', (node) => node.open)), 'Escape closes them');
  await page.keyboard.press('s');
  expect(!(await page.$eval('#settings', (node) => node.hidden)), 'S opens the settings');
  await page.keyboard.press('Escape');
  await page.keyboard.press('t');
  expect((await page.$eval('html', (node) => node.dataset.theme)) === 'light', 'T switches to the light theme');
  await shoot('photo-light');
  await page.keyboard.press('t');
});

await check('a stricter threshold reads again and never finds more plates', async () => {
  const opened = await page.$eval('#plates', (node) => node.dataset.read ?? '');
  await page.click('#samples .sample:nth-child(2)');
  await waitForRead(opened);
  const before = (await plates()).length;
  const stamp = await page.$eval('#plates', (node) => node.dataset.read ?? '');
  await page.$eval('#threshold', (input) => {
    input.value = '0.9';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await waitForRead(stamp);
  const after = (await plates()).length;
  expect(after <= before, `${after} plates at 0.9, ${before} at 0.4`);
  const again = await page.$eval('#plates', (node) => node.dataset.read ?? '');
  await page.$eval('#threshold', (input) => {
    input.value = '0.4';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await waitForRead(again);
});

await check('an uploaded photo is read', async () => {
  const [input] = await Promise.all([page.$('#photo-input')]);
  const before = await page.$eval('#plates', (node) => node.dataset.read ?? '');
  await input.uploadFile(join(siteDir, 'samples', samples[0].file));
  await waitForRead(before);
  const read = (await plates()).map((plate) => plate.text);
  expect(read.includes(samples[0].plates[0]), `read ${read.join(', ')}`);
  expect(!new URL(page.url()).searchParams.has('sample'), 'the address no longer names a sample');
});

await check('photos opened together are each read, listed with their plates, and exported as one CSV', async () => {
  const chosen = samples.slice(1, 4);
  // And a photo with no plate: a plain color.
  const blank = join(tmpdir(), 'lpr-check-blank.png');
  const png = await page.evaluate(() => {
    const canvas = Object.assign(document.createElement('canvas'), { width: 640, height: 480 });
    const context = canvas.getContext('2d');
    context.fillStyle = '#5a7896';
    context.fillRect(0, 0, 640, 480);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  writeFileSync(blank, Buffer.from(png, 'base64'));
  const downloads = mkdtempSync(join(tmpdir(), 'lpr-csv-'));
  const session = await browser.target().createCDPSession();
  await session.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  try {
    const files = [...chosen.map((sample) => join(siteDir, 'samples', sample.file)), blank];
    await (await page.$('#photo-input')).uploadFile(...files);
    await page.waitForFunction(
      (count) =>
        document.querySelectorAll('#batch .sample').length === count &&
        !document.querySelector('#batch .sample-count[data-state="reading"]'),
      { timeout: 60000 },
      files.length,
    );
    const listed = await page.$$eval('#batch .sample', (nodes) =>
      nodes.map((node) => ({
        label: node.getAttribute('aria-label'),
        count: node.querySelector('.sample-count').textContent,
        selected: node.getAttribute('aria-selected'),
        thumbnail: Boolean(node.querySelector('img').getAttribute('src')),
      })),
    );
    // In the order of their names, each with what the command line reads in it.
    const expected = [
      ...chosen.map((sample) => ({ name: sample.file, texts: native.get(sample.file).plates.map((plate) => plate.text) })),
      { name: basename(blank), texts: [] },
    ].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    expected.forEach(({ name, texts }, i) => {
      const read = texts.length > 0 ? texts.join(', ') : 'no plates';
      expect(listed[i].label === `${name}: ${read}`, `listed as ${listed[i].label}, not ${name}: ${read}`);
      expect(listed[i].count === String(texts.length) && listed[i].thumbnail, `${name} has its count and thumbnail`);
    });
    expect(listed[0].selected === 'true', 'the first photo is shown');
    await page.waitForFunction(() => document.querySelector('#busy').hidden, { timeout: 30000 });
    const before = await page.$eval('#plates', (node) => node.dataset.read ?? '');
    await page.keyboard.press('ArrowRight');
    await waitForRead(before);
    const shown = (await plates()).map((plate) => plate.text).sort();
    const second = [...expected[1].texts].sort();
    expect(JSON.stringify(shown) === JSON.stringify(second), `ArrowRight shows the next photo: ${shown.join(', ')}`);
    await page.click('#export-button');
    const path = join(downloads, 'photos-plates.csv');
    const deadline = Date.now() + 10000;
    while (!existsSync(path) && Date.now() < deadline) await sleep(100);
    const rows = readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(`[${line}]`));
    const plateCount = chosen.reduce((sum, sample) => sum + native.get(sample.file).plates.length, 0);
    expect(rows.length === 1 + plateCount + 1, `${rows.length} rows: a header, each plate, and the blank photo`);
    const first = native.get(chosen[0].file).plates[0];
    const row = rows.find((cells) => cells[0] === chosen[0].file && cells[1] === first.text);
    expect(
      row && JSON.stringify(row.slice(4).map(Number)) === JSON.stringify(first.box.map(Math.round)),
      `a plate's row has its box in the photo's pixels: ${JSON.stringify(row)}`,
    );
    // A sample opened afterwards is no longer one of them.
    const again = await page.$eval('#plates', (node) => node.dataset.read ?? '');
    await page.click('#samples .sample:nth-child(1)');
    await waitForRead(again);
    expect(!(await page.$('#batch .sample[aria-selected="true"]')), 'opening a sample leaves the batch');
  } finally {
    await session.detach();
    rmSync(downloads, { recursive: true, force: true });
  }
});

await check("a dropped folder's photos, in its folders too, are read together in the order of their names", async () => {
  const folder = mkdtempSync(join(tmpdir(), 'lpr-folder-'));
  mkdirSync(join(folder, 'more'));
  const [a, b, c] = samples.slice(4, 7);
  copyFileSync(join(siteDir, 'samples', a.file), join(folder, 'IMG_10.jpg'));
  copyFileSync(join(siteDir, 'samples', b.file), join(folder, 'IMG_2.jpg'));
  copyFileSync(join(siteDir, 'samples', c.file), join(folder, 'more', 'IMG_1.jpg'));
  writeFileSync(join(folder, 'notes.txt'), 'not a photo');
  const client = await page.createCDPSession();
  try {
    const data = { items: [], files: [folder], dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      await client.send('Input.dispatchDragEvent', { type, x: 500, y: 400, data });
    }
    await page.waitForFunction(
      () =>
        document.querySelector('#batch .sample')?.title.startsWith('IMG_') &&
        !document.querySelector('#batch .sample-count[data-state="reading"]'),
      { timeout: 30000 },
    );
    const listed = await page.$$eval('#batch .sample', (nodes) => nodes.map((node) => node.getAttribute('aria-label')));
    const expected = [c, b, a].map(
      (sample, i) => `IMG_${[1, 2, 10][i]}.jpg: ${native.get(sample.file).plates.map((plate) => plate.text).join(', ')}`,
    );
    expect(JSON.stringify(listed) === JSON.stringify(expected), `listed ${listed.join(' | ')}`);
  } finally {
    await client.detach();
    rmSync(folder, { recursive: true, force: true });
  }
});

await check('the camera starts, reads frames, and stops', async () => {
  await page.keyboard.press('c');
  await page.click('#camera-toggle');
  await page.waitForFunction(() => /fps/.test(document.querySelector('#hud-stats').textContent), { timeout: 60000 });
  expect(!(await page.$eval('#hud', (node) => node.hidden)), 'the live display shows');
  await shoot('camera');
  await page.click('#camera-toggle');
  expect(await page.$eval('#hud', (node) => node.hidden), 'stopping hides it');
});

await check('the video mode plays its first sample by itself, and logs the plates it is labeled with', async () => {
  const [first, second] = videos;
  await page.keyboard.press('v');
  await page.waitForFunction(() => !document.querySelector('#hud').hidden, { timeout: 60000 });
  expect(new URL(page.url()).searchParams.get('video') === first.id, 'the address names the video');
  // At a quarter speed, a slow runner's WebAssembly reads enough frames of every plate.
  await page.click('#video-speed');
  await page.click('#video-speed');
  const speed = await page.evaluate(() => ({
    rate: document.querySelector('#video').playbackRate,
    label: document.querySelector('#video-speed').textContent,
  }));
  expect(speed.rate === 0.25 && speed.label === '¼×', `the speed button slows the video (${JSON.stringify(speed)})`);
  await page.waitForFunction(
    (labels) => {
      const logged = [...document.querySelectorAll('#plates .plate-card .plate-chip')].map((chip) =>
        chip.getAttribute('aria-label'),
      );
      return labels.every((label) => logged.includes(label));
    },
    { timeout: 150000 },
    first.plates,
  );
  const logged = (await plates()).map((plate) => plate.text);
  expect(new Set(logged).size === logged.length, `each plate once: ${logged.join(', ')}`);
  expect(
    (await page.$eval('#credit', (node) => node.textContent)).includes(first.author),
    "the video's author is credited",
  );
  await shoot('video-sample');
  if (second) {
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction((id) => new URL(location.href).searchParams.get('video') === id, { timeout: 10000 }, second.id);
    const selected = await page.$eval('#video-samples .sample:nth-child(2)', (node) => node.getAttribute('aria-selected'));
    expect(selected === 'true', 'ArrowRight opens the next sample video');
    await page.waitForFunction(() => !document.querySelector('#video-speed').hidden, { timeout: 30000 });
    const rate = await page.$eval('#video', (video) => video.playbackRate);
    expect(rate === 0.25, `the speed carries over to the next video (${rate})`);
  }
  await page.click('#video-speed');
  expect((await page.$eval('#video', (video) => video.playbackRate)) === 1, 'and goes back to normal');
});

await check('a video is followed by the tracker, and its plates logged once each', async () => {
  // A short clip recorded in the page: a slow pan across the first sample, so its plate crosses the frame.
  const [x1, y1, x2, y2] = native.get(samples[0].file).plates[0].box;
  const clip = await page.evaluate(async (source, plateX, plateY) => {
    const image = await createImageBitmap(await (await fetch(source)).blob());
    const canvas = Object.assign(document.createElement('canvas'), { width: 960, height: 540 });
    const context = canvas.getContext('2d');
    const recorder = new MediaRecorder(canvas.captureStream(25), { mimeType: 'video/webm' });
    const chunks = [];
    recorder.ondataavailable = (event) => chunks.push(event.data);
    const stopped = new Promise((done) => (recorder.onstop = done));
    recorder.start();
    const scale = Math.max(960 / image.width, 540 / image.height) * 1.25;
    const top = Math.min(0, Math.max(540 - image.height * scale, 270 - plateY * scale));
    // From the plate at the frame's right third to its left third.
    const from = 640 - plateX * scale;
    const to = 320 - plateX * scale;
    for (let frame = 0; frame <= 75; frame += 1) {
      context.fillRect(0, 0, 960, 540);
      context.drawImage(image, from + ((to - from) * frame) / 75, top, image.width * scale, image.height * scale);
      await new Promise((done) => setTimeout(done, 40));
    }
    recorder.stop();
    await stopped;
    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }, `${site}samples/${samples[0].file}`, (x1 + x2) / 2, (y1 + y2) / 2);
  const file = join(tmpdir(), 'lpr-check.webm');
  writeFileSync(file, Buffer.from(clip, 'base64'));
  await page.keyboard.press('v');
  await (await page.$('#video-input')).uploadFile(file);
  await page.waitForFunction(() => document.querySelectorAll('#plates .plate-card').length > 0, { timeout: 90000 });
  const logged = (await plates()).map((plate) => plate.text);
  expect(logged.includes(samples[0].plates[0]), `logged ${logged.join(', ')}`);
  expect(new Set(logged).size === logged.length, `each plate once: ${logged.join(', ')}`);
  expect(!(await page.$eval('#export-button', (node) => node.hidden)), 'the log can be exported');
  await shoot('video');
  await page.keyboard.press('p');
});

await check('a video is read where video frames carry no time, as in Safari and Firefox', async () => {
  // Their VideoFrames of a video element are all stamped 0; the page must take its frames' times from elsewhere.
  const sample = videos.find((video) => video.id === 'fr-lyon-parking') ?? videos[0];
  const other = await browser.newPage();
  other.on('pageerror', (error) => problems.push(`uncaught: ${error.message}`));
  other.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`);
  });
  await other.evaluateOnNewDocument(() => {
    localStorage.setItem('lpr-settings', JSON.stringify({ gpu: false }));
    if (window.VideoFrame) {
      window.VideoFrame = class extends window.VideoFrame {
        get timestamp() {
          return 0;
        }
      };
    }
  });
  try {
    await other.setViewport({ width: 1280, height: 800 });
    await other.goto(`${site}?video=${sample.id}`, { waitUntil: 'load' });
    await other.waitForFunction(
      (labels) => {
        const logged = [...document.querySelectorAll('#plates .plate-chip')].map((chip) => chip.getAttribute('aria-label'));
        return labels.every((label) => logged.includes(label));
      },
      { timeout: 120000 },
      sample.plates,
    );
  } finally {
    await other.close();
  }
});

await check('a video is saved with its plates drawn on it, as an MP4 the browser plays', async () => {
  // The shortest sample, played through once while it is saved; the file downloads when the video ends.
  const sample = [...videos].sort((a, b) => a.duration - b.duration)[0];
  const downloads = mkdtempSync(join(tmpdir(), 'lpr-saved-'));
  const session = await browser.target().createCDPSession();
  await session.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  const other = await browser.newPage();
  other.on('pageerror', (error) => problems.push(`uncaught: ${error.message}`));
  other.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`);
  });
  await other.evaluateOnNewDocument(() => localStorage.setItem('lpr-settings', JSON.stringify({ gpu: false })));
  try {
    await other.setViewport({ width: 1280, height: 800 });
    await other.goto(`${site}?video=${sample.id}`, { waitUntil: 'load' });
    await other.waitForFunction(() => !document.querySelector('#video-save').hidden, { timeout: 120000 });
    await other.click('#video-save');
    await other.waitForFunction(() => document.querySelector('#hud-label').textContent.startsWith('Saving'), {
      timeout: 30000,
    });
    expect((await other.$eval('#video-save', (node) => node.textContent)) === 'Stop and save', 'the button stops');
    const name = `${sample.id}-plates.mp4`;
    const path = join(downloads, name);
    const deadline = Date.now() + (sample.duration + 60) * 1000;
    while (!existsSync(path) && Date.now() < deadline) await sleep(250);
    expect(existsSync(path), `${name} was saved`);
    await sleep(500);
    const file = readFileSync(path);
    // The frames: as many as the sample has, or nearly, at its own pace.
    const stsz = file.indexOf('stsz');
    const frames = file.readUInt32BE(stsz + 12);
    const source = readFileSync(join(siteDir, 'samples', sample.file));
    const sourceFrames = source.readUInt32BE(source.indexOf('stsz') + 12);
    expect(frames >= 0.75 * sourceFrames, `${frames} frames of the sample's ${sourceFrames}`);
    const played = await other.evaluate(async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const video = Object.assign(document.createElement('video'), { muted: true });
      video.src = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
      await new Promise((resolve, reject) => {
        video.onloadeddata = resolve;
        video.onerror = () => reject(new Error(`the browser cannot play it: ${video.error?.message}`));
      });
      video.currentTime = video.duration / 2;
      await new Promise((resolve) => (video.onseeked = resolve));
      const canvas = Object.assign(document.createElement('canvas'), { width: 64, height: 36 });
      const context = canvas.getContext('2d');
      context.drawImage(video, 0, 0, 64, 36);
      const pixels = context.getImageData(0, 0, 64, 36).data;
      let sum = 0;
      for (let i = 0; i < pixels.length; i += 4) sum += pixels[i] + pixels[i + 1] + pixels[i + 2];
      return { duration: video.duration, width: video.videoWidth, height: video.videoHeight, mean: sum / (3 * 64 * 36) };
    }, file.toString('base64'));
    expect(played.width === sample.width && played.height === sample.height, `its size: ${JSON.stringify(played)}`);
    expect(Math.abs(played.duration - sample.duration) < 0.5, `its duration: ${played.duration} s`);
    expect(played.mean > 20, `its frames show the video: ${JSON.stringify(played)}`);
    const toast = await other.$eval('#toasts', (node) => node.textContent);
    expect(toast.includes(`Saved ${name}`), `the page says so: "${toast}"`);
    // Saving again, then leaving the video, saves nothing.
    await other.click('#video-save');
    await other.waitForFunction(() => document.querySelector('#hud-label').textContent.startsWith('Saving'), {
      timeout: 30000,
    });
    await other.keyboard.press('p');
    await other.waitForFunction(() => document.querySelector('#toasts').textContent.includes('Stopped saving'), {
      timeout: 10000,
    });
    await sleep(1500);
    expect(readdirSync(downloads).length === 1, `nothing more was saved: ${readdirSync(downloads).join(', ')}`);
    console.log(`      ${frames} of ${sourceFrames} frames, ${(file.length / 1e6).toFixed(1)} MB`);
  } finally {
    await other.close();
    await session.detach();
    rmSync(downloads, { recursive: true, force: true });
  }
});

await check('the setting for smaller plates loads the larger detector, which reads the first sample as labeled', async () => {
  const other = await browser.newPage();
  other.on('pageerror', (error) => problems.push(`uncaught: ${error.message}`));
  other.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`);
  });
  await other.evaluateOnNewDocument(() => {
    localStorage.setItem('lpr-settings', JSON.stringify({ gpu: false, small: true }));
  });
  try {
    await other.goto(`${site}?sample=${samples[0].id}`, { waitUntil: 'load' });
    await other.waitForFunction(() => document.body.dataset.ready === 'true', { timeout: 120000 });
    await other.waitForFunction(() => document.querySelectorAll('#plates .plate-card').length > 0, { timeout: 60000 });
    const fact = await other.$eval('#fact-runtime', (node) => node.textContent);
    expect(fact.includes('640 pixels'), `the larger detector: "${fact}"`);
    expect(await other.$eval('#small', (node) => node.checked), 'its setting is on');
    const read = await other.$$eval('#plates .plate-chip', (chips) => chips.map((chip) => chip.getAttribute('aria-label')));
    expect(samples[0].plates.every((plate) => read.includes(plate)), `read ${read.join(', ')}`);
  } finally {
    await other.close();
  }
});

await check('a phone screen fits without sideways scrolling', async () => {
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.goto(`${site}?sample=${samples[1].id}`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelectorAll('.plate-card').length > 0, { timeout: 120000 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow <= 0, `the page is ${overflow} px wider than the screen`);
  await shoot('phone');
});

await browser.close();
server.close();
console.log(failures === 0 ? 'The site works' : `${failures} checks failed`);
process.exit(failures === 0 ? 0 : 1);
