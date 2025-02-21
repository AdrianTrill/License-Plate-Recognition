#include <opencv2/opencv.hpp>
#include <iostream>
#include "Detector.h"
#include "OCR.h"

int main(int argc, char** argv) {
    // Set paths to your YOLO model configuration and weights files.
    std::string yoloConfig = "../models/yolov3_license_plate.cfg";
    std::string yoloWeights = "../models/yolov3_license_plate.weights";

    // Set path to Tesseract tessdata folder.
    std::string tessData = "../models/tessdata"; // Ensure this folder contains files like eng.traineddata

    std::string imagePath = "../data/example.jpg";
    if (argc > 1) {
        imagePath = argv[1];
    }

    // Initialize Detector and OCR.
    Detector detector(yoloConfig, yoloWeights);
    OCR ocr(tessData);

    // Load the input image.
    cv::Mat frame = cv::imread(imagePath);
    if (frame.empty()) {
        std::cerr << "Error: Could not open image: " << imagePath << std::endl;
        return -1;
    }

    // Detect license plates.
    auto plates = detector.detectPlates(frame);

    // For each detected plate, perform OCR.
    for (auto& plate : plates) {
        // Ensure the bounding box is within the image.
        cv::Rect bbox = plate.bbox & cv::Rect(0, 0, frame.cols, frame.rows);
        cv::Mat plateROI = frame(bbox).clone();

        std::string plateText = ocr.recognize(plateROI);
        std::cout << "Detected Plate: " << plateText
                  << " (Confidence: " << plate.confidence << ")\n";

        // Draw bounding box and overlay recognized text.
        cv::rectangle(frame, bbox, cv::Scalar(0, 255, 0), 2);
        cv::putText(frame, plateText, bbox.tl(), cv::FONT_HERSHEY_SIMPLEX, 1.0, cv::Scalar(0, 0, 255), 2);
    }

    // Display the result.
    cv::imshow("License Plate Recognition", frame);
    cv::waitKey(0);

    return 0;
}
