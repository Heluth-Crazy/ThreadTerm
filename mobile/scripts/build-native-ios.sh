#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build-native-ios.sh requires macOS with Xcode and the Rust Apple targets." >&2
  exit 2
fi

for command in cargo rustup xcodebuild xcrun lipo node grep find; do
  command -v "$command" >/dev/null || { echo "Missing required command: $command" >&2; exit 2; }
done

# Check the active toolchain before the long Rust builds or scratch cleanup.
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (!((major === 22 && minor >= 13) || (major === 24 && minor >= 3) || major >= 26)) { console.error("Expo 58 requires Node 22.13+ (22.x), 24.3+ (24.x), or 26+. Found " + process.version); process.exit(2); }'
xcode_version="$(xcodebuild -version)" || {
  echo "Select the full Xcode installation, then open Xcode and complete its license/first-launch setup." >&2
  exit 2
}
node -e 'const match = process.argv[1].match(/^Xcode (\d+)\.(\d+)/m); if (!match || Number(match[1]) < 16 || (Number(match[1]) === 16 && Number(match[2]) < 1)) { console.error("React Native 0.88 requires Xcode 16.1 or newer. Found: " + process.argv[1]); process.exit(2); }' "$xcode_version"
for sdk in iphoneos iphonesimulator; do
  xcrun --sdk "$sdk" --show-sdk-path >/dev/null || {
    echo "The active Xcode installation is missing the $sdk SDK. Complete Xcode setup before building." >&2
    exit 2
  }
done

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mobile_dir="$(cd "$script_dir/.." && pwd)"
crate_dir="$mobile_dir/native-client"
module_ios="$mobile_dir/modules/threadterm-mobile/ios"
target_dir="$crate_dir/target"
scratch="$crate_dir/build/ios"
generated="$scratch/generated"
headers="$scratch/headers"
frameworks="$module_ios/Frameworks"
swift_output="$module_ios/Generated"
library="libthreadterm_mobile_native.a"

case "$crate_dir" in
  "$mobile_dir"/native-client) ;;
  *) echo "Refusing to build outside the mobile native-client directory" >&2; exit 2 ;;
esac

# These files need no generated bindings, so catch Swift API errors immediately.
xcrun swiftc -typecheck -swift-version 5 \
  "$module_ios/KeychainStore.swift" "$module_ios/MachineRegistry.swift"

export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-1}"
export CARGO_PROFILE_DEV_DEBUG="${CARGO_PROFILE_DEV_DEBUG:-line-tables-only}"
export CARGO_TARGET_DIR="$target_dir"
export IPHONEOS_DEPLOYMENT_TARGET="17.0"

rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
rm -rf "$scratch" "$frameworks" "$swift_output"
mkdir -p "$generated" "$headers" "$frameworks" "$swift_output"

cd "$crate_dir"

# A host dylib carries the platform-neutral UniFFI metadata used by bindgen.
# Build it and the pinned bindgen binary in one Cargo invocation.
cargo build --locked --release --lib --bin uniffi-bindgen
host_library="$target_dir/release/libthreadterm_mobile_native.dylib"
bindgen="$target_dir/release/uniffi-bindgen"
[[ -f "$host_library" ]] || { echo "Missing host UniFFI library: $host_library" >&2; exit 1; }
[[ -x "$bindgen" ]] || { echo "Missing UniFFI bindgen binary: $bindgen" >&2; exit 1; }
# UniFFI 0.32.2 auto-detects a library source. Its --library switch is a
# deprecated boolean flag, not the library-path option.
"$bindgen" generate --crate threadterm_mobile_native --language swift --out-dir "$generated" "$host_library"

swift_source="$generated/ThreadTermNative.swift"
ffi_header="$generated/ThreadTermNativeFFI.h"
module_map="$generated/ThreadTermNativeFFI.modulemap"
[[ -f "$swift_source" && -f "$ffi_header" && -f "$module_map" ]] || {
  echo "UniFFI did not generate the filenames declared by uniffi.toml" >&2
  exit 1
}
node "$script_dir/verify-generated-swift.mjs" "$generated"
cp "$swift_source" "$swift_output/ThreadTermNative.swift"
cp "$ffi_header" "$headers/ThreadTermNativeFFI.h"
cp "$module_map" "$headers/module.modulemap"

for target in aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios; do
  cargo build --locked --release --lib --target "$target"
  [[ -f "$target_dir/$target/release/$library" ]] || {
    echo "Missing Rust static library for $target" >&2
    exit 1
  }
done

simulator="$scratch/$library"
lipo -create \
  "$target_dir/aarch64-apple-ios-sim/release/$library" \
  "$target_dir/x86_64-apple-ios/release/$library" \
  -output "$simulator"

xcodebuild -create-xcframework \
  -library "$target_dir/aarch64-apple-ios/release/$library" -headers "$headers" \
  -library "$simulator" -headers "$headers" \
  -output "$frameworks/ThreadTermNativeFFI.xcframework"

packaged_module_maps=0
while IFS= read -r packaged_module_map; do
  packaged_headers="$(dirname "$packaged_module_map")"
  [[ -f "$packaged_headers/ThreadTermNativeFFI.h" ]] || {
    echo "XCFramework slice omitted ThreadTermNativeFFI.h: $packaged_headers" >&2
    exit 1
  }
  grep -Fq 'module ThreadTermNativeFFI {' "$packaged_module_map" || {
    echo "XCFramework module map has the wrong module name: $packaged_module_map" >&2
    exit 1
  }
  grep -Fq 'header "ThreadTermNativeFFI.h"' "$packaged_module_map" || {
    echo "XCFramework module map targets the wrong header: $packaged_module_map" >&2
    exit 1
  }
  packaged_module_maps=$((packaged_module_maps + 1))
done < <(find "$frameworks/ThreadTermNativeFFI.xcframework" -type f -name module.modulemap -print)
[[ "$packaged_module_maps" -eq 2 ]] || {
  echo "Expected module maps in both XCFramework slices, found $packaged_module_maps" >&2
  exit 1
}

echo "Built $frameworks/ThreadTermNativeFFI.xcframework"
echo "Generated $swift_output/ThreadTermNative.swift"
echo "Next: from mobile/, run npx expo prebuild --platform ios (or pod install in an existing ios directory)."
