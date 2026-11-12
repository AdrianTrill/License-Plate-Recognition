#pragma once

#include <cstddef>
#include <span>
#include <vector>

#include "lpr/image.hpp"

namespace lpr {

// An axis-aligned box in pixel coordinates, corners at (x1, y1) and (x2, y2).
struct Box {
    float x1 = 0.0F;
    float y1 = 0.0F;
    float x2 = 0.0F;
    float y2 = 0.0F;

    [[nodiscard]] float width() const noexcept {
        return x2 - x1;
    }
    [[nodiscard]] float height() const noexcept {
        return y2 - y1;
    }
    [[nodiscard]] float area() const noexcept;
    friend bool operator==(const Box&, const Box&) = default;
};

// Intersection over union; 0 when either box is empty.
float iou(const Box& a, const Box& b) noexcept;

struct Detection {
    Box box;             // in the source image's pixels, clipped to it
    float score = 0.0F;  // the detector's confidence that the box holds a plate
};

// How an image sits in the detector's square input: scaled to fit, centered, and padded with gray, as YOLO models
// are trained.
struct Letterbox {
    int size = 0;          // the input's side
    int source_width = 0;  // the image's size
    int source_height = 0;
    int width = 0;  // the scaled image's size, and its top-left corner, in the input
    int height = 0;
    int left = 0;
    int top = 0;

    // A box in input pixels mapped back onto the image, by inverting the resize exactly.
    [[nodiscard]] Box to_source(const Box& box) const noexcept;
};

// The letterbox YOLOv9's reference preprocessing uses: scale by min(size / height, size / width), round the scaled size
// half to even, and split the padding with the extra pixel at the bottom and right.
Letterbox letterbox_geometry(int source_width, int source_height, int size);

// The gray of the padding, as YOLO models are trained.
inline constexpr std::uint8_t kLetterboxGray = 114;

// Writes the detector's input, a [1, 3, size, size] float tensor of RGB planes in [0, 1], for an image. `scratch`
// holds the scaled image between calls, so a video reuses one buffer.
void letterbox_into(ImageView image,
                    const Letterbox& letterbox,
                    std::span<float> tensor,
                    std::vector<std::uint8_t>& scratch);

// The number of predictions a YOLOv9 head makes for a square input: one per cell at strides 8, 16, and 32.
std::size_t anchor_count(int size) noexcept;

struct DetectorOptions {
    float score_threshold = 0.4F;  // fast-alpr's default
    float iou_threshold = 0.45F;   // the exported model's own non-maximum suppression
    std::size_t max_detections = 100;
};

// Greedy non-maximum suppression: visit boxes from the highest score down, keeping each box that overlaps no kept box
// by more than `iou_threshold`. Returns the kept indices, highest score first; ties keep their original order.
std::vector<std::size_t> non_max_suppression(std::span<const Box> boxes,
                                             std::span<const float> scores,
                                             float iou_threshold,
                                             std::size_t max_kept);

// Plates from the detector's raw output, [1, 5, anchors]: rows of box centers, sizes, and scores, in input pixels.
// Boxes at or above the score threshold go through non-maximum suppression, then back onto the image.
std::vector<Detection> decode_detections(std::span<const float> predictions,
                                         const Letterbox& letterbox,
                                         const DetectorOptions& options);

}  // namespace lpr
