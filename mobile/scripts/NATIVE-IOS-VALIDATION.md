# Native iOS build and acceptance

## Windows binding generation before the Mac window

After the serialized Cargo slot is available, generate and check the real
UniFFI Swift surface on Windows. From the repository root in PowerShell:

```powershell
Push-Location mobile/native-client
$env:CARGO_BUILD_JOBS = '1'
$env:CARGO_PROFILE_DEV_DEBUG = 'line-tables-only'
cargo build --locked --lib --bin uniffi-bindgen
$output = 'build/windows-uniffi'
& .\target\debug\uniffi-bindgen.exe generate --crate threadterm_mobile_native --language swift --out-dir $output .\target\debug\threadterm_mobile_native.dll
node ..\scripts\verify-generated-swift.mjs $output
Pop-Location
```

UniFFI 0.32.2 auto-detects the DLL from the positional source path. Its
`--library` option is a deprecated boolean compatibility flag, not an option
that consumes the DLL path, so the command intentionally omits it. The output
directory is ignored by Git. A passing comparison validates the generated
Swift names/types and the C header/module-map contract, but is not an Apple
compile.

## Concentrated Mac/iPhone window

The Windows implementation window cannot claim an Apple compile. In the
concentrated Mac/iPhone window:

1. Prepare full Xcode 16.1 or newer, accept its license/first-launch setup,
   and select its developer directory. Before installing dependencies, verify
   `xcodebuild -version`, both `xcrun --sdk iphoneos --show-sdk-path` and
   `xcrun --sdk iphonesimulator --show-sdk-path`, and `pod --version`.
   Use Node 22.x >=22.13, Node 24.x >=24.3, or Node 26+ for the pinned Expo and
   React Native versions. The native script installs the Rust Apple targets.
   It also typechecks the Foundation/Security-only registry and Keychain files
   before starting Cargo, so a Swift API mismatch fails early.
2. Run `bash scripts/build-native-ios.sh` from `mobile/`. It generates the UniFFI
   Swift binding and a device + universal-simulator XCFramework inside the
   local Expo module. These outputs are intentionally ignored by Git. The
   script fixes `IPHONEOS_DEPLOYMENT_TARGET` at the valid dotted value `17.0`,
   runs the generated-signature verifier, and fails unless both XCFramework
   slices contain `ThreadTermNativeFFI.h` plus a `module.modulemap` that targets
   that exact header.
3. Inspect `modules/threadterm-mobile/ios/Generated/ThreadTermNative.swift`
   before compiling. The real Windows-generated Swift/header/module-map and
   `NativeClient` signatures passed the verifier and source review. Confirm the
   Mac-generated constructor/method labels, record fields, thrown errors, and
   `ClientEventListener` protocol still match `ThreadTermMobileModule.swift`;
   only the Apple build establishes compiler and linker compatibility.
4. From `mobile/`, run `npx expo prebuild --platform ios` (or
   `(cd ios && pod install)` if the generated iOS project already exists), then
   compile the development build in Xcode.
5. Test both a direct TLS descriptor and an iroh descriptor. Confirm that a
   wrong DER fingerprint sends no pairing/auth request, confirmation consumes
   the retained checked connection, and two hosts retain distinct identities.
6. Background the app while control is unlocked. Confirm the lock event is
   immediate, all connections close, no uncertain request is replayed, and the
   foreground coordinator resynchronizes before enabling writes. Confirm the
   current module's copied attachment cache is also removed.
7. Revoke and expire a device on the host. Confirm the native state becomes
   `revoked`, credentials never appear in JavaScript logs/state, and pairing is
   required again.
8. Open the same public and host-loopback preview on two machines. Confirm
   cookies/storage are isolated, public resources use the phone network,
   loopback reaches only the owning host preview port, and tunnel failure never
   falls back to iPhone localhost.
9. Pick a private file and a zero-byte file, upload them through 1 MiB-or-smaller
   base64 reads, cancel the picker, and try forged/stale URIs plus a zero-length
   read before EOF. Only the copied picked file may read; zero length succeeds
   only at EOF. Kill/relaunch the app and confirm the prior process's private
   cache copies are removed.
10. Remove a machine and verify its Keychain credential, live connection,
   proxy, and persistent WebKit data store are removed without affecting the
   other machine.

Record the Xcode version, iPhone model/iOS version, simulator architectures,
and every command/result in the task validation artifact.
