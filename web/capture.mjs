// Regenerates the README's images and the link preview from the built site, in headless Chrome:
//
//   docs/assets/photo.png   a sample read, with one plate inspected
//   docs/assets/video.png   the first sample video followed by the tracker, with the plate log
//   docs/assets/demo.gif    a tour: samples read one after another, a plate inspected (needs ffmpeg)
//   docs/assets/video.webp  a sample video read as it plays, its plates followed and logged (needs ffmpeg, and
//                           Python with Pillow, from tools/requirements.txt)
//   web/social.png          the link preview, from web/social-card.html
//
//   npm ci --prefix web && node web/capture.mjs SITE_DIR [photo] [video] [tour] [videotour] [social]
//
// Name some of them to capture only those. Rebuild the site afterwards, so it serves the new social.png.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';
import { serve } from './serve.mjs';

const [siteDir, ...only] = process.argv.slice(2);
if (!siteDir) {
  console.error('usage: node web/capture.mjs SITE_DIR [photo] [video] [tour] [videotour] [social]');
  process.exit(2);
}
const wanted = (name) => only.length === 0 || only.includes(name);
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
  args: [
    '--autoplay-policy=no-user-gesture-required',
    '--enable-unsafe-webgpu',
    ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
  ],
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
if (wanted('photo')) {
  await open('ro-sibiu', { scale: 1 });
  await page.click('.plate-card:nth-child(2)');
  await page.mouse.move(10, 890);
  await sleep(700);
  await page.screenshot({ path: join(assets, 'photo.png') });
  console.log('docs/assets/photo.png');
}

// The video view: the first sample video, on WebGPU where there is one, paused once its plates are logged.
if (wanted('video')) {
  const [clip] = JSON.parse(readFileSync(join(siteDir, 'samples', 'videos.json'), 'utf8'));
  const videoPage = await browser.newPage();
  videoPage.on('pageerror', (error) => console.error(`page error: ${error.message}`));
  await videoPage.evaluateOnNewDocument(() => localStorage.setItem('lpr-theme', 'dark'));
  await videoPage.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await videoPage.goto(`${site}?video=${clip.id}`, { waitUntil: 'load' });
  await videoPage.waitForFunction(
    (labels) => {
      const logged = [...document.querySelectorAll('#plates .plate-chip')].map((chip) => chip.getAttribute('aria-label'));
      return labels.every((label) => logged.includes(label));
    },
    { timeout: 180000, polling: 50 },
    clip.plates,
  );
  // A moment longer, for the last plate's view to sharpen as it comes closer.
  await sleep(1500);
  await videoPage.click('#video-toggle');
  await videoPage.mouse.move(10, 890);
  await sleep(600);
  await videoPage.screenshot({ path: join(assets, 'video.png') });
  await videoPage.close();
  console.log('docs/assets/video.png');
}

// The tour, recorded as a screencast and turned into a GIF.
if (wanted('tour')) {
  await open('ro-cluj-napoca', { width: 1440, height: 900, scale: 1 });
  const video = join(tmpdir(), 'lpr-tour.webm');
  rmSync(video, { force: true });
  const recorder = await page.screencast({ path: video });
  await sleep(1200);
  for (const id of ['ro-sibiu', 'fr-dieppe', 'nl-vanquish']) {
    const index = samples.findIndex((sample) => sample.id === id);
    const before = await page.$eval('#plates', (node) => node.dataset.read ?? '');
    await page.click(`#samples .sample:nth-child(${index + 1})`);
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
}

// The video tour: the 2CV parade read as it plays, on WebGPU where there is one, from its first frame to its last.
if (wanted('videotour')) {
  const videos = JSON.parse(readFileSync(join(siteDir, 'samples', 'videos.json'), 'utf8'));
  const index = Math.max(0, videos.findIndex((sample) => sample.id === 'nl-2cv-parade'));
  const tourPage = await browser.newPage();
  tourPage.on('pageerror', (error) => console.error(`page error: ${error.message}`));
  await tourPage.evaluateOnNewDocument(() => localStorage.setItem('lpr-theme', 'dark'));
  await tourPage.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await tourPage.goto(`${site}?video=${videos[index].id}`, { waitUntil: 'load' });
  await tourPage.waitForFunction(() => document.querySelector('#video').currentTime > 0.5, { timeout: 180000 });
  await tourPage.mouse.move(10, 890);
  const recording = join(tmpdir(), 'lpr-video-tour.webm');
  rmSync(recording, { force: true });
  const recorder = await tourPage.screencast({ path: recording });
  // Started again from the beginning, with an empty log.
  await tourPage.click(`#video-samples .sample:nth-child(${index + 1})`);
  await tourPage.waitForFunction(() => document.querySelector('#video').ended, { timeout: 120000, polling: 100 });
  await sleep(1200);
  await recorder.stop();
  await tourPage.close();
  // An animated WebP: a GIF of a video's frames is four times the size.
  const frames = join(tmpdir(), 'lpr-video-tour');
  rmSync(frames, { recursive: true, force: true });
  mkdirSync(frames);
  execFileSync('ffmpeg', [
    '-loglevel', 'error', '-ss', '0.3', '-i', recording,
    '-vf', 'fps=12,scale=900:-1:flags=lanczos', join(frames, 'f%04d.png'),
  ]);
  execFileSync('python3', [
    '-c',
    `import glob, sys
from PIL import Image
frames = [Image.open(path).convert('RGB') for path in sorted(glob.glob(sys.argv[1] + '/*.png'))]
frames[0].save(sys.argv[2], save_all=True, append_images=frames[1:], duration=83, loop=0, quality=50, method=6)`,
    frames,
    join(assets, 'video.webp'),
  ]);
  rmSync(frames, { recursive: true, force: true });
  console.log('docs/assets/video.webp');
}

// The link preview.
if (wanted('social')) {
  // Its pieces, at twice the size, from a sample's view.
  await open('fr-dieppe', { scale: 2 });
  const viewerShot = await (await page.$('#viewer')).screenshot({ encoding: 'base64' });
  const platesShot = await (await page.$('.plates-panel')).screenshot({ encoding: 'base64' });

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
}

await browser.close();
server.close();
