#pragma once

#include <cstdint>
#include <filesystem>
#include <span>
#include <vector>

#include "lpr/image.hpp"

namespace lpr {

// The EXIF orientation of a JPEG, 1 to 8; 1 when it has none.
int exif_orientation(std::span<const std::uint8_t> file) noexcept;

// Decodes a JPEG, PNG, or BMP file's bytes into RGB, turned upright by its EXIF orientation, as browsers show it.
Image decode_image(std::span<const std::uint8_t> file);

std::vector<std::uint8_t> read_file(const std::filesystem::path& path);
Image read_image(const std::filesystem::path& path);

// Encodes as PNG, or as JPEG at the given quality.
std::vector<std::uint8_t> encode_png(const Image& image);
std::vector<std::uint8_t> encode_jpeg(const Image& image, int quality = 90);

// Writes PNG or JPEG, by the path's extension.
void write_image(const std::filesystem::path& path, const Image& image);

}  // namespace lpr
