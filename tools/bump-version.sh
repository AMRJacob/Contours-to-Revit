#!/usr/bin/env bash
# Stamp a version on every local JS/CSS reference so browsers fetch fresh files after a deploy.
# Usage: tools/bump-version.sh 0.1.2
set -euo pipefail
v="$1"
cd "$(dirname "$0")/.."
sed -i -E "s#(href=\"css/app\.css)(\?v=[^\"]*)?\"#\1?v=$v\"#; s#(src=\"js/app\.js)(\?v=[^\"]*)?\"#\1?v=$v\"#" index.html
sed -i -E "s#(from '\./[a-z]+\.js)(\?v=[^']*)?'#\1?v=$v'#g" js/*.js
sed -i -E "s#^const VERSION = '[^']*';#const VERSION = '$v';#" js/app.js
grep -n "?v=" index.html js/*.js | head -20
