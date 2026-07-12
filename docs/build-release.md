# Build and Release

This document describes the expected build and release process. It does not
record a completed release certification. Every platform gate below must be
run and recorded for the release candidate being shipped.

## Build model

- npm scripts resolve the repository-pinned `@tauri-apps/cli` from
  `node_modules/.bin`; a global Tauri CLI is neither required nor expected.
- `npm run tauri:dev` invokes Tauri's `beforeDevCommand`,
  `npm run dev:desktop`, which builds the mobile client before starting Vite.
- `npm run tauri:build` invokes Tauri's `beforeBuildCommand`,
  `npm run build && npm run build:mobile`.
- Do not treat `cargo build --release` as a launchable packaged application.
  It is useful for Rust and Windows-resource checks, but without the Tauri
  CLI's production protocol it can still load `build.devUrl` and show a
  `localhost:5173` connection error. Use a Tauri build for launch acceptance.
- Tauri builds native bundles for the host operating system. Create macOS
  artifacts on macOS and Windows artifacts on Windows; do not treat a
  cross-platform frontend build as a native packaging result.

## Prepare a release candidate

Start from a clean checkout on each target platform:

```bash
npm ci
npm run check
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

Then create the host-platform bundle:

```bash
npm run tauri:build
```

The build command compiles both desktop and embedded mobile web assets. A
clean checkout therefore must not depend on a pre-existing `dist` or
`mobile-app/dist` directory.

Before accepting the artifact, launch it with no Vite server running. The app
must render its embedded UI and must not attempt to connect to port 5173.

Inspect the generated artifacts under
`src-tauri/target/release/bundle/`. Record the source commit, host OS and
architecture, Node/npm/Rust versions, exact command, artifact filenames, sizes,
and checksums. Do not infer success from the presence of an older artifact.

For an NSIS-only Windows build, follow
[Windows EXE build](windows-exe-build.md).

## Internal test builds versus public releases

An unsigned macOS or Windows bundle is suitable only for controlled internal
testing. It is **not** a public release candidate. Local bypasses for
Gatekeeper, SmartScreen, or antivirus warnings must never be presented as a
release procedure.

The current repository configuration does not by itself establish a complete
public signing and trust pipeline. Keep signing identities and credentials out
of source control and CI logs.

## Release blockers

All items remain **BLOCKED** until evidence is attached to the exact artifacts
being published.

### macOS signing and notarization — BLOCK

- [ ] Build on a supported macOS host using the intended release architecture
  or universal target.
- [ ] Sign the application and all nested executable code with the correct
  Developer ID Application identity and hardened runtime settings.
- [ ] Verify the signature and entitlements with `codesign`.
- [ ] Submit the distributable artifact to Apple's notary service, wait for an
  accepted result, and retain the notarization log.
- [ ] Staple the notarization ticket where supported and validate the final
  artifact with Gatekeeper (`spctl`) on a clean macOS account or machine.

### Windows Authenticode — BLOCK

- [ ] Build the NSIS installer on a supported Windows host.
- [ ] Sign the application binaries and installer with the approved
  Authenticode certificate, SHA-256 digest, and a trusted timestamp service.
- [ ] Verify the final signatures and certificate chain using Windows tooling
  such as `signtool verify /pa /all /v`.
- [ ] Confirm that the checksum belongs to the signed artifact; signing changes
  the file bytes.

### Real-platform acceptance — BLOCK

- [ ] Install, launch, upgrade, and uninstall the signed package on a clean,
  supported macOS environment.
- [ ] Install, launch, upgrade, and uninstall the signed package on a clean,
  supported Windows environment with WebView2 available or installed by the
  bundle path.
- [ ] On both platforms, exercise terminal creation and input/output, window
  persistence, global shortcuts, selector/floating windows, notifications, and
  settings persistence.
- [ ] Run the platform-specific checklist in
  [Global overlay manual test](global-overlay-manual-test.md).
- [ ] Review third-party notices and licenses for the exact dependency lockfiles
  and assets included in the candidate.

VM and CI results are useful supporting evidence, but they do not replace a
real target-platform acceptance pass.

## Publishing metadata

`npm run release` invokes the repository-local `release-it` CLI on every
supported development platform. The optional POSIX-only `./release.sh` helper
loads `GITHUB_TOKEN` from a local `.env` before delegating to the same CLI.
`release-it` can update changelog/version
metadata, create a Git tag, publish npm metadata, and create a GitHub release
according to `.release-it.json`. It does not replace native package signing,
notarization, Authenticode verification, or platform acceptance.

Before invoking release automation:

1. Confirm that `package.json`, `src-tauri/tauri.conf.json`, and
   `src-tauri/Cargo.toml` carry the intended version.
2. Confirm that the working tree is clean and the release branch policy is
   satisfied.
3. Complete the blockers above and prepare the signed artifacts and checksums.
4. Run release automation first in dry-run mode appropriate to `release-it` and
   review every proposed change before publishing.
