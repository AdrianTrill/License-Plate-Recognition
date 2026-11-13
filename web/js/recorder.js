// Saves a video with its plates drawn on it. Each frame the page shows is drawn at the video's size with its plates,
// encoded as H.264 by the browser (WebCodecs) with the frame's own time, and put into an MP4 (js/mp4.js). The times
// are the video's own, so a video played at ½× or ¼×, as on a slow device, still saves at its real speed.

import { mp4 } from './mp4.js';

// High, Main, and Baseline profiles (Chrome's software encoder, on Linux, has Baseline only), at a level for 1080p.
const CODECS = ['avc1.640028', 'avc1.4d0028', 'avc1.420028', 'avc1.42001f'];
// Larger videos, as a phone's 4K, are saved at 1080p.
const LONGEST = 1920;

export class Recorder {
  // Whether this browser can save videos: it encodes H.264 and calls back on each frame a video shows.
  static async available() {
    if (typeof VideoEncoder !== 'function' || typeof OffscreenCanvas !== 'function') return false;
    if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) return false;
    try {
      await Recorder.create(1280, 720).then((recorder) => recorder.cancel());
      return true;
    } catch {
      return false;
    }
  }

  // A recorder for a video whose frames are width x height, with the first codec the browser can encode.
  static async create(width, height) {
    const scale = Math.min(1, LONGEST / Math.max(width, height));
    // H.264 takes even sizes.
    const even = (value) => 2 * Math.max(1, Math.round((value * scale) / 2));
    const config = {
      width: even(width),
      height: even(height),
      bitrate: Math.round(Math.min(12e6, Math.max(1e6, even(width) * even(height) * 3.5))),
      framerate: 30,
      latencyMode: 'realtime', // frames come out in the order they go in
      avc: { format: 'avc' },
    };
    for (const codec of CODECS) {
      try {
        if ((await VideoEncoder.isConfigSupported({ ...config, codec })).supported) {
          return new Recorder({ ...config, codec });
        }
      } catch {
        // Not this one.
      }
    }
    throw new Error('This browser cannot encode H.264 video');
  }

  constructor(config) {
    this.width = config.width;
    this.height = config.height;
    this.canvas = new OffscreenCanvas(config.width, config.height);
    this.context = this.canvas.getContext('2d');
    this.frames = [];
    this.description = null;
    this.error = null;
    this.last = -Infinity;
    this.count = 0;
    this.encoder = new VideoEncoder({
      output: (chunk, metadata) => {
        const description = metadata?.decoderConfig?.description;
        if (description && !this.description) {
          this.description = ArrayBuffer.isView(description)
            ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength).slice()
            : new Uint8Array(description).slice();
        }
        const data = new ArrayBuffer(chunk.byteLength);
        chunk.copyTo(data);
        this.frames.push({ data, timestamp: chunk.timestamp, key: chunk.type === 'key' });
      },
      error: (error) => {
        this.error = error;
      },
    });
    this.encoder.configure(config);
  }

  // A frame, at its time in the video in milliseconds, drawn by draw(context). A frame no later than the last is
  // skipped, and so is one the encoder has no room for.
  add(time, draw) {
    if (this.error || time <= this.last || this.encoder.encodeQueueSize > 30) return;
    this.last = time;
    draw(this.context);
    const frame = new VideoFrame(this.canvas, { timestamp: Math.round(time * 1000) });
    this.encoder.encode(frame, { keyFrame: this.count % 60 === 0 });
    this.count += 1;
    frame.close();
  }

  // The MP4 of the frames added so far.
  async finish() {
    await this.encoder.flush();
    this.encoder.close();
    if (this.error) throw this.error;
    if (!this.description || this.frames.length === 0) throw new Error('No frames were saved');
    const file = mp4({ width: this.width, height: this.height, description: this.description, frames: this.frames });
    return new Blob([file], { type: 'video/mp4' });
  }

  cancel() {
    try {
      this.encoder.close();
    } catch {
      // Closed already.
    }
  }
}
