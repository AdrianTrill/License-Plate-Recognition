# With LPR_DOWNLOAD_MODELS, the prepared models come from the project's site, where the browser demo loads them, checked
# against the SHA-256 hashes in models/manifest.json. Otherwise tools/prepare_models.py builds them from the pinned
# upstream releases.

set(LPR_MODELS_URL "https://adriantrill.github.io/License-Plate-Recognition/models"
    CACHE STRING "Where LPR_DOWNLOAD_MODELS downloads the prepared models from")

if(LPR_DOWNLOAD_MODELS)
    file(READ ${PROJECT_SOURCE_DIR}/models/manifest.json lpr_manifest)
    foreach(network detector recognizer)
        string(JSON lpr_file GET "${lpr_manifest}" ${network} file)
        string(JSON lpr_hash GET "${lpr_manifest}" ${network} sha256)
        set(lpr_path ${PROJECT_SOURCE_DIR}/models/${lpr_file})
        if(EXISTS ${lpr_path})
            file(SHA256 ${lpr_path} lpr_existing)
            if(lpr_existing STREQUAL lpr_hash)
                continue()
            endif()
        endif()
        message(STATUS "Downloading models/${lpr_file}")
        file(DOWNLOAD ${LPR_MODELS_URL}/${lpr_file} ${lpr_path} EXPECTED_HASH SHA256=${lpr_hash} TLS_VERIFY ON)
    endforeach()
endif()
