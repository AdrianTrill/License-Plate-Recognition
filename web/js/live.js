// The camera and video modes: read frames as fast as the networks allow, follow the plates with the C++ tracker,
// and log each plate once it is read confidently.

// Read less often than this in each second of a video, and a plate that passes quickly is missed: a video plays
// slower when the reader can't keep up, down to a quarter of its speed.
const READS_PER_SECOND = 20;
const SLOWEST = 0.25;

export class Live {
  constructor({ engine, video, onResult, onEvents, onState }) {
    this.engine = engine;
    this.video = video;
    this.onResult = onResult;
    this.onEvents = onEvents;
    this.onState = onState;
    this.stream = null;
    this.kind = null; // 'camera' or 'video'
    this.running = false;
    this.paused = false;
    this.generation = 0;
    this.facing = 'environment';
    this.frames = [];
    this.pacing = true;
    this.rate = 1;
    this.lastRead = null; // when the last read finished, for the pace; forgotten across a pause or a jump
    this.video.addEventListener('ended', () => this.ended());
    this.video.addEventListener('seeking', () => {
      this.lastRead = null;
    });
  }

  // Whether a video slows down to the reader's pace; otherwise it plays at its own speed and frames are skipped.
  setPacing(pacing) {
    this.pacing = pacing;
    if (!pacing) this.setRate(1);
  }

  setRate(rate) {
    this.rate = rate;
    if (Math.abs(this.video.playbackRate - rate) > 0.01) this.video.playbackRate = rate;
  }

  // After each read: slow down at once when reads take longer, so a plate coming into view is read from its first
  // frames, and speed up gently when they are quick again.
  pace(interval) {
    if (this.kind !== 'video' || !this.pacing || !(interval > 0)) return;
    const target = Math.min(1, Math.max(SLOWEST, 1000 / READS_PER_SECOND / interval));
    const step = Math.max(0.02, 0.25 * (target - this.rate));
    this.setRate(Math.round(100 * (target < this.rate ? target : Math.min(target, this.rate + step))) / 100);
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
    await this.video.play();
    this.begin('video');
  }

  begin(kind) {
    this.kind = kind;
    this.setRate(1);
    this.lastRead = null;
    this.running = true;
    this.paused = false;
    this.started = performance.now();
    this.engine.resetTracks();
    this.frames = [];
    this.onState({ running: true, paused: false, kind });
    this.loop(++this.generation);
  }

  stop() {
    this.generation += 1;
    this.running = false;
    this.paused = false;
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
    this.lastRead = null;
    if (this.paused) this.video.pause();
    else this.video.play();
    this.onState({ running: true, paused: this.paused, kind: this.kind });
  }

  async ended() {
    if (this.kind !== 'video' || !this.running) return;
    this.generation += 1;
    const tracking = await this.engine.finishTracks();
    this.onEvents(tracking.events, null);
    this.running = false;
    this.onState({ running: false, paused: false, kind: 'video', ended: true });
  }

  async loop(generation) {
    while (this.running && generation === this.generation) {
      const video = this.video;
      if (this.paused || video.readyState < 2 || video.videoWidth === 0) {
        await new Promise((resolve) => setTimeout(resolve, 60));
        continue;
      }
      const timestamp = this.kind === 'camera' ? performance.now() - this.started : video.currentTime * 1000;
      let frame;
      let copy;
      try {
        frame = await createImageBitmap(video);
        copy = await createImageBitmap(frame);
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 30));
        continue;
      }
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
      const now = performance.now();
      this.frames.push(now);
      while (this.frames.length > 20) this.frames.shift();
      const elapsed = (this.frames.at(-1) - this.frames[0]) / Math.max(1, this.frames.length - 1);
      if (this.lastRead !== null) this.pace(now - this.lastRead);
      this.lastRead = now;
      const info = {
        width: copy.width,
        height: copy.height,
        latency: performance.now() - start,
        fps: this.frames.length > 1 ? 1000 / elapsed : 0,
        rate: this.kind === 'video' ? this.rate : 1,
        timestamp,
      };
      this.onResult(result, info, copy);
      if (result.tracking.events.length > 0) this.onEvents(result.tracking.events, copy);
      copy.close();
    }
  }
}
