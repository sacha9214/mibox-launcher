#!/bin/bash
# Builds and signs TvHome.apk without Gradle.
set -euo pipefail
cd "$(dirname "$0")"
export JAVA_HOME=/opt/homebrew/opt/openjdk@17
export PATH="$JAVA_HOME/bin:$PATH"
SDK=/opt/homebrew/share/android-commandlinetools
BT=$SDK/build-tools/34.0.0
JAR=$SDK/platforms/android-28/android.jar

rm -rf build && mkdir -p build/classes build/dex
ASSETS=(); [ -d assets ] && ASSETS=(-A assets)
"$BT/aapt2" link -o build/base.apk --manifest AndroidManifest.xml -I "$JAR" "${ASSETS[@]+"${ASSETS[@]}"}"
javac -source 8 -target 8 -nowarn -classpath "$JAR" -d build/classes $(find src -name '*.java')
"$BT/d8" --min-api 21 --lib "$JAR" --output build/dex $(find build/classes -name '*.class')
cp build/base.apk build/unsigned.apk
(cd build/dex && zip -q ../unsigned.apk classes.dex)
"$BT/zipalign" -f 4 build/unsigned.apk build/aligned.apk

[ -f debug.keystore ] || keytool -genkeypair -keystore debug.keystore -storepass android -keypass android \
  -alias tvhome -keyalg RSA -validity 10000 -dname "CN=TvHome" >/dev/null 2>&1
"$BT/apksigner" sign --ks debug.keystore --ks-pass pass:android --out TvHome.apk build/aligned.apk
echo "OK: $(pwd)/TvHome.apk"
