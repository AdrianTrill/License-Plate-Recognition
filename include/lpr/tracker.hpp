#pragma once

#include <cstdint>
#include <vector>

#include "lpr/detector.hpp"
#include "lpr/pipeline.hpp"
#include "lpr/recognizer.hpp"

namespace lpr {

struct TrackerOptions {
    float match_iou = 0.1F;       // least overlap between a track's predicted box and a detection that continues it
    double max_gap_ms = 1000.0;   // a track unseen for this long has left
    int min_reads = 3;            // reads before a track is reported
    float min_confidence = 0.6F;  // the fused reading's confidence before a track is reported
};

// A plate followed across frames, with its reads fused into one.
struct Track {
    int id = 0;
    Box box;         // where it was last seen
    PlateRead read;  // every read so far, fused: per-slot probabilities averaged, weighted by each read's confidence
    int seen = 0;    // frames it was detected in
    int reads = 0;   // frames whose reading was fused: those where the plate was clear of the frame's edges
    double first_seen_ms = 0.0;
    double last_seen_ms = 0.0;
    float best_score = 0.0F;  // the detector's highest score for it
    bool reported = false;    // enough reads, confidently enough
    bool visible = false;     // read in the latest frame
};

enum class TrackEventKind : std::uint8_t {
    reported,  // a track has its first confident reading
    changed,   // a reported track's text changed as more reads came in
    ended,     // a reported track left
};

struct TrackEvent {
    TrackEventKind kind = TrackEventKind::reported;
    Track track;
};

const char* to_string(TrackEventKind kind) noexcept;

// Follows plates through a video: matches each frame's plates to tracks by overlap with where each track should be
// by now, or failing that by distance, and fuses every track's reads, so one blurred frame can't change a plate. A
// plate touching the frame's edge may be cut off, and a cut-off plate reads confidently but wrongly ("08ZJE" for
// "B108ZJE"), so such frames move the track but are not read into it. Reads are fused by length, and the length with
// the most weight wins: a misread character is outvoted slot by slot, while a reading that lost or gained a character
// is not averaged into the others.
class PlateTracker {
public:
    explicit PlateTracker(TrackerOptions options = {}, const RecognizerConfig& config = plate_recognizer_config());

    // Adds a frame's plates; returns what happened to the tracks.
    std::vector<TrackEvent> update(const FrameResult& frame, double timestamp_ms);

    // Ends every track, as at the end of a video.
    std::vector<TrackEvent> finish();

    void reset();

    [[nodiscard]] const std::vector<Track>& tracks() const noexcept {
        return tracks_;
    }
    [[nodiscard]] const TrackerOptions& options() const noexcept {
        return options_;
    }
    void set_options(const TrackerOptions& options) noexcept {
        options_ = options;
    }

private:
    // Reads of one length, summed, each weighted by its confidence.
    struct Reads {
        std::size_t length = 0;
        std::vector<double> probabilities;
        std::vector<double> region_probabilities;
        double weight = 0.0;
    };

    struct Fusion {
        std::vector<Reads> by_length;
        float velocity_x = 0.0F;  // the box center's, in pixels per millisecond
        float velocity_y = 0.0F;
        std::string reported_text;
    };

    void absorb(std::size_t index, const PlateResult& plate, double timestamp_ms, bool readable);
    [[nodiscard]] Box predicted(std::size_t index, double timestamp_ms) const noexcept;

    TrackerOptions options_;
    const RecognizerConfig* config_;
    std::vector<Track> tracks_;
    std::vector<Fusion> fusions_;
    int next_id_ = 1;
};

}  // namespace lpr
