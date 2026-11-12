#pragma once

#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

#include "lpr/pipeline.hpp"
#include "lpr/recognizer.hpp"
#include "lpr/tracker.hpp"

namespace lpr {

// A small streaming JSON writer. Numbers are written with a fixed number of decimals, so the command line and the
// WebAssembly build print the same results the same way.
class JsonWriter {
public:
    explicit JsonWriter(bool pretty = false) : pretty_(pretty) {}

    JsonWriter& begin_object();
    JsonWriter& end_object();
    // An array whose items stay on one line when indented: for short lists of numbers and strings.
    JsonWriter& begin_array(bool one_line = false);
    JsonWriter& end_array();
    JsonWriter& key(std::string_view name);
    JsonWriter& value(std::string_view text);
    JsonWriter& value(const char* text);
    JsonWriter& value(bool flag);
    JsonWriter& value(std::int64_t number);
    JsonWriter& value(int number) {
        return value(static_cast<std::int64_t>(number));
    }
    JsonWriter& value(std::size_t number) {
        return value(static_cast<std::int64_t>(number));
    }
    JsonWriter& value(double number, int decimals);
    JsonWriter& null();

    [[nodiscard]] const std::string& str() const noexcept {
        return out_;
    }

private:
    void begin_value();
    void newline();

    std::string out_;
    std::vector<bool> has_items_;
    std::vector<bool> one_line_;
    bool after_key_ = false;
    bool pretty_ = false;
};

// One plate: its text, confidence, box, detector score, region, and characters with their alternatives.
void write_plate(JsonWriter& json, const PlateResult& plate, const RecognizerConfig& config);

// An image's size and plates.
void write_frame(JsonWriter& json, const FrameResult& frame, const RecognizerConfig& config);
std::string frame_json(const FrameResult& frame, const RecognizerConfig& config, bool pretty = false);

void write_track(JsonWriter& json, const Track& track, const RecognizerConfig& config);
std::string event_json(const TrackEvent& event, const RecognizerConfig& config);
std::string tracks_json(const std::vector<Track>& tracks, const RecognizerConfig& config);

}  // namespace lpr
