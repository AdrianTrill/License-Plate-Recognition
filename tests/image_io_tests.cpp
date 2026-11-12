#include "lpr/image_io.hpp"

#include <cstdint>
#include <filesystem>
#include <string>
#include <vector>

#include "check.hpp"

namespace {

using check::expect;
using check::expect_equal;

// An APP1 segment holding an EXIF orientation, in either byte order.
std::vector<std::uint8_t> exif_segment(int orientation, bool little_endian) {
    const auto u16 = [&](std::vector<std::uint8_t>& out, unsigned value) {
        if (little_endian) {
            out.insert(out.end(), {static_cast<std::uint8_t>(value & 0xFFU), static_cast<std::uint8_t>(value >> 8U)});
        } else {
            out.insert(out.end(), {static_cast<std::uint8_t>(value >> 8U), static_cast<std::uint8_t>(value & 0xFFU)});
        }
    };
    const auto u32 = [&](std::vector<std::uint8_t>& out, unsigned value) {
        if (little_endian) {
            u16(out, value & 0xFFFFU);
            u16(out, value >> 16U);
        } else {
            u16(out, value >> 16U);
            u16(out, value & 0xFFFFU);
        }
    };
    std::vector<std::uint8_t> tiff;
    tiff.insert(
        tiff.end(),
        little_endian ? std::initializer_list<std::uint8_t>{'I', 'I'} : std::initializer_list<std::uint8_t>{'M', 'M'});
    u16(tiff, 42);
    u32(tiff, 8);
    u16(tiff, 2);  // two entries: something else first, then the orientation
    u16(tiff, 0x010F);
    u16(tiff, 2);
    u32(tiff, 4);
    u32(tiff, 0);
    u16(tiff, 0x0112);
    u16(tiff, 3);
    u32(tiff, 1);
    u16(tiff, static_cast<unsigned>(orientation));
    u16(tiff, 0);
    u32(tiff, 0);

    std::vector<std::uint8_t> segment{0xFF, 0xE1};
    const std::size_t length = 2 + 6 + tiff.size();
    segment.push_back(static_cast<std::uint8_t>(length >> 8U));
    segment.push_back(static_cast<std::uint8_t>(length & 0xFFU));
    segment.insert(segment.end(), {'E', 'x', 'i', 'f', 0, 0});
    segment.insert(segment.end(), tiff.begin(), tiff.end());
    return segment;
}

lpr::Image pattern(int width, int height) {
    lpr::Image image(width, height);
    for (std::size_t i = 0; i < image.pixels().size(); ++i) {
        image.pixels()[i] = static_cast<std::uint8_t>((i * 37U) % 251U);
    }
    return image;
}

}  // namespace

int main() {
    return check::run({
        {"EXIF orientations are read in both byte orders",
         [] {
             for (const bool little_endian : {true, false}) {
                 std::vector<std::uint8_t> jpeg{0xFF, 0xD8};
                 const std::vector<std::uint8_t> segment = exif_segment(6, little_endian);
                 jpeg.insert(jpeg.end(), segment.begin(), segment.end());
                 jpeg.insert(jpeg.end(), {0xFF, 0xD9});
                 expect_equal(lpr::exif_orientation(jpeg), 6, little_endian ? "little-endian" : "big-endian");
             }
         }},
        {"anything without an orientation reads as upright",
         [] {
             expect_equal(lpr::exif_orientation(std::vector<std::uint8_t>{}), 1, "nothing");
             expect_equal(lpr::exif_orientation(std::vector<std::uint8_t>{0x89, 'P', 'N', 'G'}), 1, "a PNG");
             expect_equal(lpr::exif_orientation(std::vector<std::uint8_t>{0xFF, 0xD8, 0xFF, 0xE1, 0x40}), 1, "cut off");
             std::vector<std::uint8_t> bad{0xFF, 0xD8};
             const std::vector<std::uint8_t> segment = exif_segment(9, true);
             bad.insert(bad.end(), segment.begin(), segment.end());
             expect_equal(lpr::exif_orientation(bad), 1, "an orientation out of range");
         }},
        {"PNG round-trips exactly",
         [] {
             const lpr::Image image = pattern(31, 17);
             const lpr::Image decoded = lpr::decode_image(lpr::encode_png(image));
             expect_equal(decoded.width(), 31, "width");
             expect_equal(decoded.height(), 17, "height");
             expect(std::equal(decoded.pixels().begin(), decoded.pixels().end(), image.pixels().begin()), "pixels");
         }},
        {"JPEGs are turned upright by their EXIF orientation",
         [] {
             const std::vector<std::uint8_t> plain = lpr::encode_jpeg(pattern(48, 16), 95);
             std::vector<std::uint8_t> rotated(plain.begin(), plain.begin() + 2);
             const std::vector<std::uint8_t> segment = exif_segment(6, true);
             rotated.insert(rotated.end(), segment.begin(), segment.end());
             rotated.insert(rotated.end(), plain.begin() + 2, plain.end());
             const lpr::Image upright = lpr::decode_image(plain);
             const lpr::Image turned = lpr::decode_image(rotated);
             expect_equal(upright.width(), 48, "as stored");
             expect_equal(turned.width(), 16, "turned: width");
             expect_equal(turned.height(), 48, "turned: height");
             const lpr::Image expected = lpr::apply_orientation(upright.view(), 6);
             expect(std::equal(turned.pixels().begin(), turned.pixels().end(), expected.pixels().begin()), "pixels");
         }},
        {"files that are not images are rejected",
         [] {
             check::expect_throws<std::runtime_error>(
                 [] { (void)lpr::decode_image(std::vector<std::uint8_t>{1, 2, 3, 4, 5}); },
                 "noise");
             check::expect_throws<std::runtime_error>([] { (void)lpr::read_image("no/such/image.jpg"); }, "missing");
         }},
        {"the sample photos decode",
         [] {
             const std::filesystem::path samples(LPR_SAMPLES_DIR);
             int count = 0;
             for (const auto& entry : std::filesystem::directory_iterator(samples)) {
                 if (entry.path().extension() == ".jpg") {
                     const lpr::Image image = lpr::read_image(entry.path());
                     expect(image.width() >= 640 && image.height() >= 360, entry.path().filename().string());
                     ++count;
                 }
             }
             expect(count > 0, "samples/ has photos");
         }},
    });
}
