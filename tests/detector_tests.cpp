#include "lpr/detector.hpp"

#include <array>
#include <cmath>
#include <limits>
#include <string>
#include <vector>

#include "check.hpp"

namespace {

using check::expect;
using check::expect_equal;
using check::expect_near;

// A detector output with the given plates, [1, 5, anchors]: center x, center y, width, height, and score rows.
std::vector<float> predictions(std::size_t anchors, const std::vector<std::array<float, 5>>& plates) {
    std::vector<float> values(5 * anchors, 0.0F);
    for (std::size_t i = 0; i < plates.size(); ++i) {
        for (std::size_t row = 0; row < 5; ++row) {
            values[(row * anchors) + i] = plates[i][row];
        }
    }
    return values;
}

void expect_box(const lpr::Box& box, const lpr::Box& expected, const std::string& message) {
    expect_near(box.x1, expected.x1, 1e-3, message + ": x1");
    expect_near(box.y1, expected.y1, 1e-3, message + ": y1");
    expect_near(box.x2, expected.x2, 1e-3, message + ": x2");
    expect_near(box.y2, expected.y2, 1e-3, message + ": y2");
}

}  // namespace

int main() {
    return check::run({
        {"intersection over union",
         [] {
             const lpr::Box a{0, 0, 10, 10};
             expect_near(lpr::iou(a, a), 1.0, 1e-6, "a box with itself");
             expect_near(lpr::iou(a, lpr::Box{5, 0, 15, 10}), 50.0 / 150.0, 1e-6, "half overlapping");
             expect_equal(lpr::iou(a, lpr::Box{10, 0, 20, 10}), 0.0F, "touching edges");
             expect_equal(lpr::iou(a, lpr::Box{3, 3, 3, 8}), 0.0F, "an empty box");
         }},
        {"the letterbox scales to fit and centers, as YOLOv9's reference does",
         [] {
             const lpr::Letterbox landscape = lpr::letterbox_geometry(1600, 1067, 384);
             expect_equal(landscape.width, 384, "width");
             expect_equal(landscape.height, 256, "height: 1067 * 0.24 = 256.08");
             expect_equal(landscape.left, 0, "left");
             expect_equal(landscape.top, 64, "top");
             const lpr::Letterbox portrait = lpr::letterbox_geometry(1067, 1600, 384);
             expect_equal(portrait.width, 256, "portrait width");
             expect_equal(portrait.left, 64, "portrait left");
             const lpr::Letterbox odd = lpr::letterbox_geometry(1000, 999, 384);
             expect_equal(odd.height, 384, "999 * 0.384 = 383.616 rounds to 384");
             const lpr::Letterbox padded = lpr::letterbox_geometry(640, 357, 384);
             expect_equal(padded.height, 214, "357 * 0.6 = 214.2");
             expect_equal(padded.top, 85, "an odd padding of 170 splits 85 above");
         }},
        {"the letterbox rounds halves to even, like Python",
         [] {
             expect_equal(lpr::letterbox_geometry(768, 3, 384).height, 2, "1.5 rounds to 2");
             expect_equal(lpr::letterbox_geometry(768, 5, 384).height, 2, "2.5 rounds to 2");
             expect_equal(lpr::letterbox_geometry(768, 7, 384).height, 4, "3.5 rounds to 4");
         }},
        {"letterboxed boxes map back onto the image",
         [] {
             const lpr::Letterbox letterbox = lpr::letterbox_geometry(768, 384, 384);
             expect_equal(letterbox.top, 96, "top");
             expect_box(letterbox.to_source(lpr::Box{0, 96, 384, 288}), lpr::Box{0, 0, 768, 384}, "the whole image");
             expect_box(letterbox.to_source(lpr::Box{142, 182, 242, 202}), lpr::Box{284, 172, 484, 212}, "a plate");
         }},
        {"the detector's input is RGB planes in [0, 1], padded with YOLO gray",
         [] {
             lpr::Image image(4, 2);
             for (std::size_t i = 0; i < image.pixels().size(); i += 3) {
                 image.pixels()[i] = 255;
                 image.pixels()[i + 1] = 0;
                 image.pixels()[i + 2] = 51;
             }
             const lpr::Letterbox letterbox = lpr::letterbox_geometry(4, 2, 32);
             std::vector<float> tensor(3 * 32 * 32);
             std::vector<std::uint8_t> scratch;
             lpr::letterbox_into(image.view(), letterbox, tensor, scratch);
             const float gray = static_cast<float>(114.0 / 255.0);
             expect_equal(tensor[0], gray, "the top-left corner is padding");
             const std::size_t inside = (16 * 32) + 16;
             expect_equal(tensor[inside], 1.0F, "red");
             expect_equal(tensor[(32 * 32) + inside], 0.0F, "green");
             expect_equal(tensor[(2 * 32 * 32) + inside], static_cast<float>(51.0 / 255.0), "blue");
             check::expect_throws<std::invalid_argument>(
                 [&] { lpr::letterbox_into(image.view(), lpr::letterbox_geometry(5, 2, 32), tensor, scratch); },
                 "a letterbox for another image");
         }},
        {"YOLOv9 heads predict at three strides",
         [] {
             expect_equal(lpr::anchor_count(384), std::size_t{3024}, "384");
             expect_equal(lpr::anchor_count(640), std::size_t{8400}, "640");
         }},
        {"non-maximum suppression keeps the best of overlapping boxes",
         [] {
             const std::vector<lpr::Box> boxes{{0, 0, 10, 10},
                                               {1, 0, 11, 10},
                                               {20, 0, 30, 10},
                                               {0, 0, 10, 10},
                                               {21, 0, 31, 10}};
             const std::vector<float> scores{0.8F, 0.9F, 0.7F, 0.9F, 0.75F};
             const std::vector<std::size_t> kept = lpr::non_max_suppression(boxes, scores, 0.45F, 10);
             expect_equal(kept.size(), std::size_t{2}, "two clusters");
             expect_equal(kept[0], std::size_t{1}, "ties keep their order: box 1 before box 3");
             expect_equal(kept[1], std::size_t{4}, "the better of the second cluster");
             expect_equal(lpr::non_max_suppression(boxes, scores, 0.45F, 1).size(), std::size_t{1}, "capped");
             // Boxes overlapping by exactly the threshold survive: only larger overlaps suppress.
             const std::vector<lpr::Box> pair{{0, 0, 10, 10}, {0, 0, 10, 5}};
             const std::vector<float> pair_scores{0.9F, 0.8F};
             expect_equal(lpr::non_max_suppression(pair, pair_scores, 0.5F, 10).size(), std::size_t{2}, "IoU 0.5");
             expect_equal(lpr::non_max_suppression(pair, pair_scores, 0.49F, 10).size(), std::size_t{1}, "IoU > 0.49");
         }},
        {"decoding keeps confident boxes and maps them onto the image",
         [] {
             const lpr::Letterbox letterbox = lpr::letterbox_geometry(768, 384, 384);
             const std::vector<float> raw = predictions(16,
                                                        {
                                                            {192, 192, 100, 20, 0.9F},
                                                            {194, 192, 100, 20, 0.85F},  // the same plate, suppressed
                                                            {300, 250, 40, 10, 0.39F},   // below the threshold
                                                            {20, 100, 60, 14, 0.5F},     // partly off the image
                                                            {300, 150, 40, 10, std::numeric_limits<float>::quiet_NaN()},
                                                        });
             const std::vector<lpr::Detection> detections = lpr::decode_detections(raw, letterbox, {});
             expect_equal(detections.size(), std::size_t{2}, "detections");
             expect_box(detections[0].box, lpr::Box{284, 172, 484, 212}, "the plate");
             expect_near(detections[0].score, 0.9, 1e-6, "its score");
             expect_box(detections[1].box, lpr::Box{0, 0, 100, 22}, "clipped to the image");
             lpr::DetectorOptions lenient;
             lenient.score_threshold = 0.3F;
             expect_equal(lpr::decode_detections(raw, letterbox, lenient).size(), std::size_t{3}, "a lower threshold");
             check::expect_throws<std::invalid_argument>(
                 [&] { (void)lpr::decode_detections(std::vector<float>(7), letterbox, {}); },
                 "a malformed output");
         }},
    });
}
