// Regenerates the README's images and the link preview from the built site, in headless Chrome:
//
//   docs/assets/photo.png   a sample read, with one plate inspected
//   docs/assets/video.png   a video followed by the tracker, with the plate log
//   docs/assets/demo.gif    a tour: samples read one after another, a plate inspected (needs ffmpeg)
//   web/social.png          the link preview, from web/social-card.html
//
//   npm ci --prefix web && node web/capture.mjs SITE_DIR
//
// Rebuild the site afterwards, so it serves the new social.png.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';
import { serve } from './serve.mjs';

const siteDir = process.argv[2];
if (!siteDir) {
  console.error('usage: node web/capture.mjs SITE_DIR');
  process.exit(2);
}
const web = dirname(fileURLToPath(import.meta.url));
const assets = join(web, '..', 'docs', 'assets');
mkdirSync(assets, { recursive: true });
const samples = JSON.parse(readFileSync(join(siteDir, 'samples', 'samples.json'), 'utf8'));
const { server, url: site } = await serve(siteDir);

const chrome = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((path) => path && existsSync(path));
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
});
const page = await browser.newPage();
page.on('pageerror', (error) => console.error(`page error: ${error.message}`));
const sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
await page.evaluateOnNewDocument(() => {
  localStorage.setItem('lpr-settings', JSON.stringify({ gpu: false }));
  localStorage.setItem('lpr-theme', 'dark');
});

async function open(sample, { width = 1440, height = 900, scale = 1, mobile = false } = {}) {
  await page.setViewport({ width, height, deviceScaleFactor: scale, isMobile: mobile, hasTouch: mobile });
  await page.goto(`${site}?sample=${sample}`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === 'true', { timeout: 120000 });
  await page.waitForFunction(() => document.querySelectorAll('.plate-card').length > 0, { timeout: 60000 });
  await sleep(900);
}

async function waitForRead(before) {
  await page.waitForFunction(
    (stamp) => document.querySelector('#busy').hidden && document.querySelector('#plates').dataset.read !== stamp,
    { timeout: 60000 },
    before,
  );
}

// The photo view: the Sibiu sample, its second plate inspected.
await open('ro-sibiu', { scale: 1 });
await page.click('.plate-card:nth-child(2)');
await page.mouse.move(10, 890);
await sleep(700);
await page.screenshot({ path: join(assets, 'photo.png') });
console.log('docs/assets/photo.png');

// The link preview's pieces, at twice the size, from the same view.
await open('fr-dieppe', { scale: 2 });
const viewerShot = await (await page.$('#viewer')).screenshot({ encoding: 'base64' });
const platesShot = await (await page.$('.plates-panel')).screenshot({ encoding: 'base64' });

// The video view: a slow pan across a sample, recorded in the page, read as a video.
await open('ro-cluj-napoca', { scale: 1 });
const clip = await page.evaluate(async (source) => {
  const image = await createImageBitmap(await (await fetch(source)).blob());
  const canvas = Object.assign(document.createElement('canvas'), { width: 1280, height: 720 });
  const context = canvas.getContext('2d');
  const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: 'video/webm', videoBitsPerSecond: 6e6 });
  const chunks = [];
  recorder.ondataavailable = (event) => chunks.push(event.data);
  const stopped = new Promise((done) => (recorder.onstop = done));
  recorder.start();
  const scale = 1.35 * Math.max(1280 / image.width, 720 / image.height);
  for (let frame = 0; frame <= 150; frame += 1) {
    const t = frame / 150;
    context.drawImage(image, -t * (image.width * scale - 1280), -0.32 * (image.height * scale - 720), image.width * scale, image.height * scale);
    await new Promise((done) => setTimeout(done, 33));
  }
  recorder.stop();
  await stopped;
  const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}, `${site}samples/ro-cluj-napoca.jpg`);
const clipPath = join(tmpdir(), 'lpr-capture.webm');
writeFileSync(clipPath, Buffer.from(clip, 'base64'));
await page.keyboard.press('v');
await (await page.$('#video-input')).uploadFile(clipPath);
await page.waitForFunction(() => document.querySelectorAll('#plates .plate-card').length > 0, { timeout: 90000 });
await sleep(1800);
await page.click('#video-toggle');
await sleep(400);
await page.screenshot({ path: join(assets, 'video.png') });
console.log('docs/assets/video.png');

// The tour, recorded as a screencast and turned into a GIF.
await open('ro-cluj-napoca', { width: 1440, height: 900, scale: 1 });
const video = join(tmpdir(), 'lpr-tour.webm');
rmSync(video, { force: true });
const recorder = await page.screencast({ path: video });
await sleep(1200);
for (const id of ['ro-sibiu', 'fr-dieppe', 'nl-vanquish']) {
  const index = samples.findIndex((sample) => sample.id === id);
  const before = await page.$eval('#plates', (node) => node.dataset.read ?? '');
  await page.click(`.sample:nth-child(${index + 1})`);
  await waitForRead(before);
  await sleep(1300);
  const box = await page.$eval('.plate-card:nth-child(2)', (card) => {
    const rect = card.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }).catch(() => null);
  if (box) {
    await page.mouse.move(box.x, box.y, { steps: 12 });
    await sleep(900);
    await page.mouse.click(box.x, box.y);
    await sleep(1400);
    await page.mouse.move(700, 880, { steps: 8 });
  }
}
await sleep(800);
await recorder.stop();
execFileSync('ffmpeg', [
  '-y', '-loglevel', 'error', '-i', video,
  '-vf', 'fps=12,scale=1000:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=192:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle',
  join(assets, 'demo.gif'),
]);
console.log('docs/assets/demo.gif');

// The link preview.
await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(join(web, 'social-card.html')).href, { waitUntil: 'load' });
await page.evaluate(
  async (viewer, plates) => {
    const load = (id, data) =>
      new Promise((done) => {
        const image = document.getElementById(id);
        image.onload = done;
        image.src = `data:image/png;base64,${data}`;
      });
    await Promise.all([load('viewer', viewer), load('plates', plates)]);
  },
  viewerShot,
  platesShot,
);
await sleep(300);
await page.screenshot({ path: join(web, 'social.png') });
console.log('web/social.png');

await browser.close();
server.close();
