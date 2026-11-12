#include <algorithm>
#include <cmath>
#include <filesystem>
#include <string>
#include <utility>
#include <vector>

#include "check.hpp"
#include "lpr/image_io.hpp"
#include "lpr/json.hpp"
#include "lpr/onnx_engine.hpp"
#include "lpr/pipeline.hpp"

namespace {

namespace fs = std::filesystem;
using check::expect;
using check::expect_equal;

// Each sample photo and the plates on it, as samples/samples.json labels them.
const std::vector<std::pair<std::string, std::vector<std::string>>> kSamples{
    {"ro-cluj-napoca.jpg", {"CJ27CLC"}},
    {"ro-sibiu.jpg", {"MAI58767", "B108ZJE"}},
    {"ro-turda.jpg", {"CJ14VXY"}},
    {"de-golf.jpg", {"HHQM8872"}},
    {"gb-captur.jpg", {"AY23XCA"}},
    {"fr-dieppe.jpg", {"AA110YP", "AA405TC"}},
    {"it-punto.jpg", {"EL333CK"}},
    {"nl-vanquish.jpg", {"GB713F", "G592HD"}},
    {"es-sevilla.jpg", {"1512HNC"}},
    {"pl-gdansk.jpg", {"GD560TM"}},
    {"br-brasilia.jpg", {"REL2D66", "REL3E32"}},
    {"us-california.jpg", {"6ARX058"}},
};

std::vector<std::string> texts(const lpr::FrameResult& frame) {
    std::vector<std::string> result;
    for (const lpr::PlateResult& plate : frame.plates) {
        result.push_back(plate.read.text);
    }
    return result;
}

}  // namespace

int main() {
    const fs::path models = lpr::default_models_directory();
    if (!fs::exists(models / "detector.onnx") || !fs::exists(models / "recognizer.onnx")) {
        std::cout << "skipped: prepare the models with tools/prepare_models.py\n";
        return 77;
    }
    lpr::OnnxEngine engine({models / "detector.onnx", models / "recognizer.onnx", 1});
    const lpr::RecognizerConfig& config = lpr::plate_recognizer_config();
    const fs::path samples(LPR_SAMPLES_DIR);

    return check::run({
        {"every sample photo reads as labeled",
         [&] {
             lpr::Pipeline pipeline;
             for (const auto& [file, plates] : kSamples) {
                 const lpr::Image image = lpr::read_image(samples / file);
                 const std::vector<std::string> read = texts(pipeline.run(image.view(), engine));
                 for (const std::string& plate : plates) {
                     expect(std::find(read.begin(), read.end(), plate) != read.end(),
                            file + ": " + plate + " was not read; " + lpr::frame_json(pipeline.result(), config));
                 }
             }
         }},
        {"the three steps give what run() gives",
         [&] {
             const lpr::Image image = lpr::read_image(samples / kSamples.front().first);
             lpr::Pipeline whole;
             const std::string expected = lpr::frame_json(whole.run(image.view(), engine), config);

             lpr::Pipeline steps;
             const std::span<const float> input = steps.prepare(image.view());
             const std::span<const float> raw = engine.detect(input, 384);
             const std::vector<float> predictions(raw.begin(), raw.end());
             const std::span<const std::uint8_t> plates = steps.detected(predictions);
             std::vector<float> probabilities;
             std::vector<float> regions;
             engine.recognize(plates, steps.plate_count(), config, probabilities, regions);
             expect_equal(lpr::frame_json(steps.read(probabilities, regions), config), expected, "the same reading");
         }},
        {"plates read together read as they do alone",
         [&] {
             lpr::Pipeline pipeline;
             std::vector<std::uint8_t> batch;
             std::size_t count = 0;
             for (const auto& [file, plates] : kSamples) {
                 const lpr::Image image = lpr::read_image(samples / file);
                 lpr::Pipeline single;
                 (void)single.prepare(image.view());
                 const std::span<const std::uint8_t> input =
                     single.detected(engine.detect(single.detector_input(), 384));
                 batch.insert(batch.end(), input.begin(), input.end());
                 count += single.plate_count();
             }
             std::vector<float> together;
             std::vector<float> regions;
             engine.recognize(batch, count, config, together, regions);
             const std::size_t per_plate = 10 * 37;
             for (std::size_t i = 0; i < count; ++i) {
                 std::vector<float> alone;
                 std::vector<float> alone_regions;
                 engine.recognize(
                     std::span<const std::uint8_t>(batch).subspan(i * config.input_bytes(), config.input_bytes()),
                     1,
                     config,
                     alone,
                     alone_regions);
                 for (std::size_t j = 0; j < per_plate; ++j) {
                     check::expect_near(together[(i * per_plate) + j], alone[j], 1e-5, "plate " + std::to_string(i));
                 }
             }
         }},
        {"reading is deterministic",
         [&] {
             const lpr::Image image = lpr::read_image(samples / kSamples.front().first);
             lpr::Pipeline pipeline;
             const std::string first = lpr::frame_json(pipeline.run(image.view(), engine), config);
             expect_equal(lpr::frame_json(pipeline.run(image.view(), engine), config), first, "a second run");
         }},
        {"a stricter threshold never finds more plates",
         [&] {
             const lpr::Image image = lpr::read_image(samples / kSamples.front().first);
             std::size_t previous = 1000;
             for (const float threshold : {0.1F, 0.4F, 0.7F, 0.95F}) {
                 lpr::PipelineOptions options;
                 options.detector.score_threshold = threshold;
                 lpr::Pipeline pipeline(options);
                 const std::size_t found = pipeline.run(image.view(), engine).plates.size();
                 expect(found <= previous, "threshold " + std::to_string(threshold));
                 previous = found;
             }
         }},
        {"a blank image has no plates",
         [&] {
             const lpr::Image blank(640, 480, 128);
             lpr::Pipeline pipeline;
             expect_equal(pipeline.run(blank.view(), engine).plates.size(), std::size_t{0}, "plates");
         }},
        {"the engine rejects inputs it was not built for",
         [&] {
             std::vector<float> input(3 * 320 * 320);
             check::expect_throws<std::invalid_argument>([&] { (void)engine.detect(input, 320); }, "a 320 input");
             std::vector<float> probabilities;
             std::vector<float> regions;
             check::expect_throws<std::invalid_argument>(
                 [&] { engine.recognize(std::vector<std::uint8_t>(100), 1, config, probabilities, regions); },
                 "a short plate");
             lpr::Pipeline pipeline;
             check::expect_throws<std::logic_error>([&] { (void)pipeline.detected(input); }, "steps out of order");
         }},
    });
}
