# Machine Learning License Plate Recognition

## Overview
This project implements a **high-performance License Plate Recognition System** designed for real-time detection and OCR of license plates. It uses a YOLOv3-based detector for plate detection and Tesseract for OCR. Built in C++ with OpenCV and Tesseract, the system is optimized for accuracy and performance in processing images containing license plates.

## Features
- ✅ **YOLOv3-Based Detection:** Uses a deep learning model (YOLOv3) fine-tuned on license plate datasets to accurately detect license plates in images.
- ✅ **Tesseract OCR:** Integrates Tesseract to perform Optical Character Recognition on the detected plate regions, extracting the plate text.
- ✅ **Real-Time Image Processing:** Processes input images to display bounding boxes around detected license plates along with the recognized text.
- ✅ **Modular Architecture:** Built in C++17 with a clean, modular design using OpenCV’s DNN module and Tesseract, making it easy to swap or upgrade components.

## How I Built It
### 1. Project Initialization
- Designed a modular architecture in **C++17** to ensure scalability and high performance.
- Set up a **CMake build system** for easy compilation and testing.

### 2. License Plate Detection Implementation
- Integrated a YOLOv3-based detection model using OpenCV’s DNN module.
- Fine-tuned the YOLO model on license plate datasets.
- **Model Files:**  
  - Download the `.cfg` and `.weights` files from a pre-trained model repository and place them in the `models/` folder as `yolov3_license_plate.cfg` and `yolov3_license_plate.weights`.  
  - Alternatively, fine-tune the official YOLOv3 model (from [pjreddie.com](https://pjreddie.com/darknet/yolo/)) on a license plate dataset (e.g., OpenALPR Benchmark Dataset, AOLP) to generate custom weights.

### 3. OCR Implementation
- Integrated Tesseract for OCR to extract text from the detected license plate regions.
- Preprocessed images (grayscale conversion, thresholding) before passing them to Tesseract.
- **Tesseract Tessdata Files:**  
  - Download the `eng.traineddata` file from the [Tesseract OCR Tessdata GitHub](https://github.com/tesseract-ocr/tessdata) and place it in a folder named `tessdata` inside your `models/` folder (i.e., `models/tessdata/eng.traineddata`).

### 4. Performance Optimization
- Optimized the detection pipeline with efficient image preprocessing and non-maximum suppression.
- Fine-tuned detection thresholds and OCR parameters to improve accuracy.

### 5. Testing & Debugging
- Extensively tested on sample images to validate the detection and OCR results.
- Debugged edge cases to ensure robust plate recognition under various conditions.

### 6. Final Deployment & Documentation
- Packaged the project into a structured GitHub repository.
- Documented the build, run, and model integration instructions in this README.

## Technologies Used
- **C++17** for high-performance computing.
- **OpenCV** for image processing and deep learning-based detection (DNN module).
- **YOLOv3** for license plate detection.
- **Tesseract OCR** for text recognition.
- **CMake** for build automation.

## Build & Run Instructions

### Prerequisites
Ensure you have the following installed:
- **GCC/G++ (C++17 or later)**
- **CMake 3.10+**
- **OpenCV** (compiled with the DNN module)
- **Tesseract** (with development files and Leptonica)
- **Make** (for build automation)

### Compilation Steps
```bash
# Clone the repository
git clone https://github.com/yourusername/PlateRecognitionEngine.git
cd PlateRecognitionEngine

# Create a build directory and compile
mkdir build && cd build
cmake ..
make
```
This will generate the executable `PlateRecognitionEngine`.

### Running the License Plate Recognition System
After compilation, run the executable:
```bash
./PlateRecognitionEngine ../data/example.jpg
```
The system will:
1. Detect license plates in the input image using the YOLOv3 model.
2. Process the detected plate regions with Tesseract for OCR.
3. Display the image with bounding boxes and recognized text overlayed.

## Model Files

### YOLOv3 License Plate Detection Model
For a license plate–specific YOLO model, you typically need a model that’s been fine-tuned on a license plate dataset. Here are a few options:

#### Pre-Trained Model Repositories:
I used the pre-trained YOLO models for license plate detection for testing. Check out [Plate_detect_YOLO by quangnhat185](https://github.com/quangnhat185/Plate_detect_YOLO). Download the `.cfg` and `.weights` files from that repository and place them in your `models/` folder (rename them as needed to match your code, e.g., `yolov3_license_plate.cfg` and `yolov3_license_plate.weights`).

#### Training Your Own:
Alternatively, you can use a public license plate dataset (e.g., OpenALPR Benchmark Dataset, AOLP) and fine-tune the official YOLOv3 model. Get the official YOLOv3 config from [pjreddie.com](https://pjreddie.com/darknet/yolo/) or the Darknet GitHub repository and train on your dataset to generate your custom weights.

### Tesseract Tessdata Files
For OCR with Tesseract, you need the language data files. Download the `eng.traineddata` file from the [Tesseract OCR Tessdata GitHub](https://github.com/tesseract-ocr/tessdata) and place it in a folder named `tessdata` inside your `models/` folder (i.e., `models/tessdata/eng.traineddata`).

## Future Enhancements
🚀 **Integration with Real-Time Video Streaming:** Extend the system to process live video feeds.
🧠 **Advanced OCR Techniques:** Incorporate deep learning-based OCR for improved recognition accuracy.
⚡ **Hardware Acceleration:** Optimize the detection pipeline using CUDA or OpenVINO.
📈 **Enhanced Preprocessing:** Improve image preprocessing to handle various lighting conditions and plate orientations.

## Contributing
Contributions are welcome! Please submit issues or pull requests with improvements, bug fixes, or new features. Let’s build the most efficient License Plate Recognition system together!
