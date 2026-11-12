# ONNX Runtime, the pinned release for this platform, downloaded and checked by hash, as onnxruntime::onnxruntime.
# Set LPR_ONNXRUNTIME_DIR to build against another copy, laid out as the releases are (include/ and lib/).

set(LPR_ONNXRUNTIME_VERSION 1.31.1)

if(LPR_ONNXRUNTIME_DIR)
    set(LPR_ONNXRUNTIME_ROOT ${LPR_ONNXRUNTIME_DIR})
else()
    string(TOLOWER "${CMAKE_SYSTEM_PROCESSOR}" lpr_processor)
    if(APPLE AND lpr_processor MATCHES "arm64|aarch64")
        set(lpr_ort_package onnxruntime-osx-arm64-${LPR_ONNXRUNTIME_VERSION}.tgz)
        set(lpr_ort_hash 2e1344a1926ee50eb25b38153cb6992c3567515aef0e677a1a520a1798896d6f)
    elseif(CMAKE_SYSTEM_NAME STREQUAL "Linux" AND lpr_processor MATCHES "x86_64|amd64")
        set(lpr_ort_package onnxruntime-linux-x64-${LPR_ONNXRUNTIME_VERSION}.tgz)
        set(lpr_ort_hash c849e36a1ef3e22d4ff217b9d1ce4a3cf5b9467b975610913ae959ad5b16bdc9)
    elseif(CMAKE_SYSTEM_NAME STREQUAL "Linux" AND lpr_processor MATCHES "aarch64|arm64")
        set(lpr_ort_package onnxruntime-linux-aarch64-${LPR_ONNXRUNTIME_VERSION}.tgz)
        set(lpr_ort_hash 5317505e2da99be65f8e2775ba3c2afd6d2961fd78aba1bd8f56159f48820c78)
    elseif(WIN32 AND lpr_processor MATCHES "amd64|x86_64")
        set(lpr_ort_package onnxruntime-win-x64-${LPR_ONNXRUNTIME_VERSION}.zip)
        set(lpr_ort_hash 5869e26bb25314375f2d5ef1877e3ea06b1543d6c710e6e4a1ec2f7177ab4b2c)
    elseif(WIN32 AND lpr_processor MATCHES "arm64")
        set(lpr_ort_package onnxruntime-win-arm64-${LPR_ONNXRUNTIME_VERSION}.zip)
        set(lpr_ort_hash 817f4129073f84f81cde3ff92b1a4e06d007691e7208deed08a8b6d6df143f7f)
    else()
        message(FATAL_ERROR "ONNX Runtime ${LPR_ONNXRUNTIME_VERSION} has no release for ${CMAKE_SYSTEM_NAME} "
                            "${CMAKE_SYSTEM_PROCESSOR}; set LPR_ONNXRUNTIME_DIR to a build of your own")
    endif()
    FetchContent_Declare(onnxruntime
        URL https://github.com/microsoft/onnxruntime/releases/download/v${LPR_ONNXRUNTIME_VERSION}/${lpr_ort_package}
        URL_HASH SHA256=${lpr_ort_hash}
        DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
    FetchContent_MakeAvailable(onnxruntime)
    set(LPR_ONNXRUNTIME_ROOT ${onnxruntime_SOURCE_DIR})
endif()

add_library(onnxruntime::onnxruntime SHARED IMPORTED GLOBAL)
if(WIN32)
    set_target_properties(onnxruntime::onnxruntime PROPERTIES
        IMPORTED_LOCATION ${LPR_ONNXRUNTIME_ROOT}/lib/onnxruntime.dll
        IMPORTED_IMPLIB ${LPR_ONNXRUNTIME_ROOT}/lib/onnxruntime.lib)
elseif(APPLE)
    set_target_properties(onnxruntime::onnxruntime PROPERTIES
        IMPORTED_LOCATION ${LPR_ONNXRUNTIME_ROOT}/lib/libonnxruntime.dylib)
else()
    set_target_properties(onnxruntime::onnxruntime PROPERTIES
        IMPORTED_LOCATION ${LPR_ONNXRUNTIME_ROOT}/lib/libonnxruntime.so)
endif()
set_target_properties(onnxruntime::onnxruntime PROPERTIES
    INTERFACE_INCLUDE_DIRECTORIES ${LPR_ONNXRUNTIME_ROOT}/include)

# Windows looks for DLLs beside the executable first, and has an older onnxruntime.dll of its own in System32, so
# executables get a copy of ours.
function(lpr_copy_runtime target)
    if(WIN32)
        add_custom_command(TARGET ${target} POST_BUILD
            COMMAND ${CMAKE_COMMAND} -E copy_if_different
                    $<TARGET_FILE:onnxruntime::onnxruntime> $<TARGET_FILE_DIR:${target}>
            VERBATIM)
    endif()
endfunction()
