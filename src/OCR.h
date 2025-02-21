#ifndef OCR_H
#define OCR_H

#include <opencv2/opencv.hpp>
#include <string>
#include <tesseract/baseapi.h>

class OCR {
public:
    // Constructor: initialize Tesseract with the given tessdata path and language (e.g., "eng")
    OCR(const std::string& tessDataPath, const std::string& language = "eng");
    ~OCR();

    // Recognize text from a plate region (cv::Mat)
    std::string recognize(const cv::Mat& plateROI);

private:
    tesseract::TessBaseAPI* tess_;
};

#endif
