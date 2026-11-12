#include "lpr/image_io.hpp"

#include <algorithm>
#include <cctype>
#include <climits>
#include <cstring>
#include <fstream>
#include <iterator>
#include <stdexcept>
#include <string>

#include <stb_image.h>
#include <stb_image_write.h>

namespace lpr {

namespace {

// The orientation tag of a TIFF structure, as EXIF embeds one; 0 when it has none.
int tiff_orientation(std::span<const std::uint8_t> tiff) noexcept {
    if (tiff.size() < 8) {
        return 0;
    }
    bool little_endian = false;
    if (tiff[0] == 'I' && tiff[1] == 'I') {
        little_endian = true;
    } else if (tiff[0] != 'M' || tiff[1] != 'M') {
        return 0;
    }
    const auto u16 = [&](std::size_t at) -> std::uint32_t {
        return little_endian ? static_cast<std::uint32_t>(tiff[at] | (tiff[at + 1] << 8))
                             : static_cast<std::uint32_t>((tiff[at] << 8) | tiff[at + 1]);
    };
    const auto u32 = [&](std::size_t at) -> std::uint32_t {
        return little_endian ? u16(at) | (u16(at + 2) << 16) : (u16(at) << 16) | u16(at + 2);
    };
    if (u16(2) != 42) {
        return 0;
    }
    const std::size_t directory = u32(4);
    if (directory + 2 > tiff.size()) {
        return 0;
    }
    const std::size_t entries = u16(directory);
    for (std::size_t i = 0; i < entries; ++i) {
        const std::size_t entry = directory + 2 + (i * 12);
        if (entry + 12 > tiff.size()) {
            return 0;
        }
        if (u16(entry) == 0x0112) {
            const std::uint32_t type = u16(entry + 2);
            const std::uint32_t value = u16(entry + 8);
            return type == 3 && value >= 1 && value <= 8 ? static_cast<int>(value) : 0;
        }
    }
    return 0;
}

void append(void* context, void* data, int size) {
    auto* bytes = static_cast<std::vector<std::uint8_t>*>(context);
    const auto* begin = static_cast<const std::uint8_t*>(data);
    bytes->insert(bytes->end(), begin, begin + size);
}

}  // namespace

int exif_orientation(std::span<const std::uint8_t> file) noexcept {
    if (file.size() < 4 || file[0] != 0xFF || file[1] != 0xD8) {
        return 1;
    }
    std::size_t at = 2;
    while (at + 4 <= file.size()) {
        if (file[at] != 0xFF) {
            return 1;
        }
        const std::uint8_t marker = file[at + 1];
        if (marker == 0xFF) {  // padding before a marker
            ++at;
            continue;
        }
        if (marker == 0x01 || (marker >= 0xD0 && marker <= 0xD8)) {  // markers without a segment
            at += 2;
            continue;
        }
        if (marker == 0xDA || marker == 0xD9) {  // the image data starts: no metadata past here
            return 1;
        }
        const std::size_t length = (static_cast<std::size_t>(file[at + 2]) << 8) | file[at + 3];
        if (length < 2 || at + 2 + length > file.size()) {
            return 1;
        }
        const std::span<const std::uint8_t> segment = file.subspan(at + 4, length - 2);
        if (marker == 0xE1 && segment.size() > 6 && std::memcmp(segment.data(), "Exif\0\0", 6) == 0) {
            const int orientation = tiff_orientation(segment.subspan(6));
            if (orientation != 0) {
                return orientation;
            }
        }
        at += 2 + length;
    }
    return 1;
}

Image decode_image(std::span<const std::uint8_t> file) {
    if (file.empty() || file.size() > static_cast<std::size_t>(INT_MAX)) {
        throw std::runtime_error("not an image");
    }
    int width = 0;
    int height = 0;
    int channels = 0;
    std::uint8_t* pixels =
        stbi_load_from_memory(file.data(), static_cast<int>(file.size()), &width, &height, &channels, 3);
    if (pixels == nullptr) {
        throw std::runtime_error(std::string("could not decode the image: ") + stbi_failure_reason());
    }
    const std::size_t size = static_cast<std::size_t>(width) * static_cast<std::size_t>(height) * 3U;
    std::vector<std::uint8_t> rgb(pixels, pixels + size);
    stbi_image_free(pixels);
    Image image(width, height, std::move(rgb));
    const int orientation = exif_orientation(file);
    return orientation > 1 ? apply_orientation(image.view(), orientation) : image;
}

std::vector<std::uint8_t> read_file(const std::filesystem::path& path) {
    std::ifstream stream(path, std::ios::binary);
    if (!stream) {
        throw std::runtime_error("cannot open " + path.string());
    }
    return {std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>()};
}

Image read_image(const std::filesystem::path& path) {
    try {
        return decode_image(read_file(path));
    } catch (const std::runtime_error& error) {
        throw std::runtime_error(path.string() + ": " + error.what());
    }
}

std::vector<std::uint8_t> encode_png(const Image& image) {
    std::vector<std::uint8_t> bytes;
    if (stbi_write_png_to_func(append,
                               &bytes,
                               image.width(),
                               image.height(),
                               3,
                               image.pixels().data(),
                               image.width() * 3) == 0) {
        throw std::runtime_error("could not encode the PNG");
    }
    return bytes;
}

std::vector<std::uint8_t> encode_jpeg(const Image& image, int quality) {
    std::vector<std::uint8_t> bytes;
    if (stbi_write_jpg_to_func(append, &bytes, image.width(), image.height(), 3, image.pixels().data(), quality) == 0) {
        throw std::runtime_error("could not encode the JPEG");
    }
    return bytes;
}

void write_image(const std::filesystem::path& path, const Image& image) {
    std::string extension = path.extension().string();
    std::transform(extension.begin(), extension.end(), extension.begin(), [](unsigned char c) {
        return static_cast<char>(std::tolower(c));
    });
    std::vector<std::uint8_t> bytes;
    if (extension == ".png") {
        bytes = encode_png(image);
    } else if (extension == ".jpg" || extension == ".jpeg") {
        bytes = encode_jpeg(image);
    } else {
        throw std::runtime_error(path.string() + ": write .png or .jpg");
    }
    std::ofstream stream(path, std::ios::binary);
    stream.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
    if (!stream) {
        throw std::runtime_error("cannot write " + path.string());
    }
}

}  // namespace lpr
