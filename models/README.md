# Models

The pipeline runs a detector and a reader, from pinned upstream releases, all MIT-licensed:

| File | Network | From | Size |
| --- | --- | --- | --- |
| `detector.onnx` | YOLOv9-t license plate detector, 384×384 input | [open-image-models](https://github.com/ankandrew/open-image-models) (`yolo-v9-t-384-license-plate-end2end`) | 7.8 MB |
| `detector-640.onnx` | The same detector at 640×640, which finds smaller plates and takes about two and a half times as long; chosen with `--small-plates`, or in the demo's settings | [open-image-models](https://github.com/ankandrew/open-image-models) (`yolo-v9-t-640-license-plate-end2end`) | 7.8 MB |
| `recognizer.onnx` | Compact Convolutional Transformer plate reader, 64×128 RGB input, 10 character slots, 66 regions | [fast-plate-ocr](https://github.com/ankandrew/fast-plate-ocr) (`cct-s-v2-global-model`) | 5.3 MB |

The ONNX files are not in the repository. [`tools/prepare_models.py`](../tools/prepare_models.py) downloads the upstream releases, checks them against their pinned SHA-256 hashes, and writes them here; the browser demo serves the same files, which `cmake -DLPR_DOWNLOAD_MODELS=ON` can fetch instead. [`manifest.json`](manifest.json) records their hashes, shapes, sources, and the reader's configuration.

Each detector is published "end to end", with non-maximum suppression inside the graph. The pipeline does that step itself, in C++ (`src/detector.cpp`), so the tool cuts the graph where the detection head ends, at `/model/model.22/Concat_5_output_0`: the output, `predictions`, is `[1, 5, 3024]` at 384 pixels and `[1, 5, 8400]` at 640, box centers, sizes, and plate scores for every anchor, in input pixels. The tool refuses to write a cut graph unless it, followed by the pipeline's suppression, finds exactly the published graph's plates on every sample image. The reader is used as published.

## Licenses

The networks are redistributed here and on the demo's site under the MIT License of their projects:

```text
MIT License

Copyright (c) 2024 ankandrew

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

This notice covers both [open-image-models](https://github.com/ankandrew/open-image-models/blob/main/LICENSE) and [fast-plate-ocr](https://github.com/ankandrew/fast-plate-ocr/blob/master/LICENSE), which carry the same text and copyright line. The detector was trained with [YOLOv9](https://github.com/WongKinYiu/yolov9) (Wang and Liao, 2024).
