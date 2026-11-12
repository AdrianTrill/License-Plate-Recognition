#pragma once

// Synthetic recognizer outputs for the tests.

#include <cstddef>
#include <string_view>
#include <vector>

#include "lpr/recognizer.hpp"

namespace readings {

// Per-slot probabilities for a reading: `confidence` on each slot's symbol, the rest spread evenly over the others.
// A blurred slot puts `confidence` on another symbol instead, and 0.3 on its own.
inline std::vector<float> slots(std::string_view text,
                                float confidence,
                                std::size_t blurred_slot = 99,
                                char blurred_as = 0,
                                const lpr::RecognizerConfig& config = lpr::plate_recognizer_config()) {
    const std::size_t symbols = config.symbols();
    std::vector<float> probabilities(static_cast<std::size_t>(config.slots) * symbols);
    for (std::size_t slot = 0; slot < static_cast<std::size_t>(config.slots); ++slot) {
        const char character = slot < text.size() ? text[slot] : config.pad;
        const std::size_t index = config.alphabet.find(character);
        for (std::size_t symbol = 0; symbol < symbols; ++symbol) {
            probabilities[(slot * symbols) + symbol] =
                symbol == index ? confidence : (1.0F - confidence) / static_cast<float>(symbols - 1);
        }
        if (slot == blurred_slot) {
            probabilities[(slot * symbols) + config.alphabet.find(blurred_as)] = confidence;
            probabilities[(slot * symbols) + index] = 0.3F;
        }
    }
    return probabilities;
}

// Region probabilities with `confidence` on the named region.
inline std::vector<float> regions(std::string_view name,
                                  float confidence,
                                  const lpr::RecognizerConfig& config = lpr::plate_recognizer_config()) {
    const std::size_t count = config.regions.size();
    std::vector<float> probabilities(count, (1.0F - confidence) / static_cast<float>(count - 1));
    for (std::size_t i = 0; i < count; ++i) {
        if (config.regions[i].name == name) {
            probabilities[i] = confidence;
        }
    }
    return probabilities;
}

}  // namespace readings
