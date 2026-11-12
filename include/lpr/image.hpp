#pragma once

#include <cstddef>
#include <cstdint>
#include <span>
#include <vector>

namespace lpr {

enum class PixelFormat : std::uint8_t {
    rgb,
    rgba,
};

// A read-only window onto 8-bit RGB or RGBA pixels whose rows are `stride` bytes apart. The pipeline reads images
// through views, so a browser's RGBA canvas and a decoded RGB file are read in place, without a copy.
struct ImageView {
    const std::uint8_t* data = nullptr;
    int width = 0;
    int height = 0;
    std::ptrdiff_t stride = 0;
    PixelFormat format = PixelFormat::rgb;

    [[nodiscard]] int channels() const noexcept {
        return format == PixelFormat::rgba ? 4 : 3;
    }
    [[nodiscard]] bool empty() const noexcept {
        return data == nullptr || width <= 0 || height <= 0;
    }
    [[nodiscard]] const std::uint8_t* row(int y) const noexcept {
        return data + (static_cast<std::ptrdiff_t>(y) * stride);
    }
};

// A view of packed pixels: rows exactly width * channels bytes long.
ImageView packed_view(std::span<const std::uint8_t> pixels, int width, int height, PixelFormat format);

// An owned RGB image with packed rows.
class Image {
public:
    Image() = default;
    Image(int width, int height, std::uint8_t fill = 0);
    Image(int width, int height, std::vector<std::uint8_t> pixels);

    [[nodiscard]] int width() const noexcept {
        return width_;
    }
    [[nodiscard]] int height() const noexcept {
        return height_;
    }
    [[nodiscard]] bool empty() const noexcept {
        return width_ == 0 || height_ == 0;
    }
    [[nodiscard]] std::span<const std::uint8_t> pixels() const noexcept {
        return pixels_;
    }
    [[nodiscard]] std::span<std::uint8_t> pixels() noexcept {
        return pixels_;
    }
    [[nodiscard]] std::uint8_t* row(int y) noexcept {
        return pixels_.data() + (static_cast<std::size_t>(y) * static_cast<std::size_t>(width_) * 3U);
    }
    [[nodiscard]] ImageView view() const noexcept;

private:
    int width_ = 0;
    int height_ = 0;
    std::vector<std::uint8_t> pixels_;
};

// A rectangle of whole pixels.
struct Rect {
    int x = 0;
    int y = 0;
    int width = 0;
    int height = 0;

    [[nodiscard]] bool empty() const noexcept {
        return width <= 0 || height <= 0;
    }
    friend bool operator==(const Rect&, const Rect&) = default;
};

// The part of a view inside `region`, which must lie within it.
ImageView subview(ImageView image, Rect region);

// Bilinear resampling into width x height RGB, with OpenCV's INTER_LINEAR geometry: pixel centers sit at half-integer
// coordinates, and samples past the last pixel take the edge. Weights are 11-bit fixed point, computed with integer
// arithmetic, so every platform, WebAssembly included, produces the same bytes.
Image resize(ImageView source, int width, int height);

// The same resampling, written into `out`, which must hold width * height * 3 bytes.
void resize_into(ImageView source, int width, int height, std::span<std::uint8_t> out);

// The image turned upright, given its EXIF orientation (1 to 8; anything else leaves it as it is).
Image apply_orientation(ImageView source, int orientation);

// A packed RGB copy of a view.
Image to_image(ImageView source);

// 64-bit FNV-1a, used to compare tensors across builds without shipping them.
std::uint64_t fingerprint(std::span<const std::uint8_t> bytes) noexcept;
std::uint64_t fingerprint(std::span<const float> values) noexcept;

}  // namespace lpr
