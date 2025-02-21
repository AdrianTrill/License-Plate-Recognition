#include "OCR.h"
#include <leptonica/allheaders.h>
#include <iostream>

OCR::OCR(const std::string& tessDataPath, const std::string& language) {
    tess_ = new tesseract::TessBaseAPI();
    if (tess_->Init(tessDataPath.c_str(), language.c_str())) {
        std::cerr << "Could not initialize tesseract with data path: " << tessDataPath << std::endl;
    }
}

OCR::~OCR() {
    tess_->End();
    delete tess_;
}

std::string OCR::recognize(const cv::Mat& plateROI) {
    if (plateROI.empty()) {
        return "";
    }

    cv::Mat gray;
    if (plateROI.channels() == 3) {
        cv::cvtColor(plateROI, gray, cv::COLOR_BGR2GRAY);
    } else {
        gray = plateROI;
    }
    cv::Mat thresh;
    cv::threshold(gray, thresh, 0, 255, cv::THRESH_BINARY | cv::THRESH_OTSU);

    // Convert cv::Mat to Pix* for Tesseract
    Pix* pix = pixCreate(thresh.cols, thresh.rows, 8);
    for (int y = 0; y < thresh.rows; y++) {
        for (int x = 0; x < thresh.cols; x++) {
            uint8_t pixel = thresh.at<uint8_t>(y, x);
            pixSetPixel(pix, x, y, pixel);
        }
    }

    tess_->SetImage(pix);
    tess_->Recognize(0);
    char* outText = tess_->GetUTF8Text();
    std::string result(outText ? outText : "");
    if (outText) {
        delete [] outText;
    }
    pixDestroy(&pix);
    return result;
}
