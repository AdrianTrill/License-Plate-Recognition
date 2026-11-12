#pragma once

#include <cstddef>
#include <cstdint>
#include <span>
#include <vector>

#include "lpr/detector.hpp"
#include "lpr/image.hpp"
#include "lpr/recognizer.hpp"

namespace lpr {

// What the pipeline needs from a runtime: the two networks.
class InferenceEngine {
public:
    InferenceEngine() = default;
    InferenceEngine(const InferenceEngine&) = delete;
    InferenceEngine& operator=(const InferenceEngine&) = delete;
    InferenceEngine(InferenceEngine&&) = delete;
    InferenceEngine& operator=(InferenceEngine&&) = delete;
    virtual ~InferenceEngine() = default;

    // The detector's raw output, [1, 5, anchors], for its input, [1, 3, size, size].
    virtual std::span<const float> detect(std::span<const float> input, int size) = 0;

    // The recognizer's outputs for a batch of plates, [count, height, width, 3] bytes: per-slot probabilities,
    // [count, slots, symbols], and region probabilities, [count, regions], or none.
    virtual void recognize(std::span<const std::uint8_t> plates,
                           std::size_t count,
                           const RecognizerConfig& config,
                           std::vector<float>& probabilities,
                           std::vector<float>& region_probabilities) = 0;
};

struct PipelineOptions {
    int detector_size = 384;
    DetectorOptions detector;
    std::size_t max_plates = 32;  // plates read per image, the detector's most confident first
};

struct PlateResult {
    Detection detection;
    Rect region;  // the pixels the recognizer read
    PlateRead read;
};

struct FrameResult {
    int width = 0;
    int height = 0;
    std::vector<PlateResult> plates;
};

struct Timings {
    double preprocess_ms = 0.0;  // letterbox, decoding, and plate crops
    double detector_ms = 0.0;
    double recognizer_ms = 0.0;
    double total_ms = 0.0;
};

// Reads the plates in an image in three steps, so the networks can run between them wherever they live: through
// run() and an InferenceEngine natively, or in a browser, where ONNX Runtime Web runs them asynchronously and
// JavaScript calls the steps. Both ways run this same code around the networks.
class Pipeline {
public:
    explicit Pipeline(PipelineOptions options = {}, const RecognizerConfig& config = plate_recognizer_config());

    // 1. The detector's input for an image. The image must stay valid until read() returns.
    std::span<const float> prepare(ImageView image);

    // 2. Decodes the detector's output and crops the plates: returns the recognizer's input, [count, height, width, 3]
    //    bytes, empty when there are no plates.
    std::span<const std::uint8_t> detected(std::span<const float> predictions);

    // 3. Decodes the recognizer's outputs for the plates from step 2.
    const FrameResult& read(std::span<const float> probabilities, std::span<const float> region_probabilities);

    // All three steps, with an engine.
    const FrameResult& run(ImageView image, InferenceEngine& engine, Timings* timings = nullptr);

    [[nodiscard]] std::size_t plate_count() const noexcept {
        return regions_.size();
    }
    [[nodiscard]] const FrameResult& result() const noexcept {
        return result_;
    }
    [[nodiscard]] const Letterbox& letterbox() const noexcept {
        return letterbox_;
    }
    [[nodiscard]] std::span<const float> detector_input() const noexcept {
        return detector_input_;
    }
    [[nodiscard]] std::span<const std::uint8_t> recognizer_input() const noexcept {
        return recognizer_input_;
    }
    [[nodiscard]] const PipelineOptions& options() const noexcept {
        return options_;
    }
    void set_options(const PipelineOptions& options);
    [[nodiscard]] const RecognizerConfig& config() const noexcept {
        return *config_;
    }

private:
    enum class Stage : std::uint8_t {
        idle,
        prepared,
        detected,
    };

    PipelineOptions options_;
    const RecognizerConfig* config_;
    Stage stage_ = Stage::idle;
    ImageView image_;
    Letterbox letterbox_;
    std::vector<float> detector_input_;
    std::vector<std::uint8_t> scratch_;
    std::vector<Detection> detections_;
    std::vector<Rect> regions_;
    std::vector<std::uint8_t> recognizer_input_;
    FrameResult result_;
};

}  // namespace lpr
