#include "lpr/tracker.hpp"

#include <algorithm>
#include <string>
#include <string_view>
#include <vector>

#include "check.hpp"
#include "readings.hpp"

namespace {

using check::expect;
using check::expect_equal;

const lpr::RecognizerConfig& config = lpr::plate_recognizer_config();

lpr::PlateRead reading(std::string_view text, float confidence, std::size_t blurred_slot = 99, char blurred_as = 0) {
    return lpr::decode_plate(readings::slots(text, confidence, blurred_slot, blurred_as), {}, config);
}

lpr::PlateResult plate_at(float x, float y, const lpr::PlateRead& read) {
    lpr::PlateResult plate;
    plate.detection = lpr::Detection{lpr::Box{x, y, x + 100.0F, y + 25.0F}, 0.9F};
    plate.read = read;
    return plate;
}

lpr::FrameResult frame(std::vector<lpr::PlateResult> plates) {
    return lpr::FrameResult{1280, 720, std::move(plates)};
}

// Events as "kind:text", space separated, appended to a log of earlier ones.
std::string kinds(const std::vector<lpr::TrackEvent>& events, const std::string& log = "") {
    std::string text = log;
    for (const lpr::TrackEvent& event : events) {
        text += std::string(text.empty() ? "" : " ") + lpr::to_string(event.kind) + ":" + event.track.read.text;
    }
    return text;
}

}  // namespace

int main() {
    return check::run({
        {"a moving plate keeps one track, reported once it is read confidently three times",
         [] {
             lpr::PlateTracker tracker;
             std::string log;
             for (int i = 0; i < 8; ++i) {
                 const auto events = tracker.update(
                     frame({plate_at(100.0F + (10.0F * static_cast<float>(i)), 300, reading("CJ12ABC", 0.99F))}),
                     33.0 * i);
                 log = kinds(events, log);
                 expect_equal(tracker.tracks().size(), std::size_t{1}, "one track");
                 expect_equal(tracker.tracks()[0].id, 1, "the same track");
             }
             expect_equal(log, std::string("reported:CJ12ABC"), "events");
             expect_equal(tracker.tracks()[0].reads, 8, "reads");
             expect(tracker.tracks()[0].visible, "seen in the last frame");
             expect_equal(kinds(tracker.update(frame({}), 500.0)), std::string(""), "still within the gap");
             expect(!tracker.tracks()[0].visible, "not seen in the last frame");
             expect_equal(kinds(tracker.update(frame({}), 1400.0)), std::string("ended:CJ12ABC"), "gone");
             expect(tracker.tracks().empty(), "no tracks left");
         }},
        {"fusing reads outvotes a blurred frame",
         [] {
             lpr::PlateTracker tracker;
             const lpr::PlateRead blurred = reading("AB123", 0.6F, 1, '8');
             expect_equal(blurred.text, std::string("A8123"), "the blurred frame alone");
             std::string log = kinds(tracker.update(frame({plate_at(100, 300, blurred)}), 0.0));
             for (int i = 1; i < 4; ++i) {
                 log = kinds(tracker.update(frame({plate_at(100, 300, reading("AB123", 0.99F))}), 33.0 * i), log);
             }
             expect_equal(log, std::string("reported:AB123"), "the sharp reads win");
             expect_equal(tracker.tracks()[0].read.text, std::string("AB123"), "the fused text");
         }},
        {"a reported reading that changes is reported again",
         [] {
             lpr::PlateTracker tracker;
             std::string log;
             for (int i = 0; i < 3; ++i) {
                 log = kinds(tracker.update(frame({plate_at(100, 300, reading("AB123", 0.97F))}), 33.0 * i), log);
             }
             for (int i = 3; i < 10; ++i) {
                 log = kinds(tracker.update(frame({plate_at(100, 300, reading("AB128", 0.999F))}), 33.0 * i), log);
             }
             expect_equal(log, std::string("reported:AB123 changed:AB128"), "events");
         }},
        {"two plates get two tracks",
         [] {
             lpr::PlateTracker tracker;
             for (int i = 0; i < 5; ++i) {
                 const float step = 12.0F * static_cast<float>(i);
                 tracker.update(frame({plate_at(100 + step, 300, reading("CJ12ABC", 0.99F)),
                                       plate_at(900 - step, 320, reading("B123XYZ", 0.99F))}),
                                33.0 * i);
             }
             expect_equal(tracker.tracks().size(), std::size_t{2}, "tracks");
             expect_equal(tracker.tracks()[0].read.text, std::string("CJ12ABC"), "first");
             expect_equal(tracker.tracks()[1].read.text, std::string("B123XYZ"), "second");
             expect_equal(tracker.tracks()[0].reads + tracker.tracks()[1].reads, 10, "every read went to its plate");
         }},
        {"a plate too fast to overlap between frames is followed by distance, then by its velocity",
         [] {
             lpr::PlateTracker tracker;
             for (int i = 0; i < 6; ++i) {
                 tracker.update(
                     frame({plate_at(20.0F + (90.0F * static_cast<float>(i)), 300, reading("FAST1", 0.99F))}),
                     40.0 * i);
                 expect_equal(tracker.tracks().size(), std::size_t{1}, "one track at frame " + std::to_string(i));
             }
             expect_equal(tracker.tracks()[0].reads, 6, "reads");
         }},
        {"unconfident tracks are never reported",
         [] {
             lpr::PlateTracker tracker;
             std::string log;
             for (int i = 0; i < 10; ++i) {
                 log = kinds(tracker.update(frame({plate_at(100, 300, reading("XY99", 0.8F))}), 33.0 * i), log);
             }
             log = kinds(tracker.finish(), log);
             expect_equal(log, std::string(""), "0.8 per slot is 0.11 for the reading");
         }},
        {"a reading that lost a character is not averaged into the others",
         [] {
             lpr::PlateTracker tracker;
             std::string log;
             for (int i = 0; i < 6; ++i) {
                 // Every other frame drops the first character, as a partly hidden plate can read.
                 const lpr::PlateRead read = i % 2 == 0 ? reading("B108ZJE", 0.99F) : reading("108ZJE", 0.95F);
                 log = kinds(tracker.update(frame({plate_at(200, 300, read)}), 33.0 * i), log);
             }
             expect_equal(log, std::string("reported:B108ZJE"), "events");
             expect(tracker.tracks()[0].read.confidence > 0.9F, "the whole reads agree");
         }},
        {"a plate cut off by the frame's edge is followed but not read",
         [] {
             lpr::PlateTracker tracker;
             std::string log;
             // Sliding in from the left edge: the first frames show a cut-off plate, read confidently but wrongly.
             for (int i = 0; i < 3; ++i) {
                 log = kinds(tracker.update(frame({plate_at(0, 300, reading("08ZJE", 0.99F))}), 33.0 * i), log);
             }
             expect_equal(tracker.tracks().size(), std::size_t{1}, "followed");
             expect_equal(tracker.tracks()[0].seen, 3, "seen");
             expect_equal(tracker.tracks()[0].reads, 0, "but not read");
             for (int i = 3; i < 6; ++i) {
                 log = kinds(tracker.update(
                                 frame({plate_at(40.0F * static_cast<float>(i - 2), 300, reading("B108ZJE", 0.99F))}),
                                 33.0 * i),
                             log);
             }
             expect_equal(log, std::string("reported:B108ZJE"), "only whole plates are read");
             expect_equal(tracker.tracks()[0].reads, 3, "reads");
         }},
        {"partial readings are never reported",
         [] {
             lpr::PlateTracker tracker;
             std::string log;
             for (int i = 0; i < 6; ++i) {
                 log = kinds(tracker.update(frame({plate_at(200, 300, reading("68", 0.99F))}), 33.0 * i), log);
             }
             log = kinds(tracker.finish(), log);
             expect_equal(log, std::string(""), "two characters are followed, not reported");
         }},
        {"a reported reading gives way only to another confident one, and the track ends with it",
         [] {
             lpr::PlateTracker tracker;
             std::string log;
             for (int i = 0; i < 3; ++i) {
                 log = kinds(tracker.update(frame({plate_at(200, 300, reading("SB27RMF", 0.99F))}), 33.0 * i), log);
             }
             // As the car turns away, only part of its plate reads, many times over.
             for (int i = 3; i < 12; ++i) {
                 log = kinds(tracker.update(frame({plate_at(200, 300, reading("SBF", 0.99F))}), 33.0 * i), log);
             }
             expect_equal(tracker.tracks()[0].read.text, std::string("SBF"), "the fused reading is partial now");
             log = kinds(tracker.finish(), log);
             expect_equal(log, std::string("reported:SB27RMF ended:SB27RMF"), "events");
         }},
        {"a track ends with its text's most confident reading, not the first or the last",
         [] {
             lpr::PlateTracker tracker;
             std::vector<lpr::TrackEvent> events;
             float peak = 0.0F;
             // Far away, the plate reads just confidently enough to be reported; closer, it reads sharply; leaving,
             // it blurs again, and its fused reading grows less sure.
             for (int i = 0; i < 24; ++i) {
                 const float sureness = (i < 3 || i >= 12) ? 0.955F : 0.999F;
                 for (lpr::TrackEvent& event :
                      tracker.update(frame({plate_at(200, 300, reading("CJ01RMM", sureness))}), 33.0 * i)) {
                     events.push_back(event);
                 }
                 peak = std::max(peak, tracker.tracks()[0].read.confidence);
             }
             expect(tracker.tracks()[0].read.confidence < peak, "the blurred reads lowered the fused reading");
             for (lpr::TrackEvent& event : tracker.finish()) {
                 events.push_back(event);
             }
             expect_equal(kinds(events), std::string("reported:CJ01RMM ended:CJ01RMM"), "events");
             expect(events[0].track.read.confidence < 0.7F, "reported as soon as it was confident");
             expect(events[1].track.read.confidence == peak, "ended with its most confident reading");
             expect(peak > 0.85F, "which fused the sharp reads in");
         }},
        {"finishing ends every reported track",
         [] {
             lpr::PlateTracker tracker;
             for (int i = 0; i < 3; ++i) {
                 tracker.update(frame({plate_at(100, 300, reading("END1", 0.99F))}), 33.0 * i);
             }
             expect_equal(kinds(tracker.finish()), std::string("ended:END1"), "events");
             expect(tracker.tracks().empty(), "no tracks left");
             tracker.update(frame({plate_at(100, 300, reading("END1", 0.99F))}), 200.0);
             expect_equal(tracker.tracks()[0].id, 2, "ids keep counting");
             tracker.reset();
             tracker.update(frame({plate_at(100, 300, reading("END1", 0.99F))}), 0.0);
             expect_equal(tracker.tracks()[0].id, 1, "until reset");
         }},
    });
}
