#!/usr/bin/env bash
# Fetches the OpenALPR end-to-end benchmark, at a pinned commit, into .cache/ (or the given directory) and prints where
# its folders are. Its images are AGPL-3.0, so they are downloaded for the evaluation and never committed here.
#
#   tools/fetch_benchmark.sh
#   ./build/lpr evaluate --threads 1 .cache/openalpr-benchmarks/endtoend/{br,eu,us} --report docs/evaluation.json
set -euo pipefail

commit=9790ed20d475be1e940a7e2a3f492a97c2ebed9b
directory=${1:-.cache/openalpr-benchmarks}

if [ ! -d "$directory/.git" ]; then
    git clone --quiet --filter=blob:none --no-checkout https://github.com/openalpr/benchmarks.git "$directory"
fi
git -C "$directory" sparse-checkout set endtoend/br endtoend/eu endtoend/us
git -C "$directory" -c advice.detachedHead=false checkout --quiet "$commit"
echo "$directory/endtoend"
