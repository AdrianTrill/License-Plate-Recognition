cmake_minimum_required(VERSION 3.10)
project(LicensePlateRecognition)

set(CMAKE_CXX_STANDARD 17)

# Find OpenCV
find_package(OpenCV REQUIRED)

# Find Tesseract (ensure Tesseract is installed and its pkg-config file is available)
find_package(Tesseract REQUIRED)

# Add the executable and source files
add_executable(LicensePlateRecognition
        src/main.cpp
        src/Detector.cpp
        src/Detector.h
        src/OCR.cpp
        src/OCR.h
)

# Include directories
target_include_directories(LicensePlateRecognition PRIVATE ${OpenCV_INCLUDE_DIRS} ${Tesseract_INCLUDE_DIRS})

# Link libraries
target_link_libraries(LicensePlateRecognition PRIVATE ${OpenCV_LIBS} ${Tesseract_LIBRARIES})
