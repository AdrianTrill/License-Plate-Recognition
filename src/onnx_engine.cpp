#include "lpr/onnx_engine.hpp"

#include <algorithm>
#include <array>
#include <cstdlib>
#include <stdexcept>
#include <string>

#include <onnxruntime_cxx_api.h>

namespace lpr {

namespace {

std::string shape_text(const std::vector<std::int64_t>& shape) {
    std::string text = "[";
    for (std::size_t i = 0; i < shape.size(); ++i) {
        text += (i == 0 ? "" : ", ") + std::to_string(shape[i]);
    }
    return text + "]";
}

std::vector<std::int64_t> input_shape(const Ort::Session& session, std::size_t index) {
    return session.GetInputTypeInfo(index).GetTensorTypeAndShapeInfo().GetShape();
}

std::vector<std::int64_t> output_shape(const Ort::Session& session, std::size_t index) {
    return session.GetOutputTypeInfo(index).GetTensorTypeAndShapeInfo().GetShape();
}

Ort::Session open(const Ort::Env& env, const std::filesystem::path& path, const Ort::SessionOptions& options) {
    if (!std::filesystem::exists(path)) {
        throw std::runtime_error(path.string() +
                                 " is missing: prepare the models with `python tools/prepare_models.py`, or build "
                                 "with -DLPR_DOWNLOAD_MODELS=ON");
    }
    return Ort::Session(env, path.c_str(), options);
}

}  // namespace

struct OnnxEngine::Impl {
    Ort::Env env{ORT_LOGGING_LEVEL_ERROR, "lpr"};
    Ort::Session detector{nullptr};
    Ort::Session recognizer{nullptr};
    Ort::MemoryInfo memory = Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);
    std::string detector_input;
    std::string detector_output;
    std::string recognizer_input;
    std::string plate_output;
    std::string region_output;  // empty when the model reads no regions
    int detector_size = 0;
    std::vector<float> predictions;
};

OnnxEngine::OnnxEngine(const OnnxEngineOptions& options) : impl_(std::make_unique<Impl>()) {
    Ort::SessionOptions session_options;
    session_options.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);
    session_options.SetLogSeverityLevel(ORT_LOGGING_LEVEL_ERROR);
    if (options.threads > 0) {
        session_options.SetIntraOpNumThreads(options.threads);
    }
    impl_->detector = open(impl_->env, options.detector, session_options);
    impl_->recognizer = open(impl_->env, options.recognizer, session_options);

    Ort::AllocatorWithDefaultOptions allocator;
    const Ort::Session& detector = impl_->detector;
    const std::vector<std::int64_t> detector_shape = input_shape(detector, 0);
    if (detector.GetInputCount() != 1 || detector_shape.size() != 4 || detector_shape[1] != 3 ||
        detector_shape[2] != detector_shape[3] || detector_shape[2] <= 0) {
        throw std::runtime_error(options.detector.string() +
                                 ": expected a detector with a [1, 3, size, size] input, got " +
                                 shape_text(detector_shape));
    }
    impl_->detector_size = static_cast<int>(detector_shape[2]);
    const std::vector<std::int64_t> predictions_shape = output_shape(detector, 0);
    const auto anchors = static_cast<std::int64_t>(anchor_count(impl_->detector_size));
    if (predictions_shape.size() != 3 || predictions_shape[1] != 5 || predictions_shape[2] != anchors) {
        throw std::runtime_error(options.detector.string() + ": expected the raw [1, 5, " + std::to_string(anchors) +
                                 "] head of a YOLOv9 plate detector, got " + shape_text(predictions_shape) +
                                 "; prepare it with tools/prepare_models.py");
    }
    impl_->detector_input = detector.GetInputNameAllocated(0, allocator).get();
    impl_->detector_output = detector.GetOutputNameAllocated(0, allocator).get();

    const Ort::Session& recognizer = impl_->recognizer;
    impl_->recognizer_input = recognizer.GetInputNameAllocated(0, allocator).get();
    for (std::size_t i = 0; i < recognizer.GetOutputCount(); ++i) {
        const std::string name = recognizer.GetOutputNameAllocated(i, allocator).get();
        if (name == "plate") {
            impl_->plate_output = name;
        } else if (name == "region") {
            impl_->region_output = name;
        }
    }
    if (impl_->plate_output.empty()) {
        throw std::runtime_error(options.recognizer.string() +
                                 ": expected a fast-plate-ocr model with a 'plate' output");
    }
}

OnnxEngine::~OnnxEngine() = default;

int OnnxEngine::detector_size() const noexcept {
    return impl_->detector_size;
}

std::string OnnxEngine::runtime_version() {
    return Ort::GetVersionString();
}

std::span<const float> OnnxEngine::detect(std::span<const float> input, int size) {
    if (size != impl_->detector_size) {
        throw std::invalid_argument("the detector takes " + std::to_string(impl_->detector_size) +
                                    "-pixel inputs, not " + std::to_string(size));
    }
    const std::array<std::int64_t, 4> shape{1, 3, size, size};
    // ONNX Runtime does not write to its inputs; its C API just isn't const-correct.
    Ort::Value tensor = Ort::Value::CreateTensor<float>(impl_->memory,
                                                        const_cast<float*>(input.data()),
                                                        input.size(),
                                                        shape.data(),
                                                        shape.size());
    const char* input_name = impl_->detector_input.c_str();
    const char* output_name = impl_->detector_output.c_str();
    std::vector<Ort::Value> outputs =
        impl_->detector.Run(Ort::RunOptions{nullptr}, &input_name, &tensor, 1, &output_name, 1);
    const Ort::TensorTypeAndShapeInfo info = outputs[0].GetTensorTypeAndShapeInfo();
    const float* data = outputs[0].GetTensorData<float>();
    impl_->predictions.assign(data, data + info.GetElementCount());
    return impl_->predictions;
}

void OnnxEngine::recognize(std::span<const std::uint8_t> plates,
                           std::size_t count,
                           const RecognizerConfig& config,
                           std::vector<float>& probabilities,
                           std::vector<float>& region_probabilities) {
    probabilities.clear();
    region_probabilities.clear();
    if (count == 0) {
        return;
    }
    if (plates.size() != count * config.input_bytes()) {
        throw std::invalid_argument("the recognizer's input does not hold " + std::to_string(count) + " plates");
    }
    const std::array<std::int64_t, 4> shape{static_cast<std::int64_t>(count), config.height, config.width, 3};
    Ort::Value tensor = Ort::Value::CreateTensor<std::uint8_t>(impl_->memory,
                                                               const_cast<std::uint8_t*>(plates.data()),
                                                               plates.size(),
                                                               shape.data(),
                                                               shape.size());
    const char* input_name = impl_->recognizer_input.c_str();
    std::vector<const char*> output_names{impl_->plate_output.c_str()};
    if (!impl_->region_output.empty()) {
        output_names.push_back(impl_->region_output.c_str());
    }
    std::vector<Ort::Value> outputs = impl_->recognizer.Run(Ort::RunOptions{nullptr},
                                                            &input_name,
                                                            &tensor,
                                                            1,
                                                            output_names.data(),
                                                            output_names.size());

    const std::size_t expected = count * static_cast<std::size_t>(config.slots) * config.symbols();
    if (outputs[0].GetTensorTypeAndShapeInfo().GetElementCount() != expected) {
        throw std::runtime_error("the recognizer's output does not match its configuration: expected " +
                                 std::to_string(config.slots) + " slots of " + std::to_string(config.symbols()) +
                                 " symbols, got " + shape_text(outputs[0].GetTensorTypeAndShapeInfo().GetShape()));
    }
    const float* plate = outputs[0].GetTensorData<float>();
    probabilities.assign(plate, plate + expected);
    if (outputs.size() > 1) {
        const std::size_t regions = outputs[1].GetTensorTypeAndShapeInfo().GetElementCount();
        if (regions != count * config.regions.size()) {
            throw std::runtime_error("the recognizer's region output does not match its configuration");
        }
        const float* region = outputs[1].GetTensorData<float>();
        region_probabilities.assign(region, region + regions);
    }
}

std::filesystem::path default_models_directory() {
    // getenv is only read here, before any threads start.
    if (const char* override_directory = std::getenv("LPR_MODELS");
        override_directory != nullptr && *override_directory) {  // NOLINT(concurrency-mt-unsafe)
        return override_directory;
    }
#ifdef LPR_MODELS_DIR
    return LPR_MODELS_DIR;
#else
    return "models";
#endif
}

}  // namespace lpr
