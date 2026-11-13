"""Prepares the two networks the pipeline runs, from their pinned upstream releases.

    pip install -r tools/requirements.txt
    python tools/prepare_models.py           # writes the models in models/, and models/manifest.json
    python tools/prepare_models.py --check   # prepares them again and requires the hashes in models/manifest.json

The detector is open-image-models' YOLOv9-t license plate detector at 384 pixels (detector.onnx), and the same network
at 640 pixels (detector-640.onnx), which finds smaller plates and takes about two and a half times as long. Each is
published "end to end", with non-maximum suppression in the graph. The pipeline does that step itself, in C++, so that
its thresholds can change while it runs and the whole network can run on WebGPU; this tool cuts the graph where the
detection head ends. It refuses to write the result unless the cut graph, followed by the pipeline's own suppression,
finds exactly the original graph's plates on every sample image.

The recognizer is fast-plate-ocr's cct-s-v2-global-model, as published. Its configuration must match the one compiled
into the pipeline (src/recognizer.cpp).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import ssl
import sys
import tempfile
import urllib.request
from pathlib import Path

import certifi
import numpy as np
import onnx
import onnx.utils
import onnxruntime as ort
import yaml
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
MODELS = ROOT / "models"
SAMPLES = ROOT / "samples"
CACHE = ROOT / ".cache" / "upstream"

# The detectors, by the name the manifest gives each, with the size of its square input.
DETECTORS = {
    "detector": (
        384,
        {
            "name": "yolo-v9-t-384-license-plate-end2end",
            "project": "https://github.com/ankandrew/open-image-models",
            "license": "MIT",
            "url": "https://github.com/ankandrew/open-image-models/releases/download/assets/"
            "yolo-v9-t-384-license-plates-end2end.onnx",
            "sha256": "888397b96d761c89db40bc9c305838e8652660f5e282c2cadebbe8d2951a77a8",
        },
    ),
    "detector-640": (
        640,
        {
            "name": "yolo-v9-t-640-license-plate-end2end",
            "project": "https://github.com/ankandrew/open-image-models",
            "license": "MIT",
            "url": "https://github.com/ankandrew/open-image-models/releases/download/assets/"
            "yolo-v9-t-640-license-plates-end2end.onnx",
            "sha256": "c3c1026ca7d0585dd88084d68182dd897113712fa734ae1557ca70174440c076",
        },
    ),
}
# Where the detection head ends: box centers and sizes in input pixels, and the plate score, for every anchor.
DETECTOR_HEAD = "/model/model.22/Concat_5_output_0"
# The suppression the published graph runs, which the pipeline's must reproduce.
NMS_IOU = 0.45
NMS_SCORE = np.float32(0.001)
NMS_MAX = 100

RECOGNIZER = {
    "name": "cct-s-v2-global-model",
    "project": "https://github.com/ankandrew/fast-plate-ocr",
    "license": "MIT",
    "url": "https://github.com/ankandrew/fast-plate-ocr/releases/download/arg-plates/cct_s_v2_global.onnx",
    "sha256": "384bbbd2cea3ef54761d3df70822ef3a349ee1a112aeafddbe0e3ba06bc6e47b",
}
RECOGNIZER_CONFIG = {
    "url": "https://github.com/ankandrew/fast-plate-ocr/releases/download/arg-plates/"
    "cct_s_v2_global_plate_config.yaml",
    "sha256": "0335c74a305173bb6f393efed0fde03cadeaa0b649ed8e19f431016d8232d0a6",
}
# The configuration compiled into src/recognizer.cpp.
ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_"
PAD = "_"
SLOTS = 10
HEIGHT, WIDTH = 64, 128
REGIONS = [
    "Albania", "Andorra", "Argentina", "Armenia", "Australia", "Austria", "Azerbaijan", "Bahrain", "Belarus",
    "Belgium", "Bosnia and Herzegovina", "Brazil", "Bulgaria", "Cambodia", "Canada", "Croatia", "Cyprus",
    "Czech Republic", "Denmark", "Estonia", "Finland", "France", "Georgia", "Germany", "Gibraltar", "Greece",
    "Guernsey", "Hungary", "Iceland", "Indonesia", "Ireland", "Israel", "Italy", "Latvia", "Liechtenstein",
    "Lithuania", "Luxembourg", "Malaysia", "Malta", "Mexico", "Moldova", "Monaco", "Montenegro", "Netherlands",
    "New Zealand", "North Macedonia", "Norway", "Poland", "Portugal", "Qatar", "Romania", "San Marino", "Serbia",
    "Singapore", "Slovakia", "Slovenia", "Spain", "Sweden", "Switzerland", "Thailand", "Turkey", "United States",
    "Ukraine", "United Kingdom", "Vietnam", "Unknown",
]  # fmt: skip


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def fetch(source: dict) -> bytes:
    """An upstream file, from the cache or downloaded, checked against its pinned hash."""
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / source["url"].rsplit("/", 1)[1]
    if path.exists() and sha256(path.read_bytes()) == source["sha256"]:
        return path.read_bytes()
    print(f"Downloading {source['url']}")
    request = urllib.request.Request(source["url"], headers={"User-Agent": "License-Plate-Recognition"})
    # certifi's certificates, since python.org's macOS builds come without any.
    context = ssl.create_default_context(cafile=certifi.where())
    with urllib.request.urlopen(request, timeout=120, context=context) as response:
        data = response.read()
    if sha256(data) != source["sha256"]:
        raise SystemExit(f"{source['url']} does not match its pinned SHA-256; refusing to use it")
    path.write_bytes(data)
    return data


def anchors(size: int) -> int:
    """The detection head's anchors: one per cell of its three grids, at strides 8, 16, and 32."""
    return sum((size // stride) ** 2 for stride in (8, 16, 32))


def cut_detector(end_to_end: bytes, directory: Path, source: dict) -> bytes:
    """The published detector without its suppression: one output, 'predictions', [1, 5, anchors]."""
    full = directory / "end2end.onnx"
    full.write_bytes(end_to_end)
    head = directory / "head.onnx"
    onnx.utils.extract_model(str(full), str(head), ["images"], [DETECTOR_HEAD])
    model = onnx.load(str(head))
    for node in model.graph.node:
        node.output[:] = ["predictions" if name == DETECTOR_HEAD else name for name in node.output]
        if DETECTOR_HEAD in node.input:
            raise SystemExit("the detection head feeds another node; the cut would change the network")
    (output,) = model.graph.output
    output.name = "predictions"
    model.doc_string = (
        f"{source['name']} from {source['project']} ({source['license']}), without its non-maximum "
        f"suppression. Output: box centers, sizes, and plate scores for every anchor, in input pixels."
    )
    del model.metadata_props[:]
    for key, value in (("source", source["url"]), ("source_sha256", source["sha256"])):
        model.metadata_props.add(key=key, value=value)
    onnx.checker.check_model(model)
    return model.SerializeToString()


def letterbox(image: Image.Image, size: int) -> np.ndarray:
    """A letterboxed input for the checks; any faithful input will do."""
    scale = min(size / image.height, size / image.width)
    width, height = round(image.width * scale), round(image.height * scale)
    canvas = Image.new("RGB", (size, size), (114, 114, 114))
    canvas.paste(image.convert("RGB").resize((width, height), Image.BILINEAR), ((size - width) // 2, (size - height) // 2))
    return (np.asarray(canvas, dtype=np.float32) / 255.0).transpose(2, 0, 1)[None]


def suppress(predictions: np.ndarray) -> np.ndarray:
    """The pipeline's suppression (src/detector.cpp), as rows of x1, y1, x2, y2, score."""
    cx, cy, w, h, score = predictions[0]
    keep = score > NMS_SCORE
    boxes = np.stack([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], axis=1)[keep]
    scores = score[keep]
    order = np.argsort(-scores, kind="stable")
    chosen: list[int] = []
    for i in order:
        if len(chosen) == NMS_MAX:
            break
        b = boxes[i]
        overlaps = False
        for j in chosen:
            c = boxes[j]
            iw = min(b[2], c[2]) - max(b[0], c[0])
            ih = min(b[3], c[3]) - max(b[1], c[1])
            if iw > 0 and ih > 0:
                inter = iw * ih
                union = (b[2] - b[0]) * (b[3] - b[1]) + (c[2] - c[0]) * (c[3] - c[1]) - inter
                if inter / union > NMS_IOU:
                    overlaps = True
                    break
        if not overlaps:
            chosen.append(int(i))
    return np.concatenate([boxes[chosen], scores[chosen, None]], axis=1)


def check_detector(end_to_end: bytes, head: bytes, samples: Path, size: int) -> int:
    """Requires the cut graph and the pipeline's suppression to find the published graph's plates; returns how many."""
    options = ort.SessionOptions()
    options.log_severity_level = 3
    full = ort.InferenceSession(end_to_end, options, providers=["CPUExecutionProvider"])
    cut = ort.InferenceSession(head, options, providers=["CPUExecutionProvider"])
    images = sorted(samples.glob("*.jpg"))
    if not images:
        raise SystemExit(f"no images in {samples} to check the detector with")
    plates = 0
    for path in images:
        tensor = letterbox(Image.open(path), size)
        expected = full.run(None, {"images": tensor})[0]
        expected = expected[np.argsort(-expected[:, 6], kind="stable")]
        (predictions,) = cut.run(None, {"images": tensor})
        if predictions.shape != (1, 5, anchors(size)):
            raise SystemExit(f"the cut detector's output is {predictions.shape}, not (1, 5, {anchors(size)})")
        actual = suppress(predictions)
        if len(actual) != len(expected):
            raise SystemExit(f"{path.name}: {len(actual)} detections after suppression, the published graph has {len(expected)}")
        box_error = np.abs(actual[:, :4] - expected[:, 1:5]).max(initial=0.0)
        score_error = np.abs(actual[:, 4] - expected[:, 6]).max(initial=0.0)
        if box_error > 1e-3 or score_error > 1e-6:
            raise SystemExit(f"{path.name}: boxes differ by {box_error:.2e} px and scores by {score_error:.2e}")
        plates += int((expected[:, 6] >= 0.4).sum())
    print(f"Detector at {size}: the cut graph reproduces the published one's {plates} plates on {len(images)} samples")
    return plates


def check_recognizer(model: bytes, config_text: bytes) -> dict:
    config = yaml.safe_load(config_text)
    expected = {
        "alphabet": ALPHABET,
        "pad_char": PAD,
        "max_plate_slots": SLOTS,
        "img_height": HEIGHT,
        "img_width": WIDTH,
        "image_color_mode": "rgb",
        "keep_aspect_ratio": False,
        "interpolation": "linear",
        "plate_regions": REGIONS,
    }
    for key, value in expected.items():
        if config.get(key) != value:
            raise SystemExit(f"the recognizer's {key} is {config.get(key)!r}, but the pipeline is built for {value!r}")
    options = ort.SessionOptions()
    options.log_severity_level = 3
    session = ort.InferenceSession(model, options, providers=["CPUExecutionProvider"])
    (model_input,) = session.get_inputs()
    if model_input.type != "tensor(uint8)" or model_input.shape[1:] != [HEIGHT, WIDTH, 3]:
        raise SystemExit(f"the recognizer takes {model_input.type} {model_input.shape}, not uint8 [n, 64, 128, 3]")
    plate, region = session.run(["plate", "region"], {model_input.name: np.zeros((2, HEIGHT, WIDTH, 3), np.uint8)})
    if plate.shape != (2, SLOTS, len(ALPHABET)) or region.shape != (2, len(REGIONS)):
        raise SystemExit(f"the recognizer's outputs are {plate.shape} and {region.shape}")
    if not np.allclose(plate.sum(-1), 1, atol=1e-4) or not np.allclose(region.sum(-1), 1, atol=1e-4):
        raise SystemExit("the recognizer's outputs are not probabilities")
    print(f"Recognizer: {SLOTS} slots of {len(ALPHABET)} symbols, {len(REGIONS)} regions, as the pipeline expects")
    return {key: expected[key] for key in ("alphabet", "pad_char", "max_plate_slots", "img_height", "img_width")} | {
        "regions": REGIONS
    }


def prepare(directory: Path, samples: Path) -> dict:
    directory.mkdir(parents=True, exist_ok=True)
    manifest = {}
    for name, (size, source) in DETECTORS.items():
        end_to_end = fetch(source)
        with tempfile.TemporaryDirectory() as scratch:
            detector = cut_detector(end_to_end, Path(scratch), source)
        check_detector(end_to_end, detector, samples, size)
        (directory / f"{name}.onnx").write_bytes(detector)
        manifest[name] = {
            "file": f"{name}.onnx",
            "bytes": len(detector),
            "sha256": sha256(detector),
            "input": {"name": "images", "shape": [1, 3, size, size], "type": "float32"},
            "output": {"name": "predictions", "shape": [1, 5, anchors(size)], "type": "float32"},
            "source": source,
        }
    recognizer = fetch(RECOGNIZER)
    config = check_recognizer(recognizer, fetch(RECOGNIZER_CONFIG))
    (directory / "recognizer.onnx").write_bytes(recognizer)
    return manifest | {
        "recognizer": {
            "file": "recognizer.onnx",
            "bytes": len(recognizer),
            "sha256": sha256(recognizer),
            "input": {"name": "input", "shape": ["n", HEIGHT, WIDTH, 3], "type": "uint8"},
            "outputs": [
                {"name": "plate", "shape": ["n", SLOTS, len(ALPHABET)], "type": "float32"},
                {"name": "region", "shape": ["n", len(REGIONS)], "type": "float32"},
            ],
            "config": config,
            "source": RECOGNIZER | {"config_url": RECOGNIZER_CONFIG["url"], "config_sha256": RECOGNIZER_CONFIG["sha256"]},
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--check", action="store_true", help="prepare again and require models/manifest.json's hashes")
    parser.add_argument("--images", type=Path, default=SAMPLES, help="JPEGs to check the detector on (default: samples/)")
    args = parser.parse_args()

    manifest = prepare(MODELS, args.images)
    text = json.dumps(manifest, indent=2) + "\n"
    path = MODELS / "manifest.json"
    if args.check:
        committed = json.loads(path.read_text())
        for name in manifest:
            if committed.get(name, {}).get("sha256") != manifest[name]["sha256"]:
                sys.exit(f"models/{name}.onnx came out as {manifest[name]['sha256']}, not as models/manifest.json has it")
        if path.read_text() != text:
            sys.exit("models/manifest.json is out of date: run tools/prepare_models.py")
        print("The prepared models match models/manifest.json")
        return
    path.write_text(text)
    for name in manifest:
        print(f"models/{manifest[name]['file']}: {manifest[name]['bytes']:,} bytes, sha256 {manifest[name]['sha256']}")


if __name__ == "__main__":
    main()
