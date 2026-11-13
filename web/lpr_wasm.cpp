// The pipeline's JavaScript interface, compiled to WebAssembly with Emscripten. The page's worker drives it: it fills a
// frame, runs the networks in ONNX Runtime Web between the steps, and gets the plates back as JSON, the same JSON the
// command line prints.

#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <cstdint>
#include <iomanip>
#include <sstream>
#include <string>
#include <vector>

#include "lpr/image.hpp"
#include "lpr/image_io.hpp"
#include "lpr/json.hpp"
#include "lpr/pipeline.hpp"
#include "lpr/tracker.hpp"

namespace {

using emscripten::val;

std::string hex(std::uint64_t value) {
    std::ostringstream stream;
    stream << std::hex << std::setw(16) << std::setfill('0') << value;
    return stream.str();
}

// C++ exceptions reach JavaScript as plain Errors with their messages.
template <typename Body>
auto guarded(Body&& body) -> decltype(body()) {
    try {
        return body();
    } catch (const std::exception& error) {
        val::global("Error").new_(std::string(error.what())).throw_();
    }
    __builtin_unreachable();
}

class WebPipeline {
public:
    // A buffer for the next frame's RGBA pixels, which the caller fills before prepare().
    val frame(int width, int height) {
        return guarded([&] {
            if (width <= 0 || height <= 0 || width > 16384 || height > 16384) {
                throw std::invalid_argument("frames must be between 1 and 16384 pixels on a side");
            }
            width_ = width;
            height_ = height;
            format_ = lpr::PixelFormat::rgba;
            pixels_.assign(static_cast<std::size_t>(width) * static_cast<std::size_t>(height) * 4U, 0);
            return val(emscripten::typed_memory_view(pixels_.size(), pixels_.data()));
        });
    }

    // Decodes a JPEG, PNG, or BMP file into the frame, as the command line does; returns its size.
    val decode(const val& bytes) {
        return guarded([&] {
            const std::vector<std::uint8_t> file = emscripten::convertJSArrayToNumberVector<std::uint8_t>(bytes);
            const lpr::Image image = lpr::decode_image(file);
            width_ = image.width();
            height_ = image.height();
            format_ = lpr::PixelFormat::rgb;
            pixels_.assign(image.pixels().begin(), image.pixels().end());
            val size = val::object();
            size.set("width", width_);
            size.set("height", height_);
            return size;
        });
    }

    // Step 1: the detector's input for the frame, [1, 3, size, size] floats.
    val prepare() {
        return guarded([&] {
            if (pixels_.empty()) {
                throw std::logic_error("prepare() needs a frame");
            }
            const std::span<const float> input = pipeline_.prepare(lpr::packed_view(pixels_, width_, height_, format_));
            return val(emscripten::typed_memory_view(input.size(), input.data()));
        });
    }

    // Step 2: decodes the detector's output; returns the recognizer's input, [count, 64, 128, 3] bytes.
    val detected(const val& predictions) {
        return guarded([&] {
            predictions_ = emscripten::convertJSArrayToNumberVector<float>(predictions);
            const std::span<const std::uint8_t> plates = pipeline_.detected(predictions_);
            return val(emscripten::typed_memory_view(plates.size(), plates.data()));
        });
    }

    [[nodiscard]] int plateCount() const {
        return static_cast<int>(pipeline_.plate_count());
    }

    // Step 3: decodes the recognizer's outputs; returns the frame's plates as JSON.
    std::string read(const val& probabilities, const val& regions) {
        return guarded([&] {
            probabilities_ = emscripten::convertJSArrayToNumberVector<float>(probabilities);
            regions_ = emscripten::convertJSArrayToNumberVector<float>(regions);
            return lpr::frame_json(pipeline_.read(probabilities_, regions_), pipeline_.config());
        });
    }

    void setOptions(double score_threshold, double iou_threshold) {
        guarded([&] {
            lpr::PipelineOptions options = pipeline_.options();
            options.detector.score_threshold = static_cast<float>(score_threshold);
            options.detector.iou_threshold = static_cast<float>(iou_threshold);
            pipeline_.set_options(options);
            return 0;
        });
    }

    [[nodiscard]] int detectorSize() const {
        return pipeline_.options().detector_size;
    }

    // The detector's square input, in pixels: 384, or 640 for the larger detector.
    void setDetectorSize(int size) {
        guarded([&] {
            lpr::PipelineOptions options = pipeline_.options();
            options.detector_size = size;
            pipeline_.set_options(options);
            return 0;
        });
    }

    // Adds the last frame's plates to the tracker; returns its events and tracks as JSON.
    std::string track(double timestamp_ms) {
        return guarded([&] { return tracking_json(tracker_.update(pipeline_.result(), timestamp_ms)); });
    }

    // Ends every track, as at the end of a video.
    std::string finishTracks() {
        return guarded([&] { return tracking_json(tracker_.finish()); });
    }

    void resetTracks() {
        tracker_.reset();
    }

    // Fingerprints of the networks' last inputs, to compare with the command line's --trace.
    std::string fingerprints() const {
        lpr::JsonWriter json;
        json.begin_object();
        json.key("detector_input").value(hex(lpr::fingerprint(pipeline_.detector_input())));
        json.key("recognizer_input").value(hex(lpr::fingerprint(pipeline_.recognizer_input())));
        json.end_object();
        return json.str();
    }

private:
    std::string tracking_json(const std::vector<lpr::TrackEvent>& events) const {
        lpr::JsonWriter json;
        json.begin_object();
        json.key("events").begin_array();
        for (const lpr::TrackEvent& event : events) {
            json.begin_object();
            json.key("event").value(lpr::to_string(event.kind));
            json.key("track");
            lpr::write_track(json, event.track, pipeline_.config());
            json.end_object();
        }
        json.end_array();
        json.key("tracks").begin_array();
        for (const lpr::Track& track : tracker_.tracks()) {
            lpr::write_track(json, track, pipeline_.config());
        }
        json.end_array();
        json.end_object();
        return json.str();
    }

    lpr::Pipeline pipeline_;
    lpr::PlateTracker tracker_;
    std::vector<std::uint8_t> pixels_;
    int width_ = 0;
    int height_ = 0;
    lpr::PixelFormat format_ = lpr::PixelFormat::rgba;
    std::vector<float> predictions_;
    std::vector<float> probabilities_;
    std::vector<float> regions_;
};

}  // namespace

EMSCRIPTEN_BINDINGS(lpr) {
    emscripten::class_<WebPipeline>("Pipeline")
        .constructor<>()
        .function("frame", &WebPipeline::frame)
        .function("decode", &WebPipeline::decode)
        .function("prepare", &WebPipeline::prepare)
        .function("detected", &WebPipeline::detected)
        .function("plateCount", &WebPipeline::plateCount)
        .function("read", &WebPipeline::read)
        .function("setOptions", &WebPipeline::setOptions)
        .function("detectorSize", &WebPipeline::detectorSize)
        .function("setDetectorSize", &WebPipeline::setDetectorSize)
        .function("track", &WebPipeline::track)
        .function("finishTracks", &WebPipeline::finishTracks)
        .function("resetTracks", &WebPipeline::resetTracks)
        .function("fingerprints", &WebPipeline::fingerprints);
}
