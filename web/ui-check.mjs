// Checks the site itself in headless Chrome, as GitHub Pages serves it: it must start without errors, read every sample
// as labeled and as the native command line does, answer its keys and settings, read an uploaded photo, run the camera
// and a video through the tracker, and fit a phone's screen.
//
//   npm ci --prefix web && node web/ui-check.mjs SITE_DIR NATIVE_JSON [--screenshots DIR]
//
// NATIVE_JSON is `lpr --json samples/*.jpg`. Chrome comes from CHROME_PATH, or else from where it is usually installed.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

await check('the page starts, downloads and checks the networks, and reads the first sample', async () => {
  await page.goto(site, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === 'true', { timeout: 120000 });
  await page.waitForFunction(() => document.querySelectorAll('.plate-card').length > 0, { timeout: 60000 });
  expect((await page.$eval('#runtime-label', (node) => node.textContent)) === 'WebAssembly', 'runs on WebAssembly');
  expect(await page.$eval('#loading', (node) => node.hidden), 'the loading card is gone');
  await shoot('photo');
});

await check('every sample reads as labeled, and as the command line reads it', async () => {
  for (const [index, sample] of samples.entries()) {
    const before = await page.$eval('#plates', (node) => node.dataset.read ?? '');
    await page.click(`.sample:nth-child(${index + 1})`);
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
  const first = await page.$eval('.sample[aria-selected="true"]', (node) => node.getAttribute('aria-label'));
  const before = await page.$eval('#plates', (node) => node.dataset.read ?? '');
  await page.keyboard.press('ArrowRight');
  await waitForRead(before);
  const second = await page.$eval('.sample[aria-selected="true"]', (node) => node.getAttribute('aria-label'));
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
  await page.click('.sample:nth-child(2)');
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

await check('the camera starts, reads frames, and stops', async () => {
  await page.keyboard.press('c');
  await page.click('#camera-toggle');
  await page.waitForFunction(() => /fps/.test(document.querySelector('#hud-stats').textContent), { timeout: 60000 });
  expect(!(await page.$eval('#hud', (node) => node.hidden)), 'the live display shows');
  await shoot('camera');
  await page.click('#camera-toggle');
  expect(await page.$eval('#hud', (node) => node.hidden), 'stopping hides it');
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
