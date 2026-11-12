#include "lpr/tracker.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <span>
#include <string>
#include <utility>

namespace lpr {

namespace {

struct Candidate {
    float key = 0.0F;
    std::size_t track = 0;
    std::size_t plate = 0;
};

float center_x(const Box& box) noexcept {
    return 0.5F * (box.x1 + box.x2);
}

float center_y(const Box& box) noexcept {
    return 0.5F * (box.y1 + box.y2);
}

}  // namespace

const char* to_string(TrackEventKind kind) noexcept {
    switch (kind) {
        case TrackEventKind::reported:
            return "reported";
        case TrackEventKind::changed:
            return "changed";
        case TrackEventKind::ended:
            return "ended";
    }
    return "unknown";
}

PlateTracker::PlateTracker(TrackerOptions options, const RecognizerConfig& config)
    : options_(options), config_(&config) {}

bool PlateTracker::confident(const PlateRead& read) const noexcept {
    return read.confidence >= options_.min_confidence && read.text.size() >= options_.min_characters;
}

// A track as it ends: with its text's most confident reading, which the frames as it left may have blurred.
Track PlateTracker::ending(std::size_t index) const {
    Track track = tracks_[index];
    track.read = fusions_[index].reported;
    return track;
}

void PlateTracker::reset() {
    tracks_.clear();
    fusions_.clear();
    next_id_ = 1;
}

Box PlateTracker::predicted(std::size_t index, double timestamp_ms) const noexcept {
    const Track& track = tracks_[index];
    const Fusion& fusion = fusions_[index];
    const auto elapsed = static_cast<float>(timestamp_ms - track.last_seen_ms);
    const float dx = fusion.velocity_x * elapsed;
    const float dy = fusion.velocity_y * elapsed;
    return Box{track.box.x1 + dx, track.box.y1 + dy, track.box.x2 + dx, track.box.y2 + dy};
}

void PlateTracker::absorb(std::size_t index, const PlateResult& plate, double timestamp_ms, bool readable) {
    Track& track = tracks_[index];
    Fusion& fusion = fusions_[index];
    const Box& box = plate.detection.box;
    const double elapsed = timestamp_ms - track.last_seen_ms;
    if (track.seen > 0 && elapsed > 0.0) {
        const auto vx = static_cast<float>((center_x(box) - center_x(track.box)) / elapsed);
        const auto vy = static_cast<float>((center_y(box) - center_y(track.box)) / elapsed);
        const bool first = track.seen == 1;
        fusion.velocity_x = first ? vx : (0.5F * fusion.velocity_x) + (0.5F * vx);
        fusion.velocity_y = first ? vy : (0.5F * fusion.velocity_y) + (0.5F * vy);
    }
    track.box = box;
    track.last_seen_ms = timestamp_ms;
    track.best_score = std::max(track.best_score, plate.detection.score);
    track.visible = true;
    ++track.seen;

    const PlateRead& read = plate.read;
    if (!readable || read.probabilities.empty()) {
        return;
    }
    ++track.reads;
    // Sharp frames read confidently; blurred ones spread their probability, and count for less.
    const double weight = std::max(static_cast<double>(read.confidence), 0.01);
    auto group = std::find_if(fusion.by_length.begin(), fusion.by_length.end(), [&](const Reads& reads) {
        return reads.length == read.text.size();
    });
    if (group == fusion.by_length.end()) {
        fusion.by_length.push_back(Reads{read.text.size(), {}, {}, 0.0});
        group = fusion.by_length.end() - 1;
    }
    group->probabilities.resize(read.probabilities.size(), 0.0);
    for (std::size_t i = 0; i < read.probabilities.size(); ++i) {
        group->probabilities[i] += weight * read.probabilities[i];
    }
    if (!read.region_probabilities.empty()) {
        group->region_probabilities.resize(read.region_probabilities.size(), 0.0);
        for (std::size_t i = 0; i < read.region_probabilities.size(); ++i) {
            group->region_probabilities[i] += weight * read.region_probabilities[i];
        }
    }
    group->weight += weight;

    const Reads& best = *std::max_element(fusion.by_length.begin(),
                                          fusion.by_length.end(),
                                          [](const Reads& a, const Reads& b) { return a.weight < b.weight; });
    std::vector<float> probabilities(best.probabilities.size());
    std::transform(best.probabilities.begin(), best.probabilities.end(), probabilities.begin(), [&](double sum) {
        return static_cast<float>(sum / best.weight);
    });
    std::vector<float> region_probabilities(best.region_probabilities.size());
    std::transform(best.region_probabilities.begin(),
                   best.region_probabilities.end(),
                   region_probabilities.begin(),
                   [&](double sum) { return static_cast<float>(sum / best.weight); });
    track.read = decode_plate(probabilities, region_probabilities, *config_);
}

std::vector<TrackEvent> PlateTracker::update(const FrameResult& frame, double timestamp_ms) {
    for (Track& track : tracks_) {
        track.visible = false;
    }
    const std::size_t track_count = tracks_.size();
    const std::size_t plate_count = frame.plates.size();
    std::vector<Box> predictions(track_count);
    for (std::size_t t = 0; t < track_count; ++t) {
        predictions[t] = predicted(t, timestamp_ms);
    }

    std::vector<std::ptrdiff_t> track_of_plate(plate_count, -1);
    std::vector<bool> matched(track_count, false);
    const auto assign = [&](std::vector<Candidate>& candidates, bool largest_first) {
        std::stable_sort(candidates.begin(), candidates.end(), [&](const Candidate& a, const Candidate& b) {
            return largest_first ? a.key > b.key : a.key < b.key;
        });
        for (const Candidate& candidate : candidates) {
            if (!matched[candidate.track] && track_of_plate[candidate.plate] < 0) {
                matched[candidate.track] = true;
                track_of_plate[candidate.plate] = static_cast<std::ptrdiff_t>(candidate.track);
            }
        }
    };

    std::vector<Candidate> candidates;
    for (std::size_t t = 0; t < track_count; ++t) {
        for (std::size_t p = 0; p < plate_count; ++p) {
            const float overlap = iou(predictions[t], frame.plates[p].detection.box);
            if (overlap >= options_.match_iou) {
                candidates.push_back(Candidate{overlap, t, p});
            }
        }
    }
    assign(candidates, true);

    // A second chance for plates that moved too far between frames to overlap: the nearest track of about the same
    // size, within a plate's width.
    candidates.clear();
    for (std::size_t t = 0; t < track_count; ++t) {
        for (std::size_t p = 0; p < plate_count; ++p) {
            if (matched[t] || track_of_plate[p] >= 0) {
                continue;
            }
            const Box& expected = predictions[t];
            const Box& seen = frame.plates[p].detection.box;
            const float ratio = seen.width() / std::max(expected.width(), 1.0F);
            if (ratio < 0.5F || ratio > 2.0F) {
                continue;
            }
            const float dx = center_x(seen) - center_x(expected);
            const float dy = center_y(seen) - center_y(expected);
            const float distance = std::sqrt((dx * dx) + (dy * dy));
            if (distance <= std::max(expected.width(), seen.width())) {
                candidates.push_back(Candidate{distance, t, p});
            }
        }
    }
    assign(candidates, false);

    // Near the frame's edge a plate may be cut off: within 4 pixels, or 0.5% of the frame, whichever is more.
    const float edge = std::max(4.0F, 0.005F * static_cast<float>(std::max(frame.width, frame.height)));
    const auto readable = [&](const Box& box) {
        if (frame.width <= 0 || frame.height <= 0) {
            return true;
        }
        return box.x1 >= edge && box.y1 >= edge && box.x2 <= static_cast<float>(frame.width) - edge &&
               box.y2 <= static_cast<float>(frame.height) - edge;
    };
    for (std::size_t p = 0; p < plate_count; ++p) {
        const bool clear = readable(frame.plates[p].detection.box);
        if (track_of_plate[p] >= 0) {
            absorb(static_cast<std::size_t>(track_of_plate[p]), frame.plates[p], timestamp_ms, clear);
            continue;
        }
        Track track;
        track.id = next_id_++;
        track.first_seen_ms = timestamp_ms;
        track.last_seen_ms = timestamp_ms;
        tracks_.push_back(std::move(track));
        fusions_.emplace_back();
        absorb(tracks_.size() - 1, frame.plates[p], timestamp_ms, clear);
    }

    std::vector<TrackEvent> events;
    for (std::size_t i = 0; i < tracks_.size(); ++i) {
        Track& track = tracks_[i];
        Fusion& fusion = fusions_[i];
        if (!track.visible || track.read.text.empty()) {
            continue;
        }
        // A reported track keeps its text's most confident reading. Only another confident reading changes the text,
        // and the track is reported again when it does.
        if (!track.reported) {
            if (track.reads >= options_.min_reads && confident(track.read)) {
                track.reported = true;
                fusion.reported = track.read;
                events.push_back(TrackEvent{TrackEventKind::reported, track});
            }
        } else if (confident(track.read)) {
            if (track.read.text != fusion.reported.text) {
                fusion.reported = track.read;
                events.push_back(TrackEvent{TrackEventKind::changed, track});
            } else if (track.read.confidence > fusion.reported.confidence) {
                fusion.reported = track.read;
            }
        }
    }

    std::size_t kept = 0;
    for (std::size_t i = 0; i < tracks_.size(); ++i) {
        if (timestamp_ms - tracks_[i].last_seen_ms > options_.max_gap_ms) {
            if (tracks_[i].reported) {
                events.push_back(TrackEvent{TrackEventKind::ended, ending(i)});
            }
            continue;
        }
        if (kept != i) {
            tracks_[kept] = std::move(tracks_[i]);
            fusions_[kept] = std::move(fusions_[i]);
        }
        ++kept;
    }
    tracks_.resize(kept);
    fusions_.resize(kept);
    return events;
}

std::vector<TrackEvent> PlateTracker::finish() {
    std::vector<TrackEvent> events;
    for (std::size_t i = 0; i < tracks_.size(); ++i) {
        if (tracks_[i].reported) {
            events.push_back(TrackEvent{TrackEventKind::ended, ending(i)});
        }
    }
    tracks_.clear();
    fusions_.clear();
    return events;
}

}  // namespace lpr
