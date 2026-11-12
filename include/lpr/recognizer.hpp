#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <span>
#include <string>
#include <string_view>
#include <vector>

#include "lpr/detector.hpp"
#include "lpr/image.hpp"

namespace lpr {

// A country or territory the recognizer can tell a plate's design from.
struct Region {
    std::string_view name;
    std::string_view code;  // ISO 3166-1 alpha-2; empty for "Unknown"
};

// What a plate recognizer reads and how: its symbols, slots, input size, and regions.
struct RecognizerConfig {
    std::string_view alphabet;
    char pad = '_';
    int slots = 0;
    int width = 0;
    int height = 0;
    std::span<const Region> regions;

    [[nodiscard]] std::size_t symbols() const noexcept {
        return alphabet.size();
    }
    // Bytes of one plate's input: height x width x 3.
    [[nodiscard]] std::size_t input_bytes() const noexcept {
        return static_cast<std::size_t>(width) * static_cast<std::size_t>(height) * 3U;
    }
};

// fast-plate-ocr's configuration for its global models, cct-s-v2-global-model among them: 36 symbols and padding in
// 10 slots, from 64x128 RGB, with 66 regions.
const RecognizerConfig& plate_recognizer_config();

struct Alternative {
    char character = 0;
    float probability = 0.0F;
};

struct Character {
    char character = 0;
    float confidence = 0.0F;                    // the probability the network gave it
    std::array<Alternative, 2> alternatives{};  // the next likeliest symbols for its slot
};

struct PlateRead {
    std::string text;                   // the plate's characters, with trailing padding removed
    float confidence = 0.0F;            // the network's probability of exactly this text: the product over every slot
    std::vector<Character> characters;  // one per character of the text
    int region = -1;                    // index into the config's regions; -1 when the model has no region head
    float region_confidence = 0.0F;
    std::vector<float> probabilities;         // slots x symbols, as the network gave them
    std::vector<float> region_probabilities;  // one per region
};

// The crop the reference implementation reads for a detection: the box's corners truncated to whole pixels.
Rect plate_region(const Box& box, int image_width, int image_height) noexcept;

// Writes one plate's input, height x width x 3 RGB bytes, the region stretched to fill it.
void plate_input_into(ImageView image, Rect region, const RecognizerConfig& config, std::span<std::uint8_t> out);

// A reading from the network's output for one plate: probabilities over the alphabet for each slot, and over the
// regions, which may be empty.
PlateRead decode_plate(std::span<const float> probabilities,
                       std::span<const float> region_probabilities,
                       const RecognizerConfig& config);

}  // namespace lpr
