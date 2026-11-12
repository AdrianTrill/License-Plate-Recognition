#pragma once

#include <filesystem>
#include <memory>
#include <span>
#include <string>
#include <vector>

#include "lpr/pipeline.hpp"

namespace lpr {

struct OnnxEngineOptions {
    std::filesystem::path detector;
    std::filesystem::path recognizer;
    int threads = 0;  // intra-op threads for each network; 0 lets ONNX Runtime choose
};

// The networks on ONNX Runtime's CPU execution provider: the native counterpart of ONNX Runtime Web in the browser.
class OnnxEngine final : public InferenceEngine {
public:
    explicit OnnxEngine(const OnnxEngineOptions& options);
    ~OnnxEngine() override;

    std::span<const float> detect(std::span<const float> input, int size) override;
    void recognize(std::span<const std::uint8_t> plates,
                   std::size_t count,
                   const RecognizerConfig& config,
                   std::vector<float>& probabilities,
                   std::vector<float>& region_probabilities) override;

    // The detector's input size, read from the model.
    [[nodiscard]] int detector_size() const noexcept;

    [[nodiscard]] static std::string runtime_version();

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

// Where the models are: $LPR_MODELS if set, or else the repository's models/ directory, as configured at build time.
std::filesystem::path default_models_directory();

}  // namespace lpr
