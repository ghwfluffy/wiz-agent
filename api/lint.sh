#!/bin/bash

set -eu -o pipefail

cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
  npm install
fi

npm run lint
