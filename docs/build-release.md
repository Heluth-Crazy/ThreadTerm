# Build & Release Guide

This guide covers building and releasing OpenWork as desktop applications.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Building for macOS](#building-for-macos)
- [Building for Windows](#building-for-windows)
- [Building for Linux](#building-for-linux)
- [Build Configuration](#build-configuration)
- [Release Process](#release-process)
- [Signing & Notarization](#signing--notarization)
- [Distribution](#distribution)

---

## Prerequisites

### Common Requirements

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js | v22+ | LTS recommended |
| npm | v10+ | Comes with Node.js |

### macOS Requirements

- macOS 10.15+ (Catalina or later)
- Xcode Command Line Tools
- Apple Developer Account (for signing/notarization)

```bash
# Install Xcode Command Line Tools
xcode-select --install
```

### Windows Requirements

- Windows 10/11 (64-bit)
- Visual Studio Build Tools 2022

```powershell
# Install Build Tools
winget install Microsoft.VisualStudio.2022.BuildTools
```

Select "Desktop development with C++" workload.

### Linux Requirements

- Ubuntu 20.04+ or equivalent
- Build tools: `build-essential`, `libgtk-3-dev`

```bash
# Ubuntu/Debian
sudo apt-get install build-essential libgtk-3-dev
```

---

## Building for macOS

### Step 1: Install Dependencies

```bash
npm install
```

### Step 2: Build the Application

```bash
# Build for macOS (creates .app and .dmg)
npm run build:mac
```

This will create:
- `release/mac/ClaudeCodeDesktop-{version}.dmg` - Installer
- `release/mac/ClaudeCodeDesktop-{version}.zip` - Portable

### Step 3: Output Location

Built applications are located in:

```
release/mac/
├── ClaudeCodeDesktop-{version}.dmg
└── ClaudeCodeDesktop-{version}-mac.zip
```

---

## Building for Windows

### Step 1: Install Dependencies

```bash
npm install
```

### Step 2: Build the Application

```bash
# Build for Windows (creates .exe installer)
npm run build:win
```

This will create:
- `release/win/ClaudeCodeDesktop-{version}-Setup.exe` - NSIS Installer

### Step 3: Output Location

Built applications are located in:

```
release/win/
└── ClaudeCodeDesktop-{version}-Setup.exe
```

---

## Building for Linux

### Step 1: Install Dependencies

```bash
npm install
```

### Step 2: Build the Application

```bash
# Build for Linux (AppImage and deb)
npm run build:linux
```

### Step 3: Output Location

```
release/linux/
├── ClaudeCodeDesktop-{version}.AppImage
└── ClaudeCodeDesktop-{version}.deb
```

---

## Building for All Platforms

To build for all supported platforms at once:

```bash
npm run build:all
```

---

## Build Configuration

### electron-builder.yml

The build is configured in `electron-builder.yml`:

```yaml
appId: com.openwork.openwork
productName: ClaudeCodeDesktop
copyright: Copyright © 2024 Siteboon

directories:
  output: release
  buildResources: resources

mac:
  category: public.app-category.developer-tools
  target:
    - dmg
    - zip
  icon: resources/icon.icns

win:
  target:
    - nsis
  icon: resources/icon.ico
  artifactName: ${productName}-${version}-Setup.${ext}

linux:
  target:
    - AppImage
    - deb
  icon: resources/icons
  category: Development

nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true

files:
  - dist/**/*
  - server/**/*
  - shared/**/*
  - package.json
```

### Customizing the Build

You can customize the build with command-line options:

```bash
# Custom output directory
electron-builder --dir

# Specific platform
electron-builder --mac
electron-builder --win
electron-builder --linux

# Skip specific targets
electron-builder --win --x64
```

---

## Release Process

### Automated Releases (Recommended)

The project uses `release-it` for automated releases:

```bash
# Interactive release
npm run release

# Non-interactive
npm run release -- patch  # 1.0.0 -> 1.0.1
npm run release -- minor # 1.0.0 -> 1.1.0
npm run release -- major # 1.0.0 -> 2.0.0
```

The release process:
1. Updates version in `package.json`
2. Runs the build
3. Creates git tag
4. Generates changelog
5. Creates source hosting release
6. Publishes to npm (if configured)

### Manual Release

For manual control:

```bash
# 1. Update version
npm version patch  # or minor, major

# 2. Build for all platforms
npm run build:all

# 3. Create git tag
git tag v1.0.0
git push origin v1.0.0

# 4. Create source hosting release
# (Manually via source hosting UI or using gh CLI)
```

---

## Signing & Notarization

### macOS Code Signing

1. Obtain an Apple Developer Certificate
2. Configure signing in `electron-builder.yml`:

```yaml
mac:
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.plist
  hardenedRuntime: true
  gatekeeperAssess: false
```

3. Set environment variables:

```bash
export APPLE_ID=your-email@example.com
export APPLE_APP_SPECIFIC_PASSWORD=your-password
export APPLE_TEAM_ID=your-team-id
```

### Windows Code Signing

1. Obtain a code signing certificate
2. Configure in `electron-builder.yml`:

```yaml
win:
  certificateFile: path/to/certificate.pfx
  certificatePassword: your-password
```

Or use environment variables:

```bash
export CSC_LINK=path/to/certificate.pfx
export CSC_KEY_PASSWORD=your-password
```

### App Notarization (macOS)

After signing, notarize the app:

```bash
# Submit for notarization
xcrun notarytool submit release/mac/ClaudeCodeDesktop-{version}.dmg

# Wait for approval (can take several minutes)
```

---

## Distribution

### npm Registry

Publish to npm (requires npm account and maintainer access):

```bash
# Login to npm
npm login

# Publish
npm publish --access public
```

### source hosting Releases

1. Push tags to source hosting
2. Create releases via source hosting UI or API
3. Upload built artifacts

### Direct Download

Host the built files on your own server:

```
https://your-server.com/releases/
├── ClaudeCodeDesktop-{version}-mac.zip
├── ClaudeCodeDesktop-{version}-Setup.exe
└── ClaudeCodeDesktop-{version}.AppImage
```

---

## Version Management

### Version Format

The project follows [Semantic Versioning](https://semver.org/):

```
MAJOR.MINOR.PATCH
1.0.0 -> 1.0.1 (patch - bug fixes)
1.0.0 -> 1.1.0 (minor - new features)
1.0.0 -> 2.0.0 (major - breaking changes)
```

### Auto Versioning

The build process automatically:

- Embeds version in `package.json` into the app
- Creates platform-specific version identifiers

---

## Troubleshooting Build Issues

### Common Issues

**"Electron failed to install correctly"**

```bash
# Clear npm cache and reinstall
rm -rf node_modules
npm cache clean --force
npm install
```

**Native module errors**

```bash
# Rebuild native modules
npm run rebuild

# Or rebuild specific module
npx electron-rebuild -m ./node_modules/better-sqlite3
```

**Missing icons**

Ensure icons are in the `resources/` directory:
- macOS: `icon.icns`
- Windows: `icon.ico`
- Linux: `icons/` folder

**Code signing failures**

- Verify certificate validity
- Check certificate permissions
- Ensure correct team ID

---

## Next Steps

- [Installation Guide](installation.md) - Initial setup
- [Development Guide](development.md) - Local development
- [Troubleshooting Guide](troubleshooting.md) - Common issues
