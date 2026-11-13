// The camera and video modes: read frames as fast as the networks allow, follow the plates with the C++ tracker,
// and log each plate once it is read confidently.
//
// Frames are shown a little behind instead of as they come: every frame the camera or video shows is kept until its
// turn, the reader takes the newest one each time it is free, and each frame is shown with its plates placed between
// the reads before and after it, so that they fit. A camera stays within a sixth of a second, so that it feels live;
// a frame with no read after it yet has its plates moved on at their velocities.

import { COAST_MS, platesAt } from './timeline.js';

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const smooth = (average, value) => (average === null ? value : average + 0.1 * (value - average));
// How far behind a camera or video is shown, in milliseconds of its clock: enough for the read after a frame to be done.
const MIN_DELAY = 50;
const MAX_DELAY = { video: 600, camera: 150 };
// After a video jumps back, as when it plays again, WebKit can call back once more with the time of the frame before
// the jump, while the video's own time is already at the new place: a frame this far ahead of it is that one.
const STALE = 250;

export class Live {
  constructor({ engine, video, onResult, onEvents, onState, onPresent, onDisplay }) {
    this.engine = engine;
    this.video = video;
    this.onResult = onResult;
    this.onEvents = onEvents;
    this.onState = onState;
    this.onPresent = onPresent;
    this.onDisplay = onDisplay;
    this.onPass = null; // while a video is saved: called, as onDisplay, for frames passed over without being shown
    this.stream = null;
    this.kind = null; // 'camera' or 'video'
    this.running = false;
    this.paused = false;
    this.generation = 0;
    this.facing = 'environment';
    this.frames = [];
    this.speed = 1;
    // Chrome stamps a VideoFrame of the video with the frame's own time; Safari and Firefox stamp every frame 0.
    this.frameClock = typeof VideoFrame === 'function';
    this.shown = null; // the frame the video showed last: { time, count }, from requestVideoFrameCallback
    this.lastStamp = null; // the frame read last, by its timestamp and by the count of frames shown, so that none
    this.lastCount = null; // is read twice
    // A video's frames, oldest first ({ time, bitmap }), the reads of some of them ({ time, tracks }), and how far
    // behind its time it is shown; a jump in it begins a new epoch, whose reads alone count.
    this.queue = [];
    this.reads = [];
    this.epoch = 0;
    this.delay = 150;
    this.video.addEventListener('ended', () => this.ended());
    this.video.addEventListener('seeking', () => {
      if (this.kind === 'video') this.flush();
    });
  }

  async startCamera(facing = this.facing) {
    this.stop();
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser cannot open a camera here; it needs HTTPS and camera support');
    }
    this.facing = facing;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    this.video.srcObject = this.stream;
    this.video.loop = false;
    await this.video.play();
    this.begin('camera');
  }

  async cameraCount() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter((device) => device.kind === 'videoinput').length;
    } catch {
      return 0;
    }
  }

  // Plays a video, from a File the visitor opened or a sample's URL, and reads it as it plays.
  async startVideo(source) {
    this.stop();
    this.video.srcObject = null;
    this.video.src = typeof source === 'string' ? source : URL.createObjectURL(source);
    this.video.loop = false;
    await new Promise((resolve, reject) => {
      this.video.onloadedmetadata = resolve;
      this.video.onerror = () => reject(new Error('This browser cannot play that video'));
    });
    this.video.playbackRate = this.speed;
    await this.video.play();
    this.begin('video');
  }

  // Plays the video again from its start, with the tracker and the frames reset; false if it stopped meanwhile.
  async restart() {
    const generation = ++this.generation; // stops reading and showing the frames before it
    this.running = false;
    this.video.pause();
    const seeked = new Promise((resolve) => this.video.addEventListener('seeked', resolve, { once: true }));
    this.video.currentTime = 0;
    await Promise.race([seeked, sleep(2000)]);
    if (generation !== this.generation) return false;
    await this.video.play();
    if (generation !== this.generation) return false;
    this.begin('video');
    return true;
  }

  // How fast videos play: slower, and the reader sees more frames of each plate.
  setSpeed(speed) {
    this.speed = speed;
    if (this.kind === 'video') this.video.playbackRate = speed;
  }

  begin(kind) {
    this.kind = kind;
    if (kind === 'video') this.video.playbackRate = this.speed;
    this.running = true;
    this.paused = false;
    this.started = performance.now();
    this.delay = kind === 'camera' ? 100 : 150;
    this.shown = null;
    this.lastStamp = null;
    this.lastCount = null;
    this.flush();
    this.engine.resetTracks();
    this.frames = [];
    this.onState({ running: true, paused: false, kind });
    this.generation += 1;
    if (this.video.requestVideoFrameCallback) {
      this.collect(this.generation);
      this.readFrames(this.generation);
      this.display(this.generation);
    } else {
      this.loop(this.generation);
      this.present(this.generation);
    }
  }

  // Forgets a video's frames and reads, when it starts again or jumps.
  flush() {
    for (const entry of this.queue) this.release(entry);
    this.queue = [];
    this.reads = [];
    this.epoch += 1;
    this.readCount = 0;
    this.lastRead = null;
    this.displayed = null;
    this.latency = null;
    this.interval = null;
    this.gap = null;
  }

  release(entry) {
    entry.released = true;
    entry.bitmap?.close();
    entry.bitmap = null;
  }

  stop() {
    this.generation += 1;
    this.running = false;
    this.paused = false;
    this.flush();
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    if (this.video.src.startsWith('blob:')) URL.revokeObjectURL(this.video.src);
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.srcObject = null;
    this.video.load();
    this.kind = null;
    this.onState({ running: false, paused: false, kind: null });
  }

  toggle() {
    if (!this.running) return;
    this.paused = !this.paused;
    if (this.paused) this.video.pause();
    else this.video.play();
    this.onState({ running: true, paused: this.paused, kind: this.kind });
  }

  async ended() {
    if (this.kind !== 'video' || !this.running) return;
    this.generation += 1;
    // The last frame, which the delay would otherwise leave unshown.
    const last = this.queue.findLast((entry) => entry.bitmap);
    if (last) this.show(last);
    const tracking = await this.engine.finishTracks();
    this.onEvents(tracking.events, null);
    this.running = false;
    this.onState({ running: false, paused: false, kind: 'video', ended: true });
  }

  // The time now, on the clock frames are timed by: a video's own, or the camera's since it started.
  clock() {
    return this.kind === 'camera' ? performance.now() - this.started : this.video.currentTime * 1000;
  }

  // Keeps every frame the video shows, with its time, until it has been shown in its turn.
  collect(generation) {
    const video = this.video;
    const step = (now, metadata) => {
      if (!this.running || generation !== this.generation) return;
      const time = this.kind === 'camera' ? now - this.started : metadata.mediaTime * 1000;
      const stale = this.kind === 'video' && time - video.currentTime * 1000 > STALE;
      // A frame before the last, without a seek, is the video starting again: its frames before are done with.
      if (!stale && this.queue.length > 0 && time < this.queue.at(-1).time) this.flush();
      const last = this.queue.at(-1);
      if (!stale && (!last || time > last.time)) {
        if (last) this.gap = smooth(this.gap, time - last.time);
        const entry = { time, bitmap: null, released: false };
        this.queue.push(entry);
        // A video playing while the page is hidden is not shown: keep a few seconds of frames at most.
        while (this.queue.length > 150) this.release(this.queue.shift());
        const capture = () =>
          createImageBitmap(video).then(
            (bitmap) => {
              if (entry.released || generation !== this.generation) {
                bitmap.close();
              } else {
                entry.bitmap = bitmap;
                this.wake();
              }
            },
            () => {
              entry.released = true;
            },
          );
        // Firefox can call back a refresh before the frame is shown, while the video's image is still the one before.
        const wait = metadata.expectedDisplayTime - performance.now();
        if (wait > 4) setTimeout(capture, wait + 1);
        else capture();
      }
      video.requestVideoFrameCallback(step);
    };
    video.requestVideoFrameCallback(step);
  }

  // Resolves when a frame arrives, or after a tenth of a second.
  idle() {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, 100);
      this.waiting = done;
    });
  }

  wake() {
    const waiting = this.waiting;
    this.waiting = null;
    waiting?.();
  }

  // Reads the newest frame each time the reader is free.
  async readFrames(generation) {
    while (this.running && generation === this.generation) {
      const entry = this.queue.findLast(
        (candidate) => candidate.bitmap && (this.lastRead === null || candidate.time > this.lastRead),
      );
      if (!entry) {
        await this.idle();
        continue;
      }
      this.lastRead = entry.time;
      const epoch = this.epoch;
      let frame;
      try {
        frame = await createImageBitmap(entry.bitmap);
      } catch {
        continue;
      }
      const start = performance.now();
      let result;
      try {
        result = await this.engine.read(frame, { track: true, timestamp: entry.time });
      } catch (error) {
        if (generation === this.generation) this.onState({ running: false, error });
        return;
      }
      if (generation !== this.generation) return;
      if (epoch === this.epoch) {
        const previous = this.reads.at(-1);
        this.reads.push({ time: entry.time, tracks: result.tracking.tracks.filter((track) => track.visible) });
        this.readCount += 1;
        this.latency = smooth(this.latency, Math.max(0, this.clock() - entry.time));
        if (previous) this.interval = smooth(this.interval, entry.time - previous.time);
      }
      this.frames.push(performance.now());
      while (this.frames.length > 20) this.frames.shift();
      const elapsed = (this.frames.at(-1) - this.frames[0]) / Math.max(1, this.frames.length - 1);
      const info = {
        width: this.video.videoWidth,
        height: this.video.videoHeight,
        latency: performance.now() - start,
        fps: this.frames.length > 1 ? 1000 / elapsed : 0,
        timestamp: entry.time,
        delayed: true,
      };
      this.onResult(result, info, entry.bitmap);
      if (result.tracking.events.length > 0) this.onEvents(result.tracking.events, entry.bitmap);
    }
  }

  // Shows the video's frames a little behind its time, each with its plates placed between the reads around it.
  display(generation) {
    const step = () => {
      if (generation !== this.generation) return;
      const wanted = (this.latency ?? 0) + (this.interval ?? 0) + (this.gap ?? 0);
      this.delay += 0.03 * (Math.min(MAX_DELAY[this.kind], Math.max(MIN_DELAY, wanted)) - this.delay);
      const target = this.clock() - this.delay;
      let chosen = null;
      for (const entry of this.queue) {
        if (!entry.bitmap) continue;
        if (!chosen || entry.time <= target) chosen = entry;
        if (entry.time > target) break;
      }
      if (chosen && (chosen !== this.displayed || this.readCount !== this.displayedReads)) this.show(chosen);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  show(entry) {
    if (this.onPass) {
      for (const passed of this.queue) {
        if (passed === entry) break;
        if (passed.bitmap && passed !== this.displayed) {
          this.onPass({ bitmap: passed.bitmap, time: passed.time, plates: platesAt(this.reads, passed.time) });
        }
      }
    }
    this.displayed = entry;
    this.displayedReads = this.readCount;
    this.onDisplay({ bitmap: entry.bitmap, time: entry.time, plates: platesAt(this.reads, entry.time) });
    // The frames before it are done with, and so are the reads too old to place a plate in it.
    while (this.queue.length > 0 && this.queue[0] !== entry) this.release(this.queue.shift());
    while (this.reads.length > 1 && this.reads[1].time < entry.time - 2 * COAST_MS) this.reads.shift();
  }

  // On every frame the video shows, its time on the tracker's clock: a video's own time, or the camera's since it
  // started.
  present(generation) {
    const video = this.video;
    const step = (now, metadata) => {
      if (!this.running || generation !== this.generation) return;
      const time = this.kind === 'camera' ? now - this.started : (metadata?.mediaTime ?? video.currentTime) * 1000;
      this.shown = { time, count: metadata?.presentedFrames };
      this.onPresent(time);
      schedule();
    };
    const schedule = () => {
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(step);
      else requestAnimationFrame((now) => step(now));
    };
    schedule();
  }

  // Resolves when the video shows its next frame, or after a quarter second without one.
  nextFrame() {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 250);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      if (this.video.requestVideoFrameCallback) this.video.requestVideoFrameCallback(done);
      else requestAnimationFrame(done);
    });
  }

  // The frame on screen as an ImageBitmap, with its time on the tracker's clock, or null if it was read already. In
  // Chrome a VideoFrame of the video carries the frame's own timestamp, so the plates' motion is measured between the
  // frames' true times; elsewhere the time is that of the frame the video showed last.
  async capture() {
    const video = this.video;
    const shown = this.shown;
    const clock = this.kind === 'camera' ? performance.now() - this.started : null;
    if (this.frameClock) {
      let source = null;
      try {
        source = new VideoFrame(video);
      } catch {
        this.frameClock = false;
      }
      if (source) {
        try {
          const time = source.timestamp / 1000;
          // A stamp far from the video's time, or one that stays while the video shows new frames, is no clock.
          const off = this.kind === 'video' && Math.abs(time - video.currentTime * 1000) > 200;
          const stuck =
            source.timestamp === this.lastStamp && shown?.count !== undefined && shown.count > this.lastCount + 1;
          if (off || stuck) {
            this.frameClock = false;
          } else if (source.timestamp === this.lastStamp) {
            return null;
          } else {
            this.lastStamp = source.timestamp;
            this.lastCount = shown?.count ?? null;
            return { frame: await createImageBitmap(source), timestamp: clock ?? time };
          }
        } finally {
          source.close();
        }
      }
    }
    if (shown?.count !== undefined) {
      if (shown.count === this.lastCount) return null;
      this.lastCount = shown.count;
    }
    return { frame: await createImageBitmap(video), timestamp: clock ?? shown?.time ?? video.currentTime * 1000 };
  }

  async loop(generation) {
    while (this.running && generation === this.generation) {
      const video = this.video;
      if (this.paused || video.seeking || video.readyState < 2 || video.videoWidth === 0) {
        await sleep(60);
        continue;
      }
      let captured;
      let copy;
      try {
        captured = await this.capture();
        if (!captured) {
          await this.nextFrame();
          continue;
        }
        copy = await createImageBitmap(captured.frame);
      } catch {
        captured?.frame.close();
        await sleep(30);
        continue;
      }
      const { frame, timestamp } = captured;
      const start = performance.now();
      let result;
      try {
        result = await this.engine.read(frame, { track: true, timestamp });
      } catch (error) {
        copy.close();
        if (generation === this.generation) this.onState({ running: false, error });
        return;
      }
      if (generation !== this.generation) {
        copy.close();
        return;
      }
      this.frames.push(performance.now());
      while (this.frames.length > 20) this.frames.shift();
      const elapsed = (this.frames.at(-1) - this.frames[0]) / Math.max(1, this.frames.length - 1);
      const info = {
        width: copy.width,
        height: copy.height,
        latency: performance.now() - start,
        fps: this.frames.length > 1 ? 1000 / elapsed : 0,
        timestamp,
      };
      this.onResult(result, info, copy);
      if (result.tracking.events.length > 0) this.onEvents(result.tracking.events, copy);
      copy.close();
    }
  }
}
