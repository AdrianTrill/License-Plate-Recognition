#include "lpr/recognizer.hpp"

#include <algorithm>
#include <stdexcept>
#include <string>

namespace lpr {

namespace {

constexpr std::array<Region, 66> kRegions{{
    {"Albania", "AL"},
    {"Andorra", "AD"},
    {"Argentina", "AR"},
    {"Armenia", "AM"},
    {"Australia", "AU"},
    {"Austria", "AT"},
    {"Azerbaijan", "AZ"},
    {"Bahrain", "BH"},
    {"Belarus", "BY"},
    {"Belgium", "BE"},
    {"Bosnia and Herzegovina", "BA"},
    {"Brazil", "BR"},
    {"Bulgaria", "BG"},
    {"Cambodia", "KH"},
    {"Canada", "CA"},
    {"Croatia", "HR"},
    {"Cyprus", "CY"},
    {"Czech Republic", "CZ"},
    {"Denmark", "DK"},
    {"Estonia", "EE"},
    {"Finland", "FI"},
    {"France", "FR"},
    {"Georgia", "GE"},
    {"Germany", "DE"},
    {"Gibraltar", "GI"},
    {"Greece", "GR"},
    {"Guernsey", "GG"},
    {"Hungary", "HU"},
    {"Iceland", "IS"},
    {"Indonesia", "ID"},
    {"Ireland", "IE"},
    {"Israel", "IL"},
    {"Italy", "IT"},
    {"Latvia", "LV"},
    {"Liechtenstein", "LI"},
    {"Lithuania", "LT"},
    {"Luxembourg", "LU"},
    {"Malaysia", "MY"},
    {"Malta", "MT"},
    {"Mexico", "MX"},
    {"Moldova", "MD"},
    {"Monaco", "MC"},
    {"Montenegro", "ME"},
    {"Netherlands", "NL"},
    {"New Zealand", "NZ"},
    {"North Macedonia", "MK"},
    {"Norway", "NO"},
    {"Poland", "PL"},
    {"Portugal", "PT"},
    {"Qatar", "QA"},
    {"Romania", "RO"},
    {"San Marino", "SM"},
    {"Serbia", "RS"},
    {"Singapore", "SG"},
    {"Slovakia", "SK"},
    {"Slovenia", "SI"},
    {"Spain", "ES"},
    {"Sweden", "SE"},
    {"Switzerland", "CH"},
    {"Thailand", "TH"},
    {"Turkey", "TR"},
    {"United States", "US"},
    {"Ukraine", "UA"},
    {"United Kingdom", "GB"},
    {"Vietnam", "VN"},
    {"Unknown", ""},
}};

}  // namespace

const RecognizerConfig& plate_recognizer_config() {
    static const RecognizerConfig config{"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_", '_', 10, 128, 64, kRegions};
    return config;
}

Rect plate_region(const Box& box, int image_width, int image_height) noexcept {
    // Casting truncates toward zero, as Python's int() does in the reference.
    const int x1 = std::clamp(static_cast<int>(box.x1), 0, image_width);
    const int y1 = std::clamp(static_cast<int>(box.y1), 0, image_height);
    const int x2 = std::clamp(static_cast<int>(box.x2), 0, image_width);
    const int y2 = std::clamp(static_cast<int>(box.y2), 0, image_height);
    return Rect{x1, y1, std::max(0, x2 - x1), std::max(0, y2 - y1)};
}

void plate_input_into(ImageView image, Rect region, const RecognizerConfig& config, std::span<std::uint8_t> out) {
    if (out.size() < config.input_bytes()) {
        throw std::invalid_argument("the plate's input buffer is too small");
    }
    resize_into(subview(image, region), config.width, config.height, out);
}

PlateRead decode_plate(std::span<const float> probabilities,
                       std::span<const float> region_probabilities,
                       const RecognizerConfig& config) {
    const std::size_t symbols = config.symbols();
    const auto slots = static_cast<std::size_t>(config.slots);
    if (probabilities.size() != slots * symbols) {
        throw std::invalid_argument("expected " + std::to_string(slots) + " slots of " + std::to_string(symbols) +
                                    " probabilities, got " + std::to_string(probabilities.size()) + " values");
    }
    if (!region_probabilities.empty() && region_probabilities.size() != config.regions.size()) {
        throw std::invalid_argument("expected " + std::to_string(config.regions.size()) +
                                    " region probabilities, got " + std::to_string(region_probabilities.size()));
    }

    PlateRead read;
    read.probabilities.assign(probabilities.begin(), probabilities.end());
    read.region_probabilities.assign(region_probabilities.begin(), region_probabilities.end());
    read.confidence = 1.0F;
    std::string raw;
    std::vector<Character> characters;
    for (std::size_t slot = 0; slot < slots; ++slot) {
        const std::span<const float> slot_probabilities = probabilities.subspan(slot * symbols, symbols);
        // The three likeliest symbols, in order; ties go to the earlier symbol, as argmax does.
        std::array<std::size_t, 3> best{0, 0, 0};
        std::array<float, 3> best_probability{-1.0F, -1.0F, -1.0F};
        for (std::size_t symbol = 0; symbol < symbols; ++symbol) {
            const float p = slot_probabilities[symbol];
            for (std::size_t rank = 0; rank < best.size(); ++rank) {
                if (p > best_probability[rank]) {
                    for (std::size_t later = best.size() - 1; later > rank; --later) {
                        best[later] = best[later - 1];
                        best_probability[later] = best_probability[later - 1];
                    }
                    best[rank] = symbol;
                    best_probability[rank] = p;
                    break;
                }
            }
        }
        Character character;
        character.character = config.alphabet[best[0]];
        character.confidence = best_probability[0];
        for (std::size_t rank = 1; rank < best.size() && rank < symbols; ++rank) {
            character.alternatives.at(rank - 1) = Alternative{config.alphabet[best[rank]], best_probability[rank]};
        }
        raw.push_back(character.character);
        characters.push_back(character);
        read.confidence *= best_probability[0];
    }

    const std::size_t end = raw.find_last_not_of(config.pad);
    const std::size_t length = end == std::string::npos ? 0 : end + 1;
    read.text = raw.substr(0, length);
    characters.resize(length);
    read.characters = std::move(characters);

    if (!region_probabilities.empty()) {
        const auto best = std::max_element(region_probabilities.begin(), region_probabilities.end());
        read.region = static_cast<int>(best - region_probabilities.begin());
        read.region_confidence = *best;
    }
    return read;
}

}  // namespace lpr
