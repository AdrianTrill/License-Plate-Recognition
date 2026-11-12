"""Reads every sample video natively and requires its labeled plates.

    python tools/check_videos.py [build/lpr]

Each video in samples/videos.json is decoded by ffmpeg into raw RGB frames and piped into `lpr video --json`; every
plate the video is labeled with must be among the plates the tracker reports. Needs ffmpeg and ffprobe.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def probe(path: Path) -> tuple[int, int, float]:
    output = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,avg_frame_rate",
         "-of", "json", str(path)],
        capture_output=True, check=True, text=True,
    ).stdout  # fmt: skip
    stream = json.loads(output)["streams"][0]
    numerator, denominator = stream["avg_frame_rate"].split("/")
    return stream["width"], stream["height"], float(numerator) / float(denominator)


def read(lpr: str, path: Path) -> dict[int, dict]:
    """The tracker's plates in a video, by track: each one's last reading."""
    width, height, fps = probe(path)
    decoder = subprocess.Popen(
        ["ffmpeg", "-loglevel", "error", "-i", str(path), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        stdout=subprocess.PIPE,
    )
    reader = subprocess.run(
        [lpr, "video", "--size", f"{width}x{height}", "--fps", f"{fps:.4f}", "--json"],
        stdin=decoder.stdout, capture_output=True, check=True, text=True,
    )  # fmt: skip
    decoder.stdout.close()
    if decoder.wait() != 0:
        raise SystemExit(f"ffmpeg could not decode {path}")
    tracks: dict[int, dict] = {}
    for line in reader.stdout.splitlines():
        event = json.loads(line)
        tracks[event["track"]["id"]] = event["track"]
    return tracks


def main() -> None:
    lpr = sys.argv[1] if len(sys.argv) > 1 else str(ROOT / "build" / "lpr")
    videos = json.loads((ROOT / "samples" / "videos.json").read_text())
    failures = 0
    for video in videos:
        tracks = read(lpr, ROOT / "samples" / video["file"])
        texts = {track["text"] for track in tracks.values()}
        missing = [plate for plate in video["plates"] if plate not in texts]
        others = sorted(texts - set(video["plates"]))
        summary = ", ".join(f"{t['text']} ({t['confidence']:.1%}, {t['reads']} reads)" for t in tracks.values())
        print(f"{video['file']}: {summary or 'no plates'}" + (f"; also read: {', '.join(others)}" if others else ""))
        if missing:
            failures += 1
            print(f"  missing: {', '.join(missing)}")
    if failures:
        raise SystemExit(f"{failures} of {len(videos)} videos lacked labeled plates")
    print(f"Every labeled plate in the {len(videos)} sample video{'s' if len(videos) != 1 else ''} was read")


if __name__ == "__main__":
    main()
