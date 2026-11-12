#include "lpr/recognizer.hpp"

#include <cmath>
#include <ostream>
#include <set>
#include <string>
#include <string_view>
#include <vector>

#include "check.hpp"
#include "readings.hpp"

namespace lpr {

std::ostream& operator<<(std::ostream& stream, const Rect& rect) {
    return stream << rect.x << ',' << rect.y << ' ' << rect.width << 'x' << rect.height;
}

}  // namespace lpr

namespace {

using check::expect;
using check::expect_equal;
using check::expect_near;

const lpr::RecognizerConfig& config = lpr::plate_recognizer_config();

}  // namespace

int main() {
    return check::run({
        {"the configuration is fast-plate-ocr's global one",
         [] {
             expect_equal(config.symbols(), std::size_t{37}, "symbols");
             expect_equal(config.alphabet.back(), config.pad, "padding is the last symbol");
             expect_equal(config.slots, 10, "slots");
             expect_equal(config.width, 128, "width");
             expect_equal(config.height, 64, "height");
             expect_equal(config.input_bytes(), std::size_t{64 * 128 * 3}, "input bytes");
             expect_equal(config.regions.size(), std::size_t{66}, "regions");
             expect_equal(config.regions.back().name, std::string_view("Unknown"), "the last region");
             std::set<std::string_view> codes;
             for (const lpr::Region& region : config.regions) {
                 expect(region.code.size() == 2 || region.name == "Unknown", std::string(region.name) + "'s code");
                 codes.insert(region.code);
             }
             expect_equal(codes.size(), config.regions.size(), "every region has its own code");
             expect_equal(config.regions[50].name, std::string_view("Romania"), "region 50");
             expect_equal(config.regions[50].code, std::string_view("RO"), "Romania's code");
         }},
        {"decoding takes each slot's likeliest symbol and trims the padding",
         [] {
             const lpr::PlateRead read =
                 lpr::decode_plate(readings::slots("CJ12ABC", 0.9F), readings::regions("Romania", 0.8F), config);
             expect_equal(read.text, std::string("CJ12ABC"), "text");
             expect_equal(read.characters.size(), std::size_t{7}, "characters");
             expect_equal(read.characters[0].character, 'C', "first character");
             expect_near(read.characters[0].confidence, 0.9, 1e-6, "its confidence");
             expect_near(read.confidence, std::pow(0.9, 10), 1e-5, "every slot counts, padding included");
             expect_equal(read.region, 50, "region");
             expect_near(read.region_confidence, 0.8, 1e-6, "region confidence");
             expect_equal(read.probabilities.size(), std::size_t{370}, "the probabilities are kept for fusion");
         }},
        {"alternatives are the next likeliest symbols",
         [] {
             std::vector<float> probabilities = readings::slots("B", 0.6F);
             const std::size_t eight = config.alphabet.find('8');
             const std::size_t d = config.alphabet.find('D');
             probabilities[eight] = 0.3F;
             probabilities[d] = 0.05F;
             const lpr::PlateRead read = lpr::decode_plate(probabilities, {}, config);
             expect_equal(read.text, std::string("B"), "text");
             expect_equal(read.characters[0].alternatives[0].character, '8', "the runner-up");
             expect_near(read.characters[0].alternatives[0].probability, 0.3, 1e-6, "its probability");
             expect_equal(read.characters[0].alternatives[1].character, 'D', "third");
             expect_equal(read.region, -1, "no region head");
         }},
        {"only trailing padding is trimmed",
         [] {
             expect_equal(lpr::decode_plate(readings::slots("AB_12", 0.9F), {}, config).text,
                          std::string("AB_12"),
                          "padding inside the text stays");
             expect_equal(lpr::decode_plate(readings::slots("", 0.9F), {}, config).text,
                          std::string(""),
                          "all padding");
         }},
        {"ties go to the earlier symbol, as argmax does",
         [] {
             std::vector<float> probabilities(370, 0.0F);
             for (std::size_t slot = 0; slot < 10; ++slot) {
                 probabilities[(slot * 37) + 36] = 1.0F;
             }
             probabilities[config.alphabet.find('O')] = 0.5F;
             probabilities[config.alphabet.find('0')] = 0.5F;
             probabilities[36] = 0.0F;
             expect_equal(lpr::decode_plate(probabilities, {}, config).text, std::string("0"), "0 comes before O");
         }},
        {"outputs of the wrong size are rejected",
         [] {
             check::expect_throws<std::invalid_argument>(
                 [] { (void)lpr::decode_plate(std::vector<float>(369), {}, config); },
                 "too few probabilities");
             check::expect_throws<std::invalid_argument>(
                 [] { (void)lpr::decode_plate(readings::slots("A", 0.9F), std::vector<float>(3), config); },
                 "too few regions");
         }},
        {"plate crops truncate the box to whole pixels within the image",
         [] {
             expect_equal(lpr::plate_region(lpr::Box{10.9F, 20.2F, 110.7F, 50.99F}, 640, 480),
                          lpr::Rect{10, 20, 100, 30},
                          "truncated");
             expect_equal(lpr::plate_region(lpr::Box{-5.0F, -1.0F, 700.0F, 30.0F}, 640, 480),
                          lpr::Rect{0, 0, 640, 30},
                          "clamped");
             expect(lpr::plate_region(lpr::Box{10.2F, 5.0F, 10.8F, 9.0F}, 640, 480).empty(), "thinner than a pixel");
         }},
        {"a plate's input fills the recognizer's 64x128 RGB frame",
         [] {
             lpr::Image image(200, 100, 77);
             std::vector<std::uint8_t> input(config.input_bytes());
             lpr::plate_input_into(image.view(), lpr::Rect{50, 40, 40, 10}, config, input);
             for (const std::uint8_t value : input) {
                 expect_equal(static_cast<int>(value), 77, "a flat crop stays flat");
             }
             std::vector<std::uint8_t> small(10);
             check::expect_throws<std::invalid_argument>(
                 [&] { lpr::plate_input_into(image.view(), lpr::Rect{0, 0, 10, 10}, config, small); },
                 "a small buffer");
         }},
    });
}
