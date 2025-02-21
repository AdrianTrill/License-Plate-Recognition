#ifndef DETECTOR_H
#define DETECTOR_H

#include <opencv2/opencv.hpp>
#include <string>
#include <vector>

// Structure to store detection results
struct PlateRegion {
    cv::Rect bbox;       // bounding box of the detected plate
    float confidence;    // confidence score
};

class Detector {
public:
    // Constructor: load YOLO model using configuration and weights files.
    Detector(const std::string& configPath, const std::string& weightsPath);

    // Detect license plates in an image and return the regions.
    std::vector<PlateRegion> detectPlates(const cv::Mat& frame);

private:
    cv::dnn::Net net_;
    float confThreshold_;
    float nmsThreshold_;

    // Get the names of the output layers.
    std::vector<std::string> getOutputLayerNames();
};

#endif
