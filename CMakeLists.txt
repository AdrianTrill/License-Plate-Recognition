cmake_minimum_required(VERSION 3.21)

project(LicensePlateRecognition
    VERSION 2.0.0
    DESCRIPTION "License plate detection and recognition in C++, natively and in the browser"
    LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

option(LPR_WARNINGS_AS_ERRORS "Treat compiler warnings as errors" OFF)
option(LPR_DOWNLOAD_MODELS "Download the prepared models from the project's site if models/ lacks them" OFF)
set(LPR_SANITIZERS "" CACHE STRING "Sanitizers for all targets, e.g. address,undefined")
set(LPR_ONNXRUNTIME_DIR "" CACHE PATH "An ONNX Runtime to build against, instead of downloading the pinned release")

include(CTest)
include(FetchContent)

# Compile settings shared by every target in the project.
add_library(lpr_options INTERFACE)
target_compile_options(lpr_options
    INTERFACE
        $<$<CXX_COMPILER_ID:MSVC>:/W4 /permissive- /utf-8>
        $<$<NOT:$<CXX_COMPILER_ID:MSVC>>:-Wall -Wextra -Wpedantic -Wshadow -Wconversion -Wno-sign-conversion>)
# MSVC calls std::getenv unsafe; the command line reads one variable, once, before any threads start.
target_compile_definitions(lpr_options INTERFACE $<$<CXX_COMPILER_ID:MSVC>:_CRT_SECURE_NO_WARNINGS>)
if(LPR_WARNINGS_AS_ERRORS)
    target_compile_options(lpr_options INTERFACE $<IF:$<CXX_COMPILER_ID:MSVC>,/WX,-Werror>)
endif()
if(LPR_SANITIZERS)
    if(MSVC)
        message(FATAL_ERROR "LPR_SANITIZERS is only supported with GCC and Clang")
    endif()
    target_compile_options(lpr_options
        INTERFACE -fsanitize=${LPR_SANITIZERS} -fno-sanitize-recover=all -fno-omit-frame-pointer -g)
    target_link_options(lpr_options INTERFACE -fsanitize=${LPR_SANITIZERS})
endif()

# The library reports bad input by throwing, so the WebAssembly build uses the browsers' native exception handling.
if(EMSCRIPTEN)
    add_compile_options(-fwasm-exceptions)
    add_link_options(-fwasm-exceptions)
endif()

# stb_image and stb_image_write, pinned by commit and checked by hash.
set(LPR_STB_COMMIT 9f755b604db3492df2cbeb39bf84b81e3e3932e3)
set(LPR_STB_DIR ${CMAKE_BINARY_DIR}/_deps/stb)
foreach(header_and_hash
        "stb_image.h|deb4f18c9ca21b751a1323019031c94c0bf5ca1d2929ef5913cc56f00aab6e91"
        "stb_image_write.h|a8e7f77f0ccfdc9bac09a71268b131931ff81aafca82c393aeb6aaba10d9e7ca")
    string(REPLACE "|" ";" header_and_hash "${header_and_hash}")
    list(GET header_and_hash 0 header)
    list(GET header_and_hash 1 hash)
    if(NOT EXISTS ${LPR_STB_DIR}/${header})
        file(DOWNLOAD https://raw.githubusercontent.com/nothings/stb/${LPR_STB_COMMIT}/${header}
             ${LPR_STB_DIR}/${header} EXPECTED_HASH SHA256=${hash} TLS_VERIFY ON)
    endif()
endforeach()

# The pipeline: images, the detector's and recognizer's pre- and post-processing, tracking, and JSON. It has no
# dependencies beyond stb, and compiles to WebAssembly unchanged.
add_library(lpr_core
    src/detector.cpp
    src/draw.cpp
    src/image.cpp
    src/image_io.cpp
    src/json.cpp
    src/pipeline.cpp
    src/recognizer.cpp
    src/stb.cpp
    src/tracker.cpp)
target_include_directories(lpr_core PUBLIC ${PROJECT_SOURCE_DIR}/include)
target_include_directories(lpr_core SYSTEM PRIVATE ${LPR_STB_DIR})
target_link_libraries(lpr_core PRIVATE lpr_options)
# A fused multiply-add rounds differently from a separate multiply and add, so contraction stays off: the native and
# WebAssembly builds then compute the same results. MSVC does not contract by default.
target_compile_options(lpr_core PRIVATE $<$<NOT:$<CXX_COMPILER_ID:MSVC>>:-ffp-contract=off>)
set_source_files_properties(src/stb.cpp PROPERTIES COMPILE_OPTIONS "$<IF:$<CXX_COMPILER_ID:MSVC>,/W0,-w>")

if(NOT EMSCRIPTEN)
    include(cmake/onnxruntime.cmake)
    include(cmake/models.cmake)

    add_library(lpr_onnx src/onnx_engine.cpp)
    target_link_libraries(lpr_onnx PUBLIC lpr_core onnxruntime::onnxruntime PRIVATE lpr_options)
    target_compile_definitions(lpr_onnx PRIVATE LPR_MODELS_DIR="${PROJECT_SOURCE_DIR}/models")

    add_executable(lpr tools/lpr_main.cpp)
    target_link_libraries(lpr PRIVATE lpr_onnx lpr_options)
    target_compile_definitions(lpr PRIVATE LPR_VERSION="${PROJECT_VERSION}")
    lpr_copy_runtime(lpr)
endif()

if(BUILD_TESTING AND NOT EMSCRIPTEN)
    foreach(suite detector image image_io json recognizer tracker)
        add_executable(lpr_${suite}_tests tests/${suite}_tests.cpp)
        target_link_libraries(lpr_${suite}_tests PRIVATE lpr_core lpr_options)
        target_include_directories(lpr_${suite}_tests PRIVATE ${PROJECT_SOURCE_DIR}/tests)
        add_test(NAME lpr_${suite}_tests COMMAND lpr_${suite}_tests)
    endforeach()
    target_compile_definitions(lpr_image_io_tests PRIVATE LPR_SAMPLES_DIR="${PROJECT_SOURCE_DIR}/samples")

    # The real models on the sample images; skipped (exit code 77) until the models are prepared.
    add_executable(lpr_pipeline_tests tests/pipeline_tests.cpp)
    target_link_libraries(lpr_pipeline_tests PRIVATE lpr_onnx lpr_options)
    target_include_directories(lpr_pipeline_tests PRIVATE ${PROJECT_SOURCE_DIR}/tests)
    target_compile_definitions(lpr_pipeline_tests PRIVATE LPR_SAMPLES_DIR="${PROJECT_SOURCE_DIR}/samples")
    lpr_copy_runtime(lpr_pipeline_tests)
    add_test(NAME lpr_pipeline_tests COMMAND lpr_pipeline_tests)
    set_tests_properties(lpr_pipeline_tests PROPERTIES SKIP_RETURN_CODE 77)

    add_test(NAME lpr_cli_help COMMAND lpr --help)
    add_test(NAME lpr_cli_rejects_a_missing_image COMMAND lpr ${PROJECT_SOURCE_DIR}/samples/missing.jpg)
    set_tests_properties(lpr_cli_rejects_a_missing_image PROPERTIES WILL_FAIL TRUE)
endif()
