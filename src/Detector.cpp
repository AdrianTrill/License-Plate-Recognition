#include "Detector.h"
#include <iostream>

Detector::Detector(const std::string& configPath, const std::string& weightsPath)
        : confThreshold_(0.5f), nmsThreshold_(0.4f)
{
    try {
        net_ = cv::dnn::readNetFromDarknet(configPath, weightsPath);
        net_.setPreferableBackend(cv::dnn::DNN_BACKEND_OPENCV);
        net_.setPreferableTarget(cv::dnn::DNN_TARGET_CPU);
    } catch (const cv::Exception& e) {
        std::cerr << "Error loading YOLO model: " << e.what() << std::endl;
    }
}

std::vector<std::string> Detector::getOutputLayerNames() {
    std::vector<int> outLayers = net_.getUnconnectedOutLayers();
    std::vector<cv::String> layerNames = net_.getLayerNames();
    std::vector<std::string> names;
    for (int idx : outLayers) {
        names.push_back(layerNames[idx - 1]);
    }
    return names;
}

std::vector<PlateRegion> Detector::detectPlates(const cv::Mat& frame) {
    std::vector<PlateRegion> results;
    if (frame.empty() || net_.empty()) {
        std::cerr << "Detector error: empty frame or model not loaded." << std::endl;
        return results;
    }

    cv::Mat blob;
    cv::dnn::blobFromImage(frame, blob, 1/255.0, cv::Size(416, 416), cv::Scalar(), true, false);
    net_.setInput(blob);

    std::vector<cv::Mat> outs;
    net_.forward(outs, getOutputLayerNames());

    std::vector<int> indices;
    std::vector<cv::Rect> boxes;
    std::vector<float> confidences;

    // Process detections from each output layer
    for (size_t i = 0; i < outs.size(); i++) {
        float* data = reinterpret_cast<float*>(outs[i].data);
        for (int j = 0; j < outs[i].rows; j++, data += outs[i].cols) {
            float objectness = data[4];
            if (objectness < confThreshold_)
                continue;
            float confidence = objectness;  // for license plate detection assume one class
            if (confidence > confThreshold_) {
                int centerX = static_cast<int>(data[0] * frame.cols);
                int centerY = static_cast<int>(data[1] * frame.rows);
                int width = static_cast<int>(data[2] * frame.cols);
                int height = static_cast<int>(data[3] * frame.rows);
                int left = centerX - width / 2;
                int top = centerY - height / 2;
                boxes.push_back(cv::Rect(left, top, width, height));
                confidences.push_back(confidence);
            }
        }
    }

    // Apply Non-Maximum Suppression to remove overlapping boxes
    cv::dnn::NMSBoxes(boxes, confidences, confThreshold_, nmsThreshold_, indices);
    for (int idx : indices) {
        PlateRegion plate;
        plate.bbox = boxes[idx];
        plate.confidence = confidences[idx];
        results.push_back(plate);
    }

    return results;
}
