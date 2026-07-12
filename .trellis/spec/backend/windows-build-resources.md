# Windows Build Resources

<spec-entry category="infra" keywords="windows,msvc,manifest,libtest,tauri,resource" date="2026-07-12" source="src-tauri/build.rs:12">

## Scenario: Common Controls v6 Must Reach Both the App and Rust Libtest

### 1. Scope / Trigger

- Trigger: changing `src-tauri/build.rs`, Windows icons/version metadata,
  application manifests, build dependencies, or any test that imports a Win32
  API requiring Common Controls v6 (for example `TaskDialogIndirect`).
- Applies only to `CARGO_CFG_TARGET_OS=windows` and
  `CARGO_CFG_TARGET_ENV=msvc`; other targets retain Tauri's default path.

### 2. Signatures

- Build dependency: `embed-resource = "=3.0.9"`.
- Tauri attributes on Windows MSVC:
  `WindowsAttributes::new_without_app_manifest()`.
- Manifest resource files:
  `windows/common-controls-v6.manifest` and
  `windows/common-controls-v6.rc`.
- Resource compilation:
  `embed_resource::compile_for_everything(path, embed_resource::NONE)`.

### 3. Contracts

- Tauri's generated resource continues to own the application icon, version,
  product name, and file description.
- Only Tauri's manifest copy is disabled on Windows MSVC. A separate
  manifest-only resource is linked generically so normal bins, cdylibs, lib
  unit-test harnesses, and bin-test harnesses all receive Common Controls v6.
- The RC resource type is numeric `24` (`RT_MANIFEST`):
  `1 24 "windows/common-controls-v6.manifest"`. Writing the bare token
  `RT_MANIFEST` without including `windows.h` produces a string resource type
  that the Windows loader does not treat as an application manifest.
- Build-resource validation uses plain `cargo test`, `cargo test --no-run`,
  and `cargo build`; no wrapper or `mt.exe` post-link mutation is part of
  those checks.
- A launchable desktop production artifact is a separate contract: build it
  with the repository-pinned Tauri CLI (`npm run tauri:build:windows` or the
  equivalent `tauri build`). The CLI enables `tauri/custom-protocol` and
  embeds `build.frontendDist`. A plain `cargo build --release` does neither
  and may therefore load `build.devUrl` (`http://localhost:5173`) at startup.
- Non-Windows-MSVC targets use `tauri_build::Attributes::default()` and never
  call `embed-resource` for the manifest.

### 4. Validation & Error Matrix

- Libtest exits with `0xc0000139` before listing tests -> Common Controls v6 is
  missing from the lib unit-test EXE.
- Linker reports `CVT1100` / `LNK1123` duplicate resource -> a generic resource
  duplicated Tauri's VERSION or MANIFEST record; split icon/version from the
  manifest-only resource.
- `cargo:rustc-link-arg-tests` is rejected because the package has no explicit
  test target -> it does not cover the implicit lib unit-test harness.
- EXE contains a manifest resource but still fails at startup -> extract
  resource id `#1` read-only and confirm the type is numeric 24 and the XML
  contains Common Controls version `6.0.0.0`.
- Release app loses icon/version/product metadata -> reject the build-resource
  change even if tests start.
- Packaged-app smoke test shows `localhost refused to connect` -> the EXE was
  built or overwritten by plain Cargo without `tauri/custom-protocol`; rerun
  the Tauri production build instead of changing `build.devUrl`.

### 5. Good / Base / Bad Cases

- Good: a fresh target builds lib/bin test EXEs, both support `--list`, all
  Rust tests run, the Cargo release retains manifest/icon/version metadata,
  and a separate Tauri production EXE launches with no dev server running.
- Base: macOS, Linux, and Windows GNU follow their existing Tauri behavior.
- Bad: globally link Tauri's full `resource.lib`, which duplicates VERSION in
  app/bin tests.
- Bad: mutate each generated test EXE with `mt.exe` after Cargo links it.

### 6. Tests Required

- Fresh independent `CARGO_TARGET_DIR`: `cargo test --no-run`, lib/bin
  `--list`, then full `cargo test`.
- `cargo check` with default features and `--no-default-features`.
- `cargo build --release` and `cargo test --release --no-run` for Rust/resource
  validation only; do not use that EXE as packaged-app launch evidence.
- Read-only resource inspection of debug/release app and test EXEs: Common
  Controls v6, file/product version, product name/description, and icon.
- `npm run tauri:build:windows`, followed by a launch with port 5173 unused;
  verify that the main UI renders, the Tauri build recorded `dev=false`, and
  `tauri-codegen-assets` contains the current frontend files.
- `cargo fmt --check`, project Clippy, and `git diff --check`.

### 7. Wrong vs Correct

Wrong:

```rc
1 RT_MANIFEST "windows/common-controls-v6.manifest"
```

Correct:

```rc
1 24 "windows/common-controls-v6.manifest"
```

Wrong:

```rust
println!("cargo:rustc-link-arg={tauri_full_resource}");
```

Correct:

```rust
let windows = tauri_build::WindowsAttributes::new_without_app_manifest();
embed_resource::compile_for_everything(
    "windows/common-controls-v6.rc",
    embed_resource::NONE,
)
.manifest_required()?;
```

Wrong production smoke-test artifact:

```powershell
cargo build --manifest-path src-tauri/Cargo.toml --release
src-tauri\target\release\threadterm.exe
```

Correct Windows production artifact:

```powershell
npm run tauri:build:windows
src-tauri\target\release\threadterm.exe
```

</spec-entry>
