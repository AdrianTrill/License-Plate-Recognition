#include "lpr/draw.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <string>

namespace lpr {

namespace {

struct Glyph {
    char character;
    std::array<std::uint8_t, 7> rows;  // five dots a row, the leftmost in bit 4
};

// clang-format off
constexpr std::array<Glyph, 46> kGlyphs{{
    {'0', {0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110}},
    {'1', {0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110}},
    {'2', {0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111}},
    {'3', {0b11111, 0b00010, 0b00100, 0b00010, 0b00001, 0b10001, 0b01110}},
    {'4', {0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010}},
    {'5', {0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110}},
    {'6', {0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110}},
    {'7', {0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000}},
    {'8', {0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110}},
    {'9', {0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100}},
    {'A', {0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001}},
    {'B', {0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110}},
    {'C', {0b01110, 0b10001, 0b10000, 0b10000, 0b10000, 0b10001, 0b01110}},
    {'D', {0b11100, 0b10010, 0b10001, 0b10001, 0b10001, 0b10010, 0b11100}},
    {'E', {0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111}},
    {'F', {0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000}},
    {'G', {0b01110, 0b10001, 0b10000, 0b10111, 0b10001, 0b10001, 0b01111}},
    {'H', {0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001}},
    {'I', {0b01110, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110}},
    {'J', {0b00111, 0b00010, 0b00010, 0b00010, 0b00010, 0b10010, 0b01100}},
    {'K', {0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001}},
    {'L', {0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111}},
    {'M', {0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001}},
    {'N', {0b10001, 0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001}},
    {'O', {0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110}},
    {'P', {0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000}},
    {'Q', {0b01110, 0b10001, 0b10001, 0b10001, 0b10101, 0b10010, 0b01101}},
    {'R', {0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001}},
    {'S', {0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110}},
    {'T', {0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100}},
    {'U', {0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110}},
    {'V', {0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100}},
    {'W', {0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b10101, 0b01010}},
    {'X', {0b10001, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0b10001}},
    {'Y', {0b10001, 0b10001, 0b01010, 0b00100, 0b00100, 0b00100, 0b00100}},
    {'Z', {0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0b11111}},
    {' ', {0b00000, 0b00000, 0b00000, 0b00000, 0b00000, 0b00000, 0b00000}},
    {'%', {0b11000, 0b11001, 0b00010, 0b00100, 0b01000, 0b10011, 0b00011}},
    {'.', {0b00000, 0b00000, 0b00000, 0b00000, 0b00000, 0b01100, 0b01100}},
    {',', {0b00000, 0b00000, 0b00000, 0b00000, 0b01100, 0b00100, 0b01000}},
    {'-', {0b00000, 0b00000, 0b00000, 0b11111, 0b00000, 0b00000, 0b00000}},
    {':', {0b00000, 0b01100, 0b01100, 0b00000, 0b01100, 0b01100, 0b00000}},
    {'_', {0b00000, 0b00000, 0b00000, 0b00000, 0b00000, 0b00000, 0b11111}},
    {'?', {0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b00000, 0b00100}},
    {'/', {0b00001, 0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0b10000}},
    {'#', {0b01010, 0b01010, 0b11111, 0b01010, 0b11111, 0b01010, 0b01010}},
}};
// clang-format on

constexpr std::array<std::uint8_t, 7> kUnknown{0b11111, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11111};

const std::array<std::uint8_t, 7>& glyph(char character) noexcept {
    const char upper = (character >= 'a' && character <= 'z') ? static_cast<char>(character - 'a' + 'A') : character;
    for (const Glyph& candidate : kGlyphs) {
        if (candidate.character == upper) {
            return candidate.rows;
        }
    }
    return kUnknown;
}

constexpr Color kPlateGreen{34, 197, 94};
constexpr Color kUnsureAmber{245, 158, 11};
constexpr Color kLabel{15, 23, 42};
constexpr Color kWhite{255, 255, 255};

}  // namespace

void fill_rect(Image& image, Rect rect, Color color) {
    const int x1 = std::clamp(rect.x, 0, image.width());
    const int y1 = std::clamp(rect.y, 0, image.height());
    const int x2 = std::clamp(rect.x + rect.width, 0, image.width());
    const int y2 = std::clamp(rect.y + rect.height, 0, image.height());
    for (int y = y1; y < y2; ++y) {
        std::uint8_t* pixel = image.row(y) + (static_cast<std::ptrdiff_t>(x1) * 3);
        for (int x = x1; x < x2; ++x, pixel += 3) {
            pixel[0] = color.r;
            pixel[1] = color.g;
            pixel[2] = color.b;
        }
    }
}

void stroke_rect(Image& image, Rect rect, Color color, int thickness) {
    fill_rect(image, Rect{rect.x - thickness, rect.y - thickness, rect.width + (2 * thickness), thickness}, color);
    fill_rect(image, Rect{rect.x - thickness, rect.y + rect.height, rect.width + (2 * thickness), thickness}, color);
    fill_rect(image, Rect{rect.x - thickness, rect.y, thickness, rect.height}, color);
    fill_rect(image, Rect{rect.x + rect.width, rect.y, thickness, rect.height}, color);
}

int text_width(std::string_view text, int scale) noexcept {
    return text.empty() ? 0 : ((static_cast<int>(text.size()) * 6) - 1) * scale;
}

void draw_text(Image& image, int x, int y, std::string_view text, int scale, Color color) {
    for (const char character : text) {
        const std::array<std::uint8_t, 7>& rows = glyph(character);
        for (int row = 0; row < 7; ++row) {
            for (int column = 0; column < 5; ++column) {
                if (((rows.at(static_cast<std::size_t>(row)) >> (4 - column)) & 1U) != 0) {
                    fill_rect(image, Rect{x + (column * scale), y + (row * scale), scale, scale}, color);
                }
            }
        }
        x += 6 * scale;
    }
}

void annotate(Image& image, const FrameResult& frame) {
    const int shorter = std::min(image.width(), image.height());
    const int thickness = std::max(2, shorter / 320);
    const int scale = std::max(2, shorter / 260);
    const int padding = 2 * scale;
    for (const PlateResult& plate : frame.plates) {
        const Box& box = plate.detection.box;
        const Rect outline{static_cast<int>(std::floor(box.x1)),
                           static_cast<int>(std::floor(box.y1)),
                           static_cast<int>(std::ceil(box.width())),
                           static_cast<int>(std::ceil(box.height()))};
        const Color color = plate.read.confidence >= 0.5F ? kPlateGreen : kUnsureAmber;
        stroke_rect(image, outline, color, thickness);

        std::array<char, 16> percent{};
        std::snprintf(percent.data(),
                      percent.size(),
                      " %d%%",
                      static_cast<int>(std::lround(plate.read.confidence * 100)));
        const std::string label = (plate.read.text.empty() ? std::string("?") : plate.read.text) + percent.data();
        const int width = text_width(label, scale) + (2 * padding);
        const int height = text_height(scale) + (2 * padding);
        const int x = std::clamp(outline.x - thickness, 0, std::max(0, image.width() - width));
        int y = outline.y - thickness - height;
        if (y < 0) {
            y = outline.y + outline.height + thickness;
        }
        fill_rect(image, Rect{x, y, width, height}, kLabel);
        fill_rect(image, Rect{x, y, width, scale}, color);
        draw_text(image, x + padding, y + padding, label, scale, kWhite);
    }
}

}  // namespace lpr
