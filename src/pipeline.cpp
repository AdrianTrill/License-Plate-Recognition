#include "lpr/pipeline.hpp"

#include <chrono>
#include <stdexcept>
#include <string>
#include <utility>

namespace lpr {

namespace {

using Clock = std::chrono::steady_clock;

double milliseconds_since(Clock::time_point start) {
    return std::chrono::duration<double, std::milli>(Clock::now() - start).count();
}

void check_options(const PipelineOptions& options) {
    if (options.detector_size <= 0 || options.detector_size % 32 != 0) {
        throw std::invalid_argument("the detector's input size must be a positive multiple of 32");
    }
}

}  // namespace

Pipeline::Pipeline(PipelineOptions options, const RecognizerConfig& config) : options_(options), config_(&config) {
    check_options(options_);
}

void Pipeline::set_options(const PipelineOptions& options) {
    check_options(options);
    options_ = options;
    stage_ = Stage::idle;
}

std::span<const float> Pipeline::prepare(ImageView image) {
    if (image.empty()) {
        throw std::invalid_argument("image is empty");
    }
    image_ = image;
    letterbox_ = letterbox_geometry(image.width, image.height, options_.detector_size);
    const auto side = static_cast<std::size_t>(options_.detector_size);
    detector_input_.resize(3 * side * side);
    letterbox_into(image_, letterbox_, detector_input_, scratch_);
    detections_.clear();
    regions_.clear();
    recognizer_input_.clear();
    result_ = FrameResult{image.width, image.height, {}};
    stage_ = Stage::prepared;
    return detector_input_;
}

std::span<const std::uint8_t> Pipeline::detected(std::span<const float> predictions) {
    if (stage_ != Stage::prepared) {
        throw std::logic_error("detected() needs an image from prepare()");
    }
    const std::size_t expected = 5 * anchor_count(options_.detector_size);
    if (predictions.size() != expected) {
        throw std::invalid_argument("expected the detector's [1, 5, " + std::to_string(expected / 5) +
                                    "] output, got " + std::to_string(predictions.size()) + " values");
    }
    detections_.clear();
    regions_.clear();
    for (const Detection& detection : decode_detections(predictions, letterbox_, options_.detector)) {
        if (regions_.size() >= options_.max_plates) {
            break;
        }
        const Rect region = plate_region(detection.box, image_.width, image_.height);
        if (region.empty()) {
            continue;
        }
        detections_.push_back(detection);
        regions_.push_back(region);
    }

    const std::size_t plate_bytes = config_->input_bytes();
    recognizer_input_.resize(regions_.size() * plate_bytes);
    for (std::size_t i = 0; i < regions_.size(); ++i) {
        plate_input_into(image_,
                         regions_[i],
                         *config_,
                         std::span<std::uint8_t>(recognizer_input_).subspan(i * plate_bytes, plate_bytes));
    }
    stage_ = Stage::detected;
    return recognizer_input_;
}

const FrameResult& Pipeline::read(std::span<const float> probabilities, std::span<const float> region_probabilities) {
    if (stage_ != Stage::detected) {
        throw std::logic_error("read() needs the plates from detected()");
    }
    const std::size_t count = regions_.size();
    const std::size_t per_plate = static_cast<std::size_t>(config_->slots) * config_->symbols();
    if (probabilities.size() != count * per_plate) {
        throw std::invalid_argument("expected the recognizer's output for " + std::to_string(count) + " plates");
    }
    const std::size_t regions = config_->regions.size();
    const bool has_regions = !region_probabilities.empty();
    if (has_regions && region_probabilities.size() != count * regions) {
        throw std::invalid_argument("expected region probabilities for " + std::to_string(count) + " plates");
    }

    result_.plates.clear();
    for (std::size_t i = 0; i < count; ++i) {
        PlateResult plate;
        plate.detection = detections_[i];
        plate.region = regions_[i];
        plate.read =
            decode_plate(probabilities.subspan(i * per_plate, per_plate),
                         has_regions ? region_probabilities.subspan(i * regions, regions) : std::span<const float>{},
                         *config_);
        result_.plates.push_back(std::move(plate));
    }
    stage_ = Stage::idle;
    return result_;
}

const FrameResult& Pipeline::run(ImageView image, InferenceEngine& engine, Timings* timings) {
    const Clock::time_point start = Clock::now();
    Timings measured;

    Clock::time_point step = Clock::now();
    const std::span<const float> input = prepare(image);
    measured.preprocess_ms += milliseconds_since(step);

    step = Clock::now();
    const std::span<const float> predictions = engine.detect(input, options_.detector_size);
    measured.detector_ms = milliseconds_since(step);

    step = Clock::now();
    const std::span<const std::uint8_t> plates = detected(predictions);
    measured.preprocess_ms += milliseconds_since(step);

    std::vector<float> probabilities;
    std::vector<float> region_probabilities;
    if (plate_count() > 0) {
        step = Clock::now();
        engine.recognize(plates, plate_count(), *config_, probabilities, region_probabilities);
        measured.recognizer_ms = milliseconds_since(step);
    }

    step = Clock::now();
    const FrameResult& result = read(probabilities, region_probabilities);
    measured.preprocess_ms += milliseconds_since(step);
    measured.total_ms = milliseconds_since(start);
    if (timings != nullptr) {
        *timings = measured;
    }
    return result;
}

}  // namespace lpr
