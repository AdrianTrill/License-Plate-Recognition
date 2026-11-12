#include "lpr/image.hpp"

#include <array>
#include <cstdint>
#include <cstdlib>
#include <string>
#include <vector>

#include "check.hpp"

namespace {

using check::expect;
using check::expect_equal;

// The pseudo-random image the OpenCV fixtures below were computed from.
lpr::Image noise(int width, int height) {
    std::uint64_t state = 12345;
    lpr::Image image(width, height);
    for (std::uint8_t& value : image.pixels()) {
        state = ((1103515245ULL * state) + 12345ULL) % (1ULL << 31U);
        value = static_cast<std::uint8_t>((state >> 16U) & 255U);
    }
    return image;
}

// cv2.resize(noise(7, 5), (width, height), interpolation=cv2.INTER_LINEAR), from OpenCV 5.0.
const std::vector<int> kOpenCv3x4{167, 27,  149, 206, 159, 39,  165, 83,  155, 47,  119, 117,
                                  78,  59,  81,  163, 84,  153, 99,  180, 60,  53,  74,  100,
                                  87,  141, 173, 179, 150, 116, 184, 59,  100, 219, 201, 139};
const std::vector<int> kOpenCv5x2{72,  108, 112, 111, 31,  102, 90, 96, 97,  134, 81,  175, 199, 28,  136,
                                  190, 117, 139, 114, 105, 126, 54, 84, 136, 105, 171, 211, 104, 142, 136};

void expect_close_to_opencv(const lpr::Image& actual, const std::vector<int>& expected, const std::string& name) {
    expect_equal(actual.pixels().size(), expected.size(), name + ": size");
    int largest = 0;
    for (std::size_t i = 0; i < expected.size(); ++i) {
        largest = std::max(largest, std::abs(static_cast<int>(actual.pixels()[i]) - expected[i]));
    }
    expect(largest <= 1, name + ": differs from OpenCV's INTER_LINEAR by up to " + std::to_string(largest));
}

}  // namespace

int main() {
    return check::run({
        {"resizing to the same size copies the image",
         [] {
             const lpr::Image source = noise(9, 6);
             const lpr::Image copy = lpr::resize(source.view(), 9, 6);
             expect(std::equal(copy.pixels().begin(), copy.pixels().end(), source.pixels().begin()),
                    "an identity resize should not change a byte");
         }},
        {"a flat image stays flat at any size",
         [] {
             const lpr::Image gray(13, 7, 114);
             for (const auto& [w, h] : std::vector<std::pair<int, int>>{{1, 1}, {5, 3}, {384, 211}, {26, 14}}) {
                 const lpr::Image resized = lpr::resize(gray.view(), w, h);
                 for (const std::uint8_t value : resized.pixels()) {
                     expect_equal(static_cast<int>(value), 114, "flat gray");
                 }
             }
         }},
        {"upscaling interpolates between pixel centers",
         [] {
             const lpr::Image row(2, 1, std::vector<std::uint8_t>{0, 0, 0, 100, 100, 100});
             const lpr::Image wide = lpr::resize(row.view(), 4, 1);
             const std::array<int, 4> expected{0, 25, 75, 100};
             for (std::size_t x = 0; x < expected.size(); ++x) {
                 expect_equal(static_cast<int>(wide.pixels()[x * 3]), expected[x], "pixel " + std::to_string(x));
             }
         }},
        {"halving averages pairs, rounding half up",
         [] {
             const lpr::Image row(4, 1, std::vector<std::uint8_t>{10, 10, 10, 21, 21, 21, 30, 30, 30, 41, 41, 41});
             const lpr::Image half = lpr::resize(row.view(), 2, 1);
             expect_equal(static_cast<int>(half.pixels()[0]), 16, "(10 + 21) / 2");
             expect_equal(static_cast<int>(half.pixels()[3]), 36, "(30 + 41) / 2");
         }},
        {"resizing matches OpenCV's INTER_LINEAR within one level",
         [] {
             const lpr::Image source = noise(7, 5);
             expect_close_to_opencv(lpr::resize(source.view(), 3, 4), kOpenCv3x4, "7x5 to 3x4");
             expect_close_to_opencv(lpr::resize(source.view(), 5, 2), kOpenCv5x2, "7x5 to 5x2");
         }},
        {"RGBA views resize like their RGB pixels",
         [] {
             const lpr::Image rgb = noise(10, 8);
             std::vector<std::uint8_t> rgba;
             for (std::size_t i = 0; i < rgb.pixels().size(); i += 3) {
                 rgba.insert(rgba.end(), {rgb.pixels()[i], rgb.pixels()[i + 1], rgb.pixels()[i + 2], 255});
             }
             const lpr::ImageView view = lpr::packed_view(rgba, 10, 8, lpr::PixelFormat::rgba);
             const lpr::Image a = lpr::resize(rgb.view(), 7, 3);
             const lpr::Image b = lpr::resize(view, 7, 3);
             expect(std::equal(a.pixels().begin(), a.pixels().end(), b.pixels().begin()), "RGBA and RGB should agree");
         }},
        {"subviews read the region in place",
         [] {
             const lpr::Image source = noise(8, 6);
             const lpr::ImageView region = lpr::subview(source.view(), lpr::Rect{2, 3, 4, 2});
             expect_equal(region.width, 4, "width");
             expect_equal(region.height, 2, "height");
             expect(region.row(1)[0] == source.view().row(4)[6], "the region's pixels are the image's");
             const lpr::Image copy = lpr::to_image(region);
             expect_equal(static_cast<int>(copy.pixels()[3]), static_cast<int>(source.view().row(3)[9]), "a copy");
             check::expect_throws<std::out_of_range>([&] { (void)lpr::subview(source.view(), lpr::Rect{6, 0, 3, 1}); },
                                                     "a region past the right edge");
             check::expect_throws<std::out_of_range>([&] { (void)lpr::subview(source.view(), lpr::Rect{0, 0, 0, 1}); },
                                                     "an empty region");
         }},
        {"bad sizes are rejected",
         [] {
             const lpr::Image source = noise(4, 4);
             std::vector<std::uint8_t> small(10);
             check::expect_throws<std::invalid_argument>([&] { lpr::resize_into(source.view(), 4, 4, small); },
                                                         "an output buffer too small");
             check::expect_throws<std::invalid_argument>([&] { (void)lpr::resize(source.view(), 0, 4); },
                                                         "a zero width");
             check::expect_throws<std::invalid_argument>([&] { (void)lpr::resize(lpr::ImageView{}, 4, 4); },
                                                         "an empty source");
             check::expect_throws<std::invalid_argument>(
                 [&] { (void)lpr::packed_view(small, 4, 4, lpr::PixelFormat::rgb); },
                 "a view past its buffer");
         }},
        {"EXIF orientations turn images upright",
         [] {
             // A 3x2 image whose pixels are numbered 0 to 5, row by row.
             std::vector<std::uint8_t> pixels;
             for (std::uint8_t i = 0; i < 6; ++i) {
                 pixels.insert(pixels.end(), {i, i, i});
             }
             const lpr::Image source(3, 2, pixels);
             const auto order = [](const lpr::Image& image) {
                 std::string text;
                 for (std::size_t i = 0; i < image.pixels().size(); i += 3) {
                     text += static_cast<char>('0' + image.pixels()[i]);
                 }
                 return text + "/" + std::to_string(image.width()) + "x" + std::to_string(image.height());
             };
             // 012    orientation 6 turns it clockwise: 30 41 52; 8 counterclockwise: 25 14 03.
             // 345
             const std::array<std::string, 9> expected{"",
                                                       "012345/3x2",
                                                       "210543/3x2",
                                                       "543210/3x2",
                                                       "345012/3x2",
                                                       "031425/2x3",
                                                       "304152/2x3",
                                                       "524130/2x3",
                                                       "251403/2x3"};
             for (int orientation = 1; orientation <= 8; ++orientation) {
                 expect_equal(order(lpr::apply_orientation(source.view(), orientation)),
                              expected.at(static_cast<std::size_t>(orientation)),
                              "orientation " + std::to_string(orientation));
             }
             expect_equal(order(lpr::apply_orientation(source.view(), 0)), std::string("012345/3x2"), "no orientation");
         }},
        {"fingerprints are FNV-1a",
         [] {
             const std::vector<std::uint8_t> empty;
             const std::vector<std::uint8_t> a{'a'};
             expect_equal(lpr::fingerprint(std::span<const std::uint8_t>(empty)), 14695981039346656037ULL, "empty");
             expect_equal(lpr::fingerprint(std::span<const std::uint8_t>(a)), 0xaf63dc4c8601ec8cULL, "'a'");
             const std::vector<float> one{1.0F};
             const std::vector<std::uint8_t> one_bytes{0x00, 0x00, 0x80, 0x3F};
             expect_equal(lpr::fingerprint(std::span<const float>(one)),
                          lpr::fingerprint(std::span<const std::uint8_t>(one_bytes)),
                          "floats hash as their little-endian bytes");
         }},
    });
}
