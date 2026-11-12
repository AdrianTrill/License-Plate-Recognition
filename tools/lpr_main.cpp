// lpr: reads license plates in images and videos, scores the pipeline on benchmarks, and times it.

#include <algorithm>
#include <array>
#include <cctype>
#include <charconv>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <map>
#include <numeric>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

#include "lpr/draw.hpp"
#include "lpr/image.hpp"
#include "lpr/image_io.hpp"
#include "lpr/json.hpp"
#include "lpr/onnx_engine.hpp"
#include "lpr/pipeline.hpp"
#include "lpr/tracker.hpp"

namespace fs = std::filesystem;

namespace {

constexpr std::string_view kUsage = R"(Usage:
  lpr [options] IMAGE...           read the plates in images (JPEG, PNG, or BMP)
  lpr video --size WxH [options]   read raw RGB24 frames from stdin and follow the plates, e.g.
                                     ffmpeg -i clip.mp4 -f rawvideo -pix_fmt rgb24 - | lpr video --size 1280x720
  lpr evaluate [options] DIR...    score the pipeline on benchmark folders in the OpenALPR format
  lpr bench [--runs N] IMAGE       time each stage of the pipeline

Options:
  --json             print JSON (JSON lines for video) instead of text
  --annotate DIR     write each image with its plates drawn into DIR
  --threshold X      the detector's score threshold (default 0.4)
  --iou X            the overlap above which non-maximum suppression drops a box (default 0.45)
  --models DIR       where detector.onnx and recognizer.onnx are (default: $LPR_MODELS, or the repository's models/)
  --threads N        threads for each network (default: ONNX Runtime's choice)
  --trace            add fingerprints of the networks' inputs to the JSON, to compare builds
  --version          print the versions and exit
  --help             print this and exit

video:
  --size WxH         the frames' size (required)
  --fps N            their rate, for timestamps (default 30)
  --every N          read every Nth frame (default 1)

evaluate:
  --report FILE      write the results as JSON
  --misses           list every plate not read exactly

bench:
  --runs N           timed runs after three to warm up (default 50)
)";

struct Arguments {
    std::string command = "read";
    std::vector<std::string> inputs;
    bool json = false;
    bool trace = false;
    bool misses = false;
    std::optional<fs::path> annotate;
    std::optional<fs::path> report;
    fs::path models = lpr::default_models_directory();
    float threshold = 0.4F;
    float iou = 0.45F;
    int threads = 0;
    int width = 0;
    int height = 0;
    double fps = 30.0;
    int every = 1;
    int runs = 50;
};

class UsageError : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

template <typename Number>
Number parse_number(std::string_view text, std::string_view option) {
    Number value{};
    const auto [end, error] = std::from_chars(text.data(), text.data() + text.size(), value);
    if (error != std::errc{} || end != text.data() + text.size()) {
        throw UsageError(std::string(option) + " needs a number, not '" + std::string(text) + "'");
    }
    return value;
}

Arguments parse(int argc, char** argv) {
    Arguments arguments;
    std::vector<std::string_view> words(argv + 1, argv + argc);
    std::size_t i = 0;
    if (!words.empty() &&
        (words[0] == "video" || words[0] == "evaluate" || words[0] == "bench" || words[0] == "read")) {
        arguments.command = words[0];
        ++i;
    }
    const auto next = [&](std::string_view option) -> std::string_view {
        if (i + 1 >= words.size()) {
            throw UsageError(std::string(option) + " needs a value");
        }
        return words[++i];
    };
    for (; i < words.size(); ++i) {
        const std::string_view word = words[i];
        if (word == "--json") {
            arguments.json = true;
        } else if (word == "--trace") {
            arguments.trace = true;
        } else if (word == "--misses") {
            arguments.misses = true;
        } else if (word == "--annotate") {
            arguments.annotate = fs::path(next(word));
        } else if (word == "--report") {
            arguments.report = fs::path(next(word));
        } else if (word == "--models") {
            arguments.models = fs::path(next(word));
        } else if (word == "--threshold") {
            arguments.threshold = parse_number<float>(next(word), word);
        } else if (word == "--iou") {
            arguments.iou = parse_number<float>(next(word), word);
        } else if (word == "--threads") {
            arguments.threads = parse_number<int>(next(word), word);
        } else if (word == "--fps") {
            arguments.fps = parse_number<double>(next(word), word);
        } else if (word == "--every") {
            arguments.every = std::max(1, parse_number<int>(next(word), word));
        } else if (word == "--runs") {
            arguments.runs = std::max(1, parse_number<int>(next(word), word));
        } else if (word == "--size") {
            const std::string_view size = next(word);
            const std::size_t x = size.find('x');
            if (x == std::string_view::npos) {
                throw UsageError("--size needs WIDTHxHEIGHT, like 1280x720");
            }
            arguments.width = parse_number<int>(size.substr(0, x), word);
            arguments.height = parse_number<int>(size.substr(x + 1), word);
        } else if (word.size() > 1 && word.front() == '-' && word != "-") {
            throw UsageError("unknown option " + std::string(word));
        } else {
            arguments.inputs.emplace_back(word);
        }
    }
    if (arguments.threshold <= 0.0F || arguments.threshold > 1.0F || arguments.iou <= 0.0F || arguments.iou > 1.0F) {
        throw UsageError("--threshold and --iou must be in (0, 1]");
    }
    return arguments;
}

std::string fixed(double value, int decimals) {
    std::ostringstream stream;
    stream << std::fixed << std::setprecision(decimals) << value;
    return stream.str();
}

// Probabilities round down, so a reading the network is nearly sure of never prints as 100%.
std::string percent(double probability) {
    return fixed(std::floor((1000.0 * probability) + 1e-9) / 10.0, 1) + "%";
}

std::string hex(std::uint64_t value) {
    std::ostringstream stream;
    stream << std::hex << std::setw(16) << std::setfill('0') << value;
    return stream.str();
}

std::string region_text(const lpr::PlateRead& read, const lpr::RecognizerConfig& config) {
    if (read.region < 0) {
        return "";
    }
    const lpr::Region& region = config.regions[static_cast<std::size_t>(read.region)];
    return std::string(region.name) + (region.code.empty() ? "" : " (" + std::string(region.code) + ")") + " " +
           fixed(100.0 * read.region_confidence, 0) + "%";
}

struct Reader {
    lpr::OnnxEngine engine;
    lpr::Pipeline pipeline;

    explicit Reader(const Arguments& arguments)
        : engine(lpr::OnnxEngineOptions{arguments.models / "detector.onnx",
                                        arguments.models / "recognizer.onnx",
                                        arguments.threads}),
          pipeline([&] {
              lpr::PipelineOptions options;
              options.detector_size = engine.detector_size();
              options.detector.score_threshold = arguments.threshold;
              options.detector.iou_threshold = arguments.iou;
              return options;
          }()) {}
};

int read_images(const Arguments& arguments) {
    if (arguments.inputs.empty()) {
        throw UsageError("no images given");
    }
    Reader reader(arguments);
    const lpr::RecognizerConfig& config = reader.pipeline.config();
    if (arguments.annotate) {
        fs::create_directories(*arguments.annotate);
    }
    lpr::JsonWriter json(true);
    if (arguments.json) {
        json.begin_array();
    }
    int status = 0;
    for (const std::string& input : arguments.inputs) {
        lpr::Image image;
        try {
            image = lpr::read_image(input);
        } catch (const std::exception& error) {
            std::cerr << "lpr: " << error.what() << '\n';
            status = 1;
            continue;
        }
        lpr::Timings timings;
        const lpr::FrameResult& frame = reader.pipeline.run(image.view(), reader.engine, &timings);

        if (arguments.json) {
            json.begin_object();
            json.key("image").value(input);
            json.key("width").value(frame.width);
            json.key("height").value(frame.height);
            json.key("plates").begin_array();
            for (const lpr::PlateResult& plate : frame.plates) {
                lpr::write_plate(json, plate, config);
            }
            json.end_array();
            if (arguments.trace) {
                json.key("trace").begin_object();
                json.key("detector_input").value(hex(lpr::fingerprint(reader.pipeline.detector_input())));
                json.key("recognizer_input").value(hex(lpr::fingerprint(reader.pipeline.recognizer_input())));
                json.end_object();
            }
            json.end_object();
        } else {
            std::cout << input << " (" << frame.width << "x" << frame.height << "): " << frame.plates.size()
                      << (frame.plates.size() == 1 ? " plate" : " plates") << " in " << fixed(timings.total_ms, 1)
                      << " ms (detector " << fixed(timings.detector_ms, 1) << ", recognizer "
                      << fixed(timings.recognizer_ms, 1) << ", the rest " << fixed(timings.preprocess_ms, 1) << ")\n";
            for (const lpr::PlateResult& plate : frame.plates) {
                const lpr::Box& box = plate.detection.box;
                std::cout << "  " << std::left << std::setw(11) << (plate.read.text.empty() ? "?" : plate.read.text)
                          << std::right << std::setw(7) << percent(plate.read.confidence) << "   " << std::left
                          << std::setw(24) << region_text(plate.read, config) << std::right << "box "
                          << fixed(box.x1, 0) << "," << fixed(box.y1, 0) << " to " << fixed(box.x2, 0) << ","
                          << fixed(box.y2, 0) << "   detector " << fixed(plate.detection.score, 2) << '\n';
            }
        }
        if (arguments.annotate) {
            lpr::Image annotated = image;
            lpr::annotate(annotated, frame);
            fs::path output = *arguments.annotate / fs::path(input).filename();
            if (output.extension() != ".png" && output.extension() != ".jpg" && output.extension() != ".jpeg") {
                output.replace_extension(".png");
            }
            lpr::write_image(output, annotated);
        }
    }
    if (arguments.json) {
        json.end_array();
        std::cout << json.str() << '\n';
    }
    return status;
}

std::string clock_text(double milliseconds) {
    const auto total = static_cast<long long>(std::llround(milliseconds));
    std::ostringstream stream;
    stream << std::setw(2) << std::setfill('0') << total / 60000 << ':' << std::setw(2) << (total / 1000) % 60 << '.'
           << std::setw(3) << total % 1000;
    return stream.str();
}

int read_video(const Arguments& arguments) {
    if (arguments.width <= 0 || arguments.height <= 0) {
        throw UsageError("video needs the frames' size: --size WxH");
    }
    if (!arguments.inputs.empty() && arguments.inputs != std::vector<std::string>{"-"}) {
        throw UsageError("video reads its frames from stdin");
    }
#ifdef _WIN32
    _setmode(_fileno(stdin), _O_BINARY);
#endif
    Reader reader(arguments);
    const lpr::RecognizerConfig& config = reader.pipeline.config();
    lpr::PlateTracker tracker({}, config);
    const std::size_t frame_bytes = static_cast<std::size_t>(arguments.width) * arguments.height * 3U;
    std::vector<std::uint8_t> frame(frame_bytes);
    std::map<int, lpr::Track> plates;

    const auto print = [&](const std::vector<lpr::TrackEvent>& events) {
        for (const lpr::TrackEvent& event : events) {
            if (event.kind != lpr::TrackEventKind::ended) {
                plates[event.track.id] = event.track;
            }
            if (arguments.json) {
                std::cout << lpr::event_json(event, config) << '\n';
            } else {
                std::cout << clock_text(event.track.last_seen_ms) << "  " << std::left << std::setw(9)
                          << lpr::to_string(event.kind) << " #" << std::setw(4) << event.track.id << std::setw(11)
                          << event.track.read.text << std::right << std::setw(7) << percent(event.track.read.confidence)
                          << "  " << event.track.reads << " reads\n";
            }
        }
        std::cout.flush();
    };

    long long index = 0;
    while (std::fread(frame.data(), 1, frame_bytes, stdin) == frame_bytes) {
        if (index % arguments.every == 0) {
            const double timestamp = 1000.0 * static_cast<double>(index) / arguments.fps;
            const lpr::ImageView view =
                lpr::packed_view(frame, arguments.width, arguments.height, lpr::PixelFormat::rgb);
            print(tracker.update(reader.pipeline.run(view, reader.engine), timestamp));
        }
        ++index;
    }
    print(tracker.finish());
    std::cerr << index << " frames, " << plates.size() << (plates.size() == 1 ? " plate" : " plates");
    for (const auto& [id, track] : plates) {
        std::cerr << (id == plates.begin()->first ? ": " : ", ") << track.read.text;
    }
    std::cerr << '\n';
    return 0;
}

// The pipeline scored on benchmark folders in the OpenALPR format: each image beside a text file holding its name, the
// plate's box (x, y, width, height), and its text.
std::string normalized(std::string_view text, bool o_is_zero) {
    std::string result;
    for (const char c : text) {
        if (std::isalnum(static_cast<unsigned char>(c)) != 0) {
            const auto upper = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
            result.push_back(o_is_zero && upper == 'O' ? '0' : upper);
        }
    }
    return result;
}

struct Outcome {
    std::string dataset;
    std::string image;
    std::string truth;
    std::string read;  // empty when no detection overlapped the plate
    bool found = false;
    bool exact = false;
    bool exact_o_zero = false;
    float confidence = 0.0F;
    int detections = 0;
    double milliseconds = 0.0;
};

struct Tally {
    int images = 0;
    int found = 0;
    int exact = 0;
    int exact_o_zero = 0;
    int extra = 0;
    double milliseconds = 0.0;

    void add(const Outcome& outcome) {
        ++images;
        found += outcome.found ? 1 : 0;
        exact += outcome.exact ? 1 : 0;
        exact_o_zero += outcome.exact_o_zero ? 1 : 0;
        extra += outcome.detections - (outcome.found ? 1 : 0);
        milliseconds += outcome.milliseconds;
    }
};

void write_tally(lpr::JsonWriter& json, const Tally& tally) {
    json.key("images").value(tally.images);
    json.key("plates_found").value(tally.found);
    json.key("read_exactly").value(tally.exact);
    json.key("read_exactly_o_as_zero").value(tally.exact_o_zero);
    json.key("other_detections").value(tally.extra);
    json.key("detection_rate").value(tally.images > 0 ? static_cast<double>(tally.found) / tally.images : 0.0, 4);
    json.key("accuracy").value(tally.images > 0 ? static_cast<double>(tally.exact) / tally.images : 0.0, 4);
    json.key("accuracy_o_as_zero")
        .value(tally.images > 0 ? static_cast<double>(tally.exact_o_zero) / tally.images : 0.0, 4);
}

void print_tally(std::string_view name, const Tally& tally) {
    const auto rate = [&](int count) {
        return percent(tally.images > 0 ? static_cast<double>(count) / tally.images : 0);
    };
    std::cout << std::left << std::setw(10) << name << std::right << std::setw(7) << tally.images << std::setw(14)
              << (std::to_string(tally.found) + " " + rate(tally.found)) << std::setw(16)
              << (std::to_string(tally.exact) + " " + rate(tally.exact)) << std::setw(16)
              << (std::to_string(tally.exact_o_zero) + " " + rate(tally.exact_o_zero)) << std::setw(12)
              << fixed(tally.images > 0 ? tally.milliseconds / tally.images : 0.0, 1) << '\n';
}

int evaluate(const Arguments& arguments) {
    if (arguments.inputs.empty()) {
        throw UsageError("evaluate needs benchmark folders");
    }
    Reader reader(arguments);
    std::vector<Outcome> outcomes;
    for (const std::string& input : arguments.inputs) {
        const fs::path folder(input);
        std::vector<fs::path> labels;
        for (const fs::directory_entry& entry : fs::directory_iterator(folder)) {
            if (entry.path().extension() == ".txt") {
                labels.push_back(entry.path());
            }
        }
        std::sort(labels.begin(), labels.end());
        const std::string dataset =
            folder.filename().empty() ? folder.parent_path().filename().string() : folder.filename().string();
        for (const fs::path& label : labels) {
            std::ifstream stream(label);
            std::string name;
            float x = 0;
            float y = 0;
            float w = 0;
            float h = 0;
            std::string truth;
            if (!(stream >> name >> x >> y >> w >> h >> truth)) {
                std::cerr << "lpr: skipping " << label.string() << ": not an OpenALPR label\n";
                continue;
            }
            const lpr::Image image = lpr::read_image(folder / name);
            lpr::Timings timings;
            const lpr::FrameResult& frame = reader.pipeline.run(image.view(), reader.engine, &timings);
            const lpr::Box expected{x, y, x + w, y + h};

            Outcome outcome;
            outcome.dataset = dataset;
            outcome.image = name;
            outcome.truth = truth;
            outcome.detections = static_cast<int>(frame.plates.size());
            outcome.milliseconds = timings.total_ms;
            float best = 0.0F;
            for (const lpr::PlateResult& plate : frame.plates) {
                const float overlap = lpr::iou(plate.detection.box, expected);
                if (overlap >= 0.5F && overlap > best) {
                    best = overlap;
                    outcome.found = true;
                    outcome.read = plate.read.text;
                    outcome.confidence = plate.read.confidence;
                }
            }
            outcome.exact = outcome.found && normalized(outcome.read, false) == normalized(truth, false);
            outcome.exact_o_zero = outcome.found && normalized(outcome.read, true) == normalized(truth, true);
            outcomes.push_back(outcome);
        }
    }

    std::map<std::string, Tally> tallies;
    Tally total;
    for (const Outcome& outcome : outcomes) {
        tallies[outcome.dataset].add(outcome);
        total.add(outcome);
    }
    std::cout << std::left << std::setw(10) << "dataset" << std::right << std::setw(7) << "images" << std::setw(14)
              << "found" << std::setw(16) << "read exactly" << std::setw(16) << "with O as 0" << std::setw(12)
              << "ms/image" << '\n';
    for (const auto& [name, tally] : tallies) {
        print_tally(name, tally);
    }
    print_tally("total", total);

    // How accuracy grows as the least confident reads are set aside.
    std::vector<const Outcome*> found;
    for (const Outcome& outcome : outcomes) {
        if (outcome.found) {
            found.push_back(&outcome);
        }
    }
    std::stable_sort(found.begin(), found.end(), [](const Outcome* a, const Outcome* b) {
        return a->confidence > b->confidence;
    });
    struct Coverage {
        double share;
        double accuracy;
        double threshold;
    };
    std::vector<Coverage> coverage;
    for (const double share : {1.0, 0.95, 0.9, 0.8}) {
        const auto kept = static_cast<std::size_t>(std::llround(share * static_cast<double>(found.size())));
        if (kept == 0) {
            continue;
        }
        const auto correct = std::count_if(found.begin(),
                                           found.begin() + static_cast<std::ptrdiff_t>(kept),
                                           [](const Outcome* outcome) { return outcome->exact; });
        coverage.push_back(
            Coverage{share, static_cast<double>(correct) / static_cast<double>(kept), found[kept - 1]->confidence});
    }
    std::cout << "\nkeeping the most confident reads:";
    for (const Coverage& point : coverage) {
        std::cout << "  " << fixed(100 * point.share, 0) << "% -> " << percent(point.accuracy)
                  << " exact (confidence >= " << fixed(point.threshold, 3) << ")";
    }
    std::cout << '\n';

    if (arguments.misses) {
        std::cout << '\n';
        for (const Outcome& outcome : outcomes) {
            if (!outcome.exact) {
                std::cout << outcome.dataset << '/' << outcome.image << ": " << outcome.truth << " read as "
                          << (outcome.found ? outcome.read : "(not found)") << '\n';
            }
        }
    }

    if (arguments.report) {
        lpr::JsonWriter json(true);
        json.begin_object();
        json.key("total").begin_object();
        write_tally(json, total);
        json.end_object();
        json.key("datasets").begin_object();
        for (const auto& [name, tally] : tallies) {
            json.key(name).begin_object();
            write_tally(json, tally);
            json.end_object();
        }
        json.end_object();
        json.key("coverage").begin_array();
        for (const Coverage& point : coverage) {
            json.begin_object();
            json.key("share").value(point.share, 2);
            json.key("accuracy").value(point.accuracy, 4);
            json.key("min_confidence").value(point.threshold, 4);
            json.end_object();
        }
        json.end_array();
        json.key("misses").begin_array();
        for (const Outcome& outcome : outcomes) {
            if (!outcome.exact) {
                json.begin_object();
                json.key("image").value(outcome.dataset + "/" + outcome.image);
                if (outcome.found) {
                    json.key("read").value(outcome.read);
                    json.key("confidence").value(outcome.confidence, 4);
                } else {
                    json.key("read").null();
                }
                json.key("o_as_zero").value(outcome.exact_o_zero);
                json.end_object();
            }
        }
        json.end_array();
        json.end_object();
        std::ofstream(*arguments.report) << json.str() << '\n';
    }
    return 0;
}

int bench(const Arguments& arguments) {
    if (arguments.inputs.size() != 1) {
        throw UsageError("bench times one image");
    }
    Reader reader(arguments);
    const lpr::Image image = lpr::read_image(arguments.inputs[0]);
    for (int i = 0; i < 3; ++i) {
        reader.pipeline.run(image.view(), reader.engine);
    }
    std::vector<lpr::Timings> runs(static_cast<std::size_t>(arguments.runs));
    for (lpr::Timings& timings : runs) {
        reader.pipeline.run(image.view(), reader.engine, &timings);
    }
    const auto summarize = [&](std::string_view stage, double lpr::Timings::* field) {
        std::vector<double> values;
        values.reserve(runs.size());
        for (const lpr::Timings& timings : runs) {
            values.push_back(timings.*field);
        }
        std::sort(values.begin(), values.end());
        const double mean = std::accumulate(values.begin(), values.end(), 0.0) / static_cast<double>(values.size());
        const auto at = [&](double quantile) {
            return values[static_cast<std::size_t>(quantile * static_cast<double>(values.size() - 1))];
        };
        std::cout << std::left << std::setw(14) << stage << std::right << std::setw(9) << fixed(mean, 2) << std::setw(9)
                  << fixed(at(0.5), 2) << std::setw(9) << fixed(at(0.95), 2) << '\n';
    };
    const std::size_t plates = reader.pipeline.result().plates.size();
    std::cout << image.width() << "x" << image.height() << ", " << plates << (plates == 1 ? " plate, " : " plates, ")
              << runs.size() << " runs on ONNX Runtime " << lpr::OnnxEngine::runtime_version() << " (CPU)\n"
              << std::left << std::setw(14) << "stage (ms)" << std::right << std::setw(9) << "mean" << std::setw(9)
              << "median" << std::setw(9) << "p95" << '\n';
    summarize("detector", &lpr::Timings::detector_ms);
    summarize("recognizer", &lpr::Timings::recognizer_ms);
    summarize("the rest", &lpr::Timings::preprocess_ms);
    summarize("total", &lpr::Timings::total_ms);
    return 0;
}

}  // namespace

int main(int argc, char** argv) {
    try {
        const std::vector<std::string_view> words(argv + 1, argv + argc);
        if (std::find(words.begin(), words.end(), "--help") != words.end() ||
            std::find(words.begin(), words.end(), "-h") != words.end()) {
            std::cout << kUsage;
            return 0;
        }
        if (std::find(words.begin(), words.end(), "--version") != words.end()) {
            std::cout << "lpr " << LPR_VERSION << ", ONNX Runtime " << lpr::OnnxEngine::runtime_version() << '\n';
            return 0;
        }
        const Arguments arguments = parse(argc, argv);
        if (arguments.command == "video") {
            return read_video(arguments);
        }
        if (arguments.command == "evaluate") {
            return evaluate(arguments);
        }
        if (arguments.command == "bench") {
            return bench(arguments);
        }
        return read_images(arguments);
    } catch (const UsageError& error) {
        std::cerr << "lpr: " << error.what() << "\n\n" << kUsage;
        return 2;
    } catch (const std::exception& error) {
        std::cerr << "lpr: " << error.what() << '\n';
        return 1;
    }
}
