#include "lpr/json.hpp"

#include <array>
#include <charconv>
#include <cmath>
#include <cstdio>
#include <system_error>

namespace lpr {

namespace {

constexpr int kPixelDecimals = 1;
constexpr int kProbabilityDecimals = 4;
constexpr int kTimeDecimals = 1;

void write_region(JsonWriter& json, const PlateRead& read, const RecognizerConfig& config) {
    json.key("region");
    if (read.region < 0 || static_cast<std::size_t>(read.region) >= config.regions.size()) {
        json.null();
        return;
    }
    const Region& region = config.regions[static_cast<std::size_t>(read.region)];
    json.begin_object();
    json.key("name").value(region.name);
    json.key("code").value(region.code);
    json.key("confidence").value(read.region_confidence, kProbabilityDecimals);
    json.end_object();
}

void write_characters(JsonWriter& json, const PlateRead& read) {
    json.key("characters").begin_array();
    for (const Character& character : read.characters) {
        json.begin_object();
        json.key("char").value(std::string_view(&character.character, 1));
        json.key("confidence").value(character.confidence, kProbabilityDecimals);
        json.key("alternatives").begin_array(true);
        for (const Alternative& alternative : character.alternatives) {
            // Alternatives that would print as 0.0000 say nothing.
            if (alternative.character == 0 || alternative.probability < 0.00005F) {
                continue;
            }
            json.begin_array();
            json.value(std::string_view(&alternative.character, 1));
            json.value(alternative.probability, kProbabilityDecimals);
            json.end_array();
        }
        json.end_array();
        json.end_object();
    }
    json.end_array();
}

void write_box(JsonWriter& json, const Box& box) {
    json.key("box").begin_array(true);
    json.value(box.x1, kPixelDecimals).value(box.y1, kPixelDecimals);
    json.value(box.x2, kPixelDecimals).value(box.y2, kPixelDecimals);
    json.end_array();
}

}  // namespace

void JsonWriter::newline() {
    if (pretty_) {
        out_ += '\n';
        out_.append(2 * has_items_.size(), ' ');
    }
}

void JsonWriter::begin_value() {
    if (after_key_) {
        after_key_ = false;
        return;
    }
    if (!has_items_.empty()) {
        if (has_items_.back()) {
            out_ += ',';
        }
        if (one_line_.back()) {
            if (has_items_.back() && pretty_) {
                out_ += ' ';
            }
        } else {
            newline();
        }
        has_items_.back() = true;
    }
}

JsonWriter& JsonWriter::begin_object() {
    begin_value();
    out_ += '{';
    has_items_.push_back(false);
    one_line_.push_back(false);
    return *this;
}

JsonWriter& JsonWriter::end_object() {
    const bool had_items = has_items_.back();
    has_items_.pop_back();
    one_line_.pop_back();
    if (had_items) {
        newline();
    }
    out_ += '}';
    return *this;
}

JsonWriter& JsonWriter::begin_array(bool one_line) {
    begin_value();
    out_ += '[';
    has_items_.push_back(false);
    one_line_.push_back(one_line || (!one_line_.empty() && one_line_.back()));
    return *this;
}

JsonWriter& JsonWriter::end_array() {
    const bool had_items = has_items_.back();
    const bool one_line = one_line_.back();
    has_items_.pop_back();
    one_line_.pop_back();
    if (had_items && !one_line) {
        newline();
    }
    out_ += ']';
    return *this;
}

JsonWriter& JsonWriter::key(std::string_view name) {
    value(name);
    out_ += pretty_ ? ": " : ":";
    after_key_ = true;
    return *this;
}

JsonWriter& JsonWriter::value(std::string_view text) {
    begin_value();
    out_ += '"';
    for (const char c : text) {
        switch (c) {
            case '"':
                out_ += "\\\"";
                break;
            case '\\':
                out_ += "\\\\";
                break;
            case '\n':
                out_ += "\\n";
                break;
            case '\r':
                out_ += "\\r";
                break;
            case '\t':
                out_ += "\\t";
                break;
            default:
                if (static_cast<unsigned char>(c) < 0x20) {
                    std::array<char, 8> escaped{};
                    std::snprintf(escaped.data(), escaped.size(), "\\u%04x", static_cast<unsigned>(c));
                    out_ += escaped.data();
                } else {
                    out_ += c;
                }
        }
    }
    out_ += '"';
    return *this;
}

JsonWriter& JsonWriter::value(const char* text) {
    return value(std::string_view(text));
}

JsonWriter& JsonWriter::value(bool flag) {
    begin_value();
    out_ += flag ? "true" : "false";
    return *this;
}

JsonWriter& JsonWriter::value(std::int64_t number) {
    begin_value();
    out_ += std::to_string(number);
    return *this;
}

JsonWriter& JsonWriter::value(double number, int decimals) {
    if (!std::isfinite(number)) {
        return null();
    }
    begin_value();
    std::array<char, 64> buffer{};
    const auto [end, error] =
        std::to_chars(buffer.data(), buffer.data() + buffer.size(), number, std::chars_format::fixed, decimals);
    std::string_view text(buffer.data(), error == std::errc{} ? static_cast<std::size_t>(end - buffer.data()) : 0);
    // A small negative number rounds to "-0.0000"; print it as zero.
    if (!text.empty() && text.front() == '-' && text.find_first_not_of("-0.") == std::string_view::npos) {
        text.remove_prefix(1);
    }
    out_ += text;
    return *this;
}

JsonWriter& JsonWriter::null() {
    begin_value();
    out_ += "null";
    return *this;
}

void write_plate(JsonWriter& json, const PlateResult& plate, const RecognizerConfig& config) {
    json.begin_object();
    json.key("text").value(plate.read.text);
    json.key("confidence").value(plate.read.confidence, kProbabilityDecimals);
    write_box(json, plate.detection.box);
    json.key("score").value(plate.detection.score, kProbabilityDecimals);
    json.key("crop").begin_array(true);
    json.value(plate.region.x).value(plate.region.y).value(plate.region.width).value(plate.region.height);
    json.end_array();
    write_region(json, plate.read, config);
    write_characters(json, plate.read);
    json.end_object();
}

void write_frame(JsonWriter& json, const FrameResult& frame, const RecognizerConfig& config) {
    json.begin_object();
    json.key("width").value(frame.width);
    json.key("height").value(frame.height);
    json.key("plates").begin_array();
    for (const PlateResult& plate : frame.plates) {
        write_plate(json, plate, config);
    }
    json.end_array();
    json.end_object();
}

std::string frame_json(const FrameResult& frame, const RecognizerConfig& config, bool pretty) {
    JsonWriter json(pretty);
    write_frame(json, frame, config);
    return json.str();
}

void write_track(JsonWriter& json, const Track& track, const RecognizerConfig& config) {
    json.begin_object();
    json.key("id").value(track.id);
    json.key("text").value(track.read.text);
    json.key("confidence").value(track.read.confidence, kProbabilityDecimals);
    write_box(json, track.box);
    json.key("score").value(track.best_score, kProbabilityDecimals);
    json.key("seen").value(track.seen);
    json.key("reads").value(track.reads);
    json.key("first_seen_ms").value(track.first_seen_ms, kTimeDecimals);
    json.key("last_seen_ms").value(track.last_seen_ms, kTimeDecimals);
    json.key("reported").value(track.reported);
    json.key("visible").value(track.visible);
    write_region(json, track.read, config);
    write_characters(json, track.read);
    json.end_object();
}

std::string event_json(const TrackEvent& event, const RecognizerConfig& config) {
    JsonWriter json;
    json.begin_object();
    json.key("event").value(to_string(event.kind));
    json.key("track");
    write_track(json, event.track, config);
    json.end_object();
    return json.str();
}

std::string tracks_json(const std::vector<Track>& tracks, const RecognizerConfig& config) {
    JsonWriter json;
    json.begin_array();
    for (const Track& track : tracks) {
        write_track(json, track, config);
    }
    json.end_array();
    return json.str();
}

}  // namespace lpr
