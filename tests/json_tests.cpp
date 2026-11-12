#include "lpr/json.hpp"

#include <limits>
#include <string>

#include "check.hpp"
#include "readings.hpp"

namespace {

using check::expect_equal;

const lpr::RecognizerConfig& config = lpr::plate_recognizer_config();

lpr::FrameResult one_plate() {
    lpr::PlateResult plate;
    plate.detection = lpr::Detection{lpr::Box{10.04F, 20.06F, 110.0F, 45.5F}, 0.87654F};
    plate.region = lpr::Rect{10, 20, 100, 25};
    plate.read = lpr::decode_plate(readings::slots("B12", 0.9F), readings::regions("Romania", 0.75F), config);
    return lpr::FrameResult{640, 480, {plate}};
}

}  // namespace

int main() {
    return check::run({
        {"strings are escaped",
         [] {
             lpr::JsonWriter json;
             json.value(std::string_view("a \"plate\"\\\n\t\x01"));
             expect_equal(json.str(), std::string(R"("a \"plate\"\\\n\t\u0001")"), "escaped");
         }},
        {"numbers have fixed decimals, and never print -0",
         [] {
             lpr::JsonWriter json;
             json.begin_array().value(0.123456, 4).value(2.0, 1).value(-0.00001, 4).value(-1.25, 1).value(7);
             json.value(std::numeric_limits<double>::infinity(), 2).end_array();
             expect_equal(json.str(), std::string("[0.1235,2.0,0.0000,-1.2,7,null]"), "numbers");
         }},
        {"objects and arrays nest, compactly or indented",
         [] {
             lpr::JsonWriter compact;
             compact.begin_object().key("a").begin_array().value(true).null().end_array().key("b").begin_object();
             compact.end_object().end_object();
             expect_equal(compact.str(), std::string(R"({"a":[true,null],"b":{}})"), "compact");
             lpr::JsonWriter pretty(true);
             pretty.begin_object().key("a").begin_array().value(1).end_array();
             pretty.key("b").begin_array(true).value(1).value(2).begin_array().value(3).end_array().end_array();
             pretty.end_object();
             expect_equal(pretty.str(), std::string("{\n  \"a\": [\n    1\n  ],\n  \"b\": [1, 2, [3]]\n}"), "pretty");
         }},
        {"a frame lists its plates with their characters and alternatives",
         [] {
             const std::string expected =
                 R"({"width":640,"height":480,"plates":[{"text":"B12","confidence":0.3487,)"
                 R"("box":[10.0,20.1,110.0,45.5],"score":0.8765,"crop":[10,20,100,25],)"
                 R"("region":{"name":"Romania","code":"RO","confidence":0.7500},"characters":[)"
                 R"({"char":"B","confidence":0.9000,"alternatives":[["0",0.0028],["1",0.0028]]},)"
                 R"({"char":"1","confidence":0.9000,"alternatives":[["0",0.0028],["2",0.0028]]},)"
                 R"({"char":"2","confidence":0.9000,"alternatives":[["0",0.0028],["1",0.0028]]}]}]})";
             expect_equal(lpr::frame_json(one_plate(), config), expected, "frame");
         }},
        {"a plate without a region head has a null region",
         [] {
             lpr::FrameResult frame = one_plate();
             frame.plates[0].read = lpr::decode_plate(readings::slots("", 0.9F), {}, config);
             expect_equal(lpr::frame_json(frame, config).find(R"("text":"","confidence":0.3487)") != std::string::npos,
                          true,
                          "an empty reading");
             expect_equal(lpr::frame_json(frame, config).find(R"("region":null,"characters":[])") != std::string::npos,
                          true,
                          "no region, no characters");
         }},
        {"track events carry the fused reading",
         [] {
             lpr::Track track;
             track.id = 7;
             track.box = lpr::Box{1, 2, 3, 4};
             track.read = lpr::decode_plate(readings::slots("Z9", 0.99F), {}, config);
             track.seen = 5;
             track.reads = 4;
             track.first_seen_ms = 33.33;
             track.last_seen_ms = 133.36;
             track.best_score = 0.5F;
             track.reported = true;
             const std::string json = lpr::event_json(lpr::TrackEvent{lpr::TrackEventKind::reported, track}, config);
             const std::string start = R"({"event":"reported","track":{"id":7,"text":"Z9","confidence":0.9044,)"
                                       R"("box":[1.0,2.0,3.0,4.0],"score":0.5000,"seen":5,"reads":4,)";
             expect_equal(json.starts_with(start), true, "event: " + json);
             expect_equal(json.find(R"("first_seen_ms":33.3,"last_seen_ms":133.4,"reported":true,"visible":false)") !=
                              std::string::npos,
                          true,
                          "times and flags");
         }},
    });
}
