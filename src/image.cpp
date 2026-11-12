#include "lpr/image.hpp"

#include <algorithm>
#include <cstring>
#include <stdexcept>
#include <string>
#include <utility>

namespace lpr {

namespace {

constexpr int kWeightBits = 11;
constexpr int kWeightOne = 1 << kWeightBits;
constexpr int kRoundingBias = 1 << ((2 * kWeightBits) - 1);

// Where a target pixel samples the source along one axis: two neighbouring source pixels and the weight of the second.
struct Tap {
    int first = 0;
    int second = 0;
    int weight = 0;
};

std::int64_t floor_div(std::int64_t numerator, std::int64_t denominator) {
    std::int64_t quotient = numerator / denominator;
    if ((numerator % denominator != 0) && ((numerator < 0) != (denominator < 0))) {
        --quotient;
    }
    return quotient;
}

std::vector<Tap> make_taps(int source_size, int target_size) {
    std::vector<Tap> taps(static_cast<std::size_t>(target_size));
    // The center of target pixel i maps to source coordinate ((2i + 1) * source - target) / (2 * target).
    const std::int64_t denominator = 2LL * target_size;
    for (int i = 0; i < target_size; ++i) {
        const std::int64_t numerator = ((2LL * i) + 1) * source_size - target_size;
        std::int64_t whole = floor_div(numerator, denominator);
        std::int64_t fraction = numerator - (whole * denominator);
        if (whole < 0) {
            whole = 0;
            fraction = 0;
        }
        if (whole >= source_size - 1) {
            whole = source_size - 1;
            fraction = 0;
        }
        Tap& tap = taps[static_cast<std::size_t>(i)];
        tap.first = static_cast<int>(whole);
        tap.second = std::min(tap.first + 1, source_size - 1);
        tap.weight = static_cast<int>(((fraction * kWeightOne) + (denominator / 2)) / denominator);
    }
    return taps;
}

void check_view(ImageView source) {
    if (source.empty()) {
        throw std::invalid_argument("image is empty");
    }
    if (source.stride < static_cast<std::ptrdiff_t>(source.width) * source.channels()) {
        throw std::invalid_argument("image rows overlap: stride is shorter than a row");
    }
}

}  // namespace

ImageView packed_view(std::span<const std::uint8_t> pixels, int width, int height, PixelFormat format) {
    ImageView view{pixels.data(), width, height, 0, format};
    view.stride = static_cast<std::ptrdiff_t>(width) * view.channels();
    if (width <= 0 || height <= 0 ||
        pixels.size() < static_cast<std::size_t>(view.stride) * static_cast<std::size_t>(height)) {
        throw std::invalid_argument("pixel buffer is smaller than " + std::to_string(width) + "x" +
                                    std::to_string(height));
    }
    return view;
}

Image::Image(int width, int height, std::uint8_t fill)
    : width_(width),
      height_(height),
      pixels_(static_cast<std::size_t>(std::max(width, 0)) * static_cast<std::size_t>(std::max(height, 0)) * 3U, fill) {
    if (width < 0 || height < 0) {
        throw std::invalid_argument("image size must not be negative");
    }
}

Image::Image(int width, int height, std::vector<std::uint8_t> pixels)
    : width_(width), height_(height), pixels_(std::move(pixels)) {
    if (width < 0 || height < 0 ||
        pixels_.size() != static_cast<std::size_t>(width) * static_cast<std::size_t>(height) * 3U) {
        throw std::invalid_argument("pixel buffer does not hold a packed RGB image of the given size");
    }
}

ImageView Image::view() const noexcept {
    return ImageView{pixels_.data(), width_, height_, static_cast<std::ptrdiff_t>(width_) * 3, PixelFormat::rgb};
}

ImageView subview(ImageView image, Rect region) {
    if (region.empty() || region.x < 0 || region.y < 0 || region.x + region.width > image.width ||
        region.y + region.height > image.height) {
        throw std::out_of_range("region lies outside the image");
    }
    ImageView view = image;
    view.data = image.row(region.y) + (static_cast<std::ptrdiff_t>(region.x) * image.channels());
    view.width = region.width;
    view.height = region.height;
    return view;
}

void resize_into(ImageView source, int width, int height, std::span<std::uint8_t> out) {
    check_view(source);
    if (width <= 0 || height <= 0) {
        throw std::invalid_argument("target size must be positive");
    }
    const auto row_values = static_cast<std::size_t>(width) * 3U;
    if (out.size() < row_values * static_cast<std::size_t>(height)) {
        throw std::invalid_argument("output buffer is too small");
    }

    const std::vector<Tap> columns = make_taps(source.width, width);
    const std::vector<Tap> rows = make_taps(source.height, height);
    const int channels = source.channels();

    // Each source row is resampled horizontally once, into one of two buffers, and kept while target rows need it.
    std::vector<std::int32_t> buffers[2] = {std::vector<std::int32_t>(row_values),
                                            std::vector<std::int32_t>(row_values)};
    int cached[2] = {-1, -1};
    const auto horizontal = [&](int source_row, int keep) -> const std::int32_t* {
        for (int slot = 0; slot < 2; ++slot) {
            if (cached[slot] == source_row) {
                return buffers[slot].data();
            }
        }
        const int slot = cached[0] == keep ? 1 : 0;
        const std::uint8_t* pixels = source.row(source_row);
        std::int32_t* values = buffers[slot].data();
        for (const Tap& tap : columns) {
            const std::uint8_t* first = pixels + (static_cast<std::ptrdiff_t>(tap.first) * channels);
            const std::uint8_t* second = pixels + (static_cast<std::ptrdiff_t>(tap.second) * channels);
            for (int c = 0; c < 3; ++c) {
                *values++ = (first[c] * (kWeightOne - tap.weight)) + (second[c] * tap.weight);
            }
        }
        cached[slot] = source_row;
        return buffers[slot].data();
    };

    std::uint8_t* target = out.data();
    for (const Tap& tap : rows) {
        const std::int32_t* top = horizontal(tap.first, -1);
        const std::int32_t* bottom = horizontal(tap.second, tap.first);
        const std::int32_t top_weight = kWeightOne - tap.weight;
        for (std::size_t i = 0; i < row_values; ++i) {
            const std::int32_t value =
                ((top[i] * top_weight) + (bottom[i] * tap.weight) + kRoundingBias) >> (2 * kWeightBits);
            *target++ = static_cast<std::uint8_t>(std::clamp(value, 0, 255));
        }
    }
}

Image resize(ImageView source, int width, int height) {
    Image image(width, height);
    resize_into(source, width, height, image.pixels());
    return image;
}

Image to_image(ImageView source) {
    check_view(source);
    Image image(source.width, source.height);
    const int channels = source.channels();
    for (int y = 0; y < source.height; ++y) {
        const std::uint8_t* from = source.row(y);
        std::uint8_t* to = image.row(y);
        if (channels == 3) {
            std::memcpy(to, from, static_cast<std::size_t>(source.width) * 3U);
            continue;
        }
        for (int x = 0; x < source.width; ++x) {
            to[(x * 3) + 0] = from[(x * 4) + 0];
            to[(x * 3) + 1] = from[(x * 4) + 1];
            to[(x * 3) + 2] = from[(x * 4) + 2];
        }
    }
    return image;
}

Image apply_orientation(ImageView source, int orientation) {
    check_view(source);
    if (orientation < 2 || orientation > 8) {
        return to_image(source);
    }
    const int w = source.width;
    const int h = source.height;
    const bool transposed = orientation >= 5;
    Image image(transposed ? h : w, transposed ? w : h);
    const int channels = source.channels();
    for (int y = 0; y < image.height(); ++y) {
        std::uint8_t* to = image.row(y);
        for (int x = 0; x < image.width(); ++x) {
            int sx = x;
            int sy = y;
            switch (orientation) {
                case 2:  // mirrored
                    sx = w - 1 - x;
                    break;
                case 3:  // rotated 180 degrees
                    sx = w - 1 - x;
                    sy = h - 1 - y;
                    break;
                case 4:  // flipped vertically
                    sy = h - 1 - y;
                    break;
                case 5:  // transposed
                    sx = y;
                    sy = x;
                    break;
                case 6:  // rotated 90 degrees clockwise to display
                    sx = y;
                    sy = h - 1 - x;
                    break;
                case 7:  // transversed
                    sx = w - 1 - y;
                    sy = h - 1 - x;
                    break;
                default:  // 8: rotated 90 degrees counterclockwise to display
                    sx = w - 1 - y;
                    sy = x;
                    break;
            }
            const std::uint8_t* from = source.row(sy) + (static_cast<std::ptrdiff_t>(sx) * channels);
            to[(x * 3) + 0] = from[0];
            to[(x * 3) + 1] = from[1];
            to[(x * 3) + 2] = from[2];
        }
    }
    return image;
}

std::uint64_t fingerprint(std::span<const std::uint8_t> bytes) noexcept {
    std::uint64_t hash = 14695981039346656037ULL;
    for (const std::uint8_t byte : bytes) {
        hash ^= byte;
        hash *= 1099511628211ULL;
    }
    return hash;
}

std::uint64_t fingerprint(std::span<const float> values) noexcept {
    std::uint64_t hash = 14695981039346656037ULL;
    for (const float value : values) {
        std::uint32_t bits = 0;
        std::memcpy(&bits, &value, sizeof bits);
        for (int shift = 0; shift < 32; shift += 8) {
            hash ^= (bits >> shift) & 0xFFU;
            hash *= 1099511628211ULL;
        }
    }
    return hash;
}

}  // namespace lpr
