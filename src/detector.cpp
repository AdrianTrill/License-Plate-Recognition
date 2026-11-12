#include "lpr/detector.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <numeric>
#include <stdexcept>

namespace lpr {

namespace {

// Pixel values in [0, 1] as YOLOv9's preprocessing computes them, in double precision, then rounded to float once.
const std::array<float, 256>& unit_values() {
    static const std::array<float, 256> values = [] {
        std::array<float, 256> table{};
        for (std::size_t i = 0; i < table.size(); ++i) {
            table[i] = static_cast<float>(static_cast<double>(i) / 255.0);
        }
        return table;
    }();
    return values;
}

Box clip(const Box& box, int width, int height) noexcept {
    const auto w = static_cast<float>(width);
    const auto h = static_cast<float>(height);
    return Box{std::clamp(box.x1, 0.0F, w),
               std::clamp(box.y1, 0.0F, h),
               std::clamp(box.x2, 0.0F, w),
               std::clamp(box.y2, 0.0F, h)};
}

}  // namespace

float Box::area() const noexcept {
    return std::max(0.0F, width()) * std::max(0.0F, height());
}

float iou(const Box& a, const Box& b) noexcept {
    const float overlap_width = std::min(a.x2, b.x2) - std::max(a.x1, b.x1);
    const float overlap_height = std::min(a.y2, b.y2) - std::max(a.y1, b.y1);
    if (overlap_width <= 0.0F || overlap_height <= 0.0F) {
        return 0.0F;
    }
    const float intersection = overlap_width * overlap_height;
    const float united = a.area() + b.area() - intersection;
    return united > 0.0F ? intersection / united : 0.0F;
}

Box Letterbox::to_source(const Box& box) const noexcept {
    const float scale_x = static_cast<float>(source_width) / static_cast<float>(width);
    const float scale_y = static_cast<float>(source_height) / static_cast<float>(height);
    const auto x0 = static_cast<float>(left);
    const auto y0 = static_cast<float>(top);
    return Box{(box.x1 - x0) * scale_x, (box.y1 - y0) * scale_y, (box.x2 - x0) * scale_x, (box.y2 - y0) * scale_y};
}

Letterbox letterbox_geometry(int source_width, int source_height, int size) {
    if (source_width <= 0 || source_height <= 0 || size <= 0) {
        throw std::invalid_argument("letterbox sizes must be positive");
    }
    const double scale = std::min(static_cast<double>(size) / static_cast<double>(source_height),
                                  static_cast<double>(size) / static_cast<double>(source_width));
    Letterbox letterbox;
    letterbox.size = size;
    letterbox.source_width = source_width;
    letterbox.source_height = source_height;
    // nearbyint rounds half to even, as Python's round() does in the reference implementation.
    letterbox.width = std::clamp(static_cast<int>(std::nearbyint(source_width * scale)), 1, size);
    letterbox.height = std::clamp(static_cast<int>(std::nearbyint(source_height * scale)), 1, size);
    letterbox.left = static_cast<int>(std::lround(((size - letterbox.width) / 2.0) - 0.1));
    letterbox.top = static_cast<int>(std::lround(((size - letterbox.height) / 2.0) - 0.1));
    return letterbox;
}

void letterbox_into(ImageView image,
                    const Letterbox& letterbox,
                    std::span<float> tensor,
                    std::vector<std::uint8_t>& scratch) {
    if (image.width != letterbox.source_width || image.height != letterbox.source_height) {
        throw std::invalid_argument("the letterbox was computed for an image of another size");
    }
    const auto side = static_cast<std::size_t>(letterbox.size);
    const std::size_t plane = side * side;
    if (tensor.size() < 3 * plane) {
        throw std::invalid_argument("the detector's input tensor is too small");
    }
    const auto width = static_cast<std::size_t>(letterbox.width);
    const auto height = static_cast<std::size_t>(letterbox.height);
    scratch.resize(width * height * 3U);
    resize_into(image, letterbox.width, letterbox.height, scratch);

    const std::array<float, 256>& unit = unit_values();
    std::fill_n(tensor.begin(), 3 * plane, unit[kLetterboxGray]);
    const auto left = static_cast<std::size_t>(letterbox.left);
    const auto top = static_cast<std::size_t>(letterbox.top);
    for (std::size_t y = 0; y < height; ++y) {
        const std::uint8_t* pixel = scratch.data() + (y * width * 3U);
        const std::size_t offset = ((top + y) * side) + left;
        float* red = tensor.data() + offset;
        float* green = red + plane;
        float* blue = green + plane;
        for (std::size_t x = 0; x < width; ++x, pixel += 3) {
            red[x] = unit[pixel[0]];
            green[x] = unit[pixel[1]];
            blue[x] = unit[pixel[2]];
        }
    }
}

std::size_t anchor_count(int size) noexcept {
    std::size_t count = 0;
    for (const int stride : {8, 16, 32}) {
        const auto cells = static_cast<std::size_t>(size / stride);
        count += cells * cells;
    }
    return count;
}

std::vector<std::size_t> non_max_suppression(std::span<const Box> boxes,
                                             std::span<const float> scores,
                                             float iou_threshold,
                                             std::size_t max_kept) {
    if (boxes.size() != scores.size()) {
        throw std::invalid_argument("every box needs a score");
    }
    std::vector<std::size_t> order(boxes.size());
    std::iota(order.begin(), order.end(), std::size_t{0});
    std::stable_sort(order.begin(), order.end(), [&](std::size_t a, std::size_t b) { return scores[a] > scores[b]; });

    std::vector<std::size_t> kept;
    for (const std::size_t candidate : order) {
        if (kept.size() >= max_kept) {
            break;
        }
        const bool overlaps = std::any_of(kept.begin(), kept.end(), [&](std::size_t chosen) {
            return iou(boxes[candidate], boxes[chosen]) > iou_threshold;
        });
        if (!overlaps) {
            kept.push_back(candidate);
        }
    }
    return kept;
}

std::vector<Detection> decode_detections(std::span<const float> predictions,
                                         const Letterbox& letterbox,
                                         const DetectorOptions& options) {
    if (predictions.empty() || predictions.size() % 5 != 0) {
        throw std::invalid_argument("the detector's output must be [1, 5, anchors]");
    }
    const std::size_t anchors = predictions.size() / 5;
    const float* center_x = predictions.data();
    const float* center_y = center_x + anchors;
    const float* box_width = center_y + anchors;
    const float* box_height = box_width + anchors;
    const float* score = box_height + anchors;

    std::vector<Box> boxes;
    std::vector<float> scores;
    for (std::size_t i = 0; i < anchors; ++i) {
        if (!(score[i] >= options.score_threshold) || !std::isfinite(score[i])) {
            continue;
        }
        const float half_width = 0.5F * box_width[i];
        const float half_height = 0.5F * box_height[i];
        boxes.push_back(Box{center_x[i] - half_width,
                            center_y[i] - half_height,
                            center_x[i] + half_width,
                            center_y[i] + half_height});
        scores.push_back(score[i]);
    }

    std::vector<Detection> detections;
    for (const std::size_t kept : non_max_suppression(boxes, scores, options.iou_threshold, options.max_detections)) {
        const Box box = clip(letterbox.to_source(boxes[kept]), letterbox.source_width, letterbox.source_height);
        if (box.width() > 0.0F && box.height() > 0.0F) {
            detections.push_back(Detection{box, scores[kept]});
        }
    }
    return detections;
}

}  // namespace lpr
