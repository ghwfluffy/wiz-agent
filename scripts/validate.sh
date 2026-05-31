#!/bin/bash

set -eu -o pipefail

cd "$(dirname "$0")/.."

./api/lint.sh
./api/test.sh
./web/test.sh
./web/build.sh
