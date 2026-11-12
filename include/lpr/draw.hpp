#pragma once

#include <cstdint>
#include <string_view>

#include "lpr/image.hpp"
#include "lpr/pipeline.hpp"

namespace lpr {

struct Color {
    std::uint8_t r = 0;
    std::uint8_t g = 0;
    std::uint8_t b = 0;
};

void fill_rect(Image& image, Rect rect, Color color);
void stroke_rect(Image& image, Rect rect, Color color, int thickness);

// Text in a 5x7 dot font, each dot `scale` pixels square: digits, capital letters, and a little punctuation.
// Other characters print as boxes.
void draw_text(Image& image, int x, int y, std::string_view text, int scale, Color color);
int text_width(std::string_view text, int scale) noexcept;
inline int text_height(int scale) noexcept {
    return 7 * scale;
}

// Outlines each plate and labels it with its text and confidence, sized to the image.
void annotate(Image& image, const FrameResult& frame);

}  // namespace lpr
