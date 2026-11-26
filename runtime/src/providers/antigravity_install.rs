//! `threadterm-v3-runtime --agent-install antigravity`: installs or updates Google's Antigravity CLI for this user,
//! run in a terminal tab so its progress is visible. The release comes from the manifest Google's own CLI updater
//! reads; the file is Google's, downloaded from Google's storage and checked against the manifest's SHA-512 before
//! it replaces anything. Nothing is executed until the check passes.
use anyhow::{bail, Context, Result};
use serde::Deserialize;
use sha2::{Digest, Sha512};
use std::io::{Read, Write};
use std::path::Path;

const MANIFEST_BASE: &str = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests";
const ASSET_PREFIX: &str = "https://storage.googleapis.com/antigravity-public/antigravity-cli/";
const MAX_DOWNLOAD: u64 = 512 * 1024 * 1024;

#[derive(Debug, Deserialize)]
struct Manifest {
    version: String,
    url: String,
    sha512: String,
}

/// The manifest name and the asset file this computer needs (`windows_amd64` → `windows-x64/cli_windows_x64.exe`).
fn target() -> Option<(&'static str, &'static str)> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => Some(("windows_amd64", "windows-x64/cli_windows_x64.exe")),
        ("windows", "aarch64") => Some(("windows_arm64", "windows-arm/cli_windows_arm64.exe")),
        _ => None,
    }
}

/// Accepts only a release on Google's storage, for this computer's file, with a version and a SHA-512.
fn check_manifest(manifest: &Manifest, asset: &str) -> Result<()> {
    let version_ok = manifest.version.split('.').count() == 3
        && manifest.version.split('.').all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()));
    if !version_ok {
        bail!("the release manifest has an unexpected version {:?}", manifest.version);
    }
    let rest = manifest.url.strip_prefix(ASSET_PREFIX).unwrap_or_default();
    let build = rest.strip_prefix(&format!("{}-", manifest.version)).and_then(|rest| rest.split_once('/'));
    let expected_file = matches!(build, Some((number, file)) if !number.is_empty() && number.chars().all(|c| c.is_ascii_digit()) && file == asset);
    if !expected_file {
        bail!("the release manifest points outside Google's Antigravity downloads: {}", manifest.url);
    }
    if manifest.sha512.len() != 128 || !manifest.sha512.chars().all(|c| c.is_ascii_hexdigit()) {
        bail!("the release manifest has no valid SHA-512");
    }
    Ok(())
}

pub fn run(args: &[String]) -> i32 {
    match args.first().map(String::as_str) {
        // The runtime's `main` is async; the blocking HTTP client must run on a plain thread.
        Some(super::antigravity::ID) => match std::thread::spawn(install).join().unwrap_or_else(|_| Err(anyhow::anyhow!("the installer stopped unexpectedly"))) {
            Ok(()) => 0,
            Err(error) => {
                eprintln!("\nInstall failed: {error:#}");
                1
            }
        },
        other => {
            eprintln!("Unknown agent {:?}. Usage: --agent-install antigravity", other.unwrap_or(""));
            2
        }
    }
}

fn install() -> Result<()> {
    let (manifest_name, asset) = target().context("ThreadTerm installs the Antigravity CLI on Windows only; use Google's installer on this computer")?;
    let dir = super::antigravity::managed_dir().context("LOCALAPPDATA is not set")?;
    println!("Installing Google Antigravity CLI for this Windows user");
    println!("  into {}", dir.display());
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(60 * 45))
        .connect_timeout(std::time::Duration::from_secs(30))
        .build()?;
    let manifest: Manifest = client
        .get(format!("{MANIFEST_BASE}/{manifest_name}.json"))
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .context("reading Google's release manifest")?
        .json()
        .context("reading Google's release manifest")?;
    check_manifest(&manifest, asset)?;
    let target = dir.join("agy.exe");
    if let Some(current) = installed_version(&target) {
        if current == manifest.version {
            println!("Already up to date: {current}");
            return Ok(());
        }
        println!("Updating {current} → {}", manifest.version);
    } else {
        println!("Version {}", manifest.version);
    }
    std::fs::create_dir_all(&dir).context("creating the install folder")?;
    let staging = dir.join("agy.exe.download");
    download(&client, &manifest, &staging)?;
    if let Err(error) = std::fs::rename(&staging, &target) {
        let _ = std::fs::remove_file(&staging);
        return Err(error).context("replacing agy.exe (close Antigravity chats and terminals, then try again)");
    }
    match installed_version(&target) {
        Some(version) => println!("\nInstalled Antigravity CLI {version}. Sign in from Settings → Agents, or run `agy` once."),
        None => bail!("the new agy.exe did not report its version"),
    }
    Ok(())
}

fn download(client: &reqwest::blocking::Client, manifest: &Manifest, staging: &Path) -> Result<()> {
    let mut response = client
        .get(&manifest.url)
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .context("downloading agy.exe")?;
    let total = response.content_length().filter(|length| *length <= MAX_DOWNLOAD);
    let mut file = std::fs::File::create(staging).context("creating the download file")?;
    let mut hasher = Sha512::new();
    let mut received = 0_u64;
    let mut shown = 0_u64;
    let mut buffer = vec![0_u8; 1 << 16];
    let result = (|| -> Result<()> {
        loop {
            let read = response.read(&mut buffer).context("downloading agy.exe")?;
            if read == 0 {
                break;
            }
            received += read as u64;
            if received > MAX_DOWNLOAD {
                bail!("the download is larger than {} MiB", MAX_DOWNLOAD >> 20);
            }
            hasher.update(&buffer[..read]);
            file.write_all(&buffer[..read]).context("writing the download")?;
            if let Some(total) = total {
                let percent = received * 100 / total.max(1);
                if percent >= shown + 10 {
                    shown = percent - percent % 10;
                    println!("  {shown:>3}%  {} / {} MiB", received >> 20, total >> 20);
                }
            }
        }
        file.flush()?;
        let digest = hex::encode(hasher.finalize());
        if !digest.eq_ignore_ascii_case(&manifest.sha512) {
            bail!("the downloaded file does not match Google's SHA-512; nothing was installed");
        }
        println!("  SHA-512 matches Google's release manifest");
        Ok(())
    })();
    drop(file);
    if result.is_err() {
        let _ = std::fs::remove_file(staging);
    }
    result
}

fn installed_version(path: &Path) -> Option<String> {
    if !path.is_file() {
        return None;
    }
    let output = std::process::Command::new(path).arg("--version").output().ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    super::antigravity::parse_version(&text).map(|[major, minor, patch]| format!("{major}.{minor}.{patch}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(version: &str, url: &str, sha512: &str) -> Manifest {
        Manifest { version: version.into(), url: url.into(), sha512: sha512.into() }
    }

    #[test]
    fn only_google_releases_for_this_file_are_accepted() {
        let sha = "a".repeat(128);
        let asset = "windows-x64/cli_windows_x64.exe";
        let good = "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.16-5250855658717184/windows-x64/cli_windows_x64.exe";
        check_manifest(&manifest("1.5.16", good, &sha), asset).unwrap();
        assert!(check_manifest(&manifest("1.5.16", &good.replace("storage.googleapis.com", "evil.example"), &sha), asset).is_err());
        assert!(check_manifest(&manifest("1.5.16", &good.replace("1.5.16-", "1.5.15-"), &sha), asset).is_err(), "the URL is for this version");
        assert!(check_manifest(&manifest("1.5.16", &good.replace("cli_windows_x64.exe", "other.exe"), &sha), asset).is_err());
        assert!(check_manifest(&manifest("1.5.16", &good.replace("5250855658717184/", "../"), &sha), asset).is_err());
        assert!(check_manifest(&manifest("1.5", good, &sha), asset).is_err());
        assert!(check_manifest(&manifest("1.5.16", good, "abc"), asset).is_err());
    }
}
