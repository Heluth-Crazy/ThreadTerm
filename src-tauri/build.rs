use std::{
    env,
    error::Error,
    path::{Path, PathBuf},
};

fn main() -> Result<(), Box<dyn Error>> {
    if env::var_os("CARGO_FEATURE_MOBILE_BRIDGE").is_some() {
        verify_mobile_bundle()?;
    }
    configure_windows_resource_compiler()?;
    let attributes = if is_windows_msvc_target()? {
        tauri_build::Attributes::default()
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest())
    } else {
        tauri_build::Attributes::default()
    };
    tauri_build::try_build(attributes)?;
    embed_windows_manifest_resource()?;
    Ok(())
}

fn verify_mobile_bundle() -> Result<(), Box<dyn Error>> {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR")?);
    let dist = manifest_dir.join("..").join("mobile-app").join("dist");
    let required_files = [
        "index.html",
        "assets/index.css",
        "assets/index.js",
        "assets/vendor-react.js",
        "assets/vendor-xterm.js",
    ];

    println!("cargo:rerun-if-changed={}", dist.display());
    for file in required_files {
        let path = dist.join(file);
        println!("cargo:rerun-if-changed={}", path.display());
        if !path.is_file() {
            return Err(format!(
                "missing mobile bundle asset at {}. Run `npm run build:mobile` before `cargo build`.",
                path.display()
            )
            .into());
        }
    }

    Ok(())
}

fn configure_windows_resource_compiler() -> Result<(), Box<dyn Error>> {
    let target = env::var("TARGET")?;
    let host = env::var("HOST")?;
    let target_os = env::var("CARGO_CFG_TARGET_OS")?;
    let target_env = env::var("CARGO_CFG_TARGET_ENV")?;
    let allow_external_manifest = env::var_os("THREADTERM_ALLOW_MISSING_WINDOWS_RC")
        .map(|value| value == "1")
        .unwrap_or(false);

    if target_os != "windows" || target_env != "msvc" || host.contains("windows") {
        return Ok(());
    }

    let rc_env_names = [
        format!("RC_{target}"),
        format!("RC_{}", target.replace('-', "_")),
        "RC".to_string(),
    ];

    if let Some(existing) = rc_env_names
        .iter()
        .filter_map(env::var_os)
        .filter_map(resolve_command_path)
        .next()
    {
        println!(
            "cargo:warning=using Windows resource compiler {}",
            existing.display()
        );
        return Ok(());
    }

    let llvm_rc = match find_llvm_rc() {
        Some(path) => path,
        None => {
            let message = format!(
        "missing Windows resource compiler for target `{target}`. Install LLVM so `llvm-rc` is available, or set RC_{sanitized}=<path-to-llvm-rc> before building.",
        sanitized = target.replace('-', "_")
      );
            if allow_external_manifest {
                println!(
          "cargo:warning={message} Falling back to external .manifest packaging because THREADTERM_ALLOW_MISSING_WINDOWS_RC=1."
        );
                return Ok(());
            }
            return Err(message.into());
        }
    };

    let llvm_rc = llvm_rc.canonicalize().unwrap_or(llvm_rc);
    let llvm_rc_value = llvm_rc.into_os_string();

    println!(
        "cargo:warning=auto-configured Windows resource compiler {}",
        PathBuf::from(&llvm_rc_value).display()
    );
    env::set_var(format!("RC_{target}"), &llvm_rc_value);
    env::set_var(format!("RC_{}", target.replace('-', "_")), &llvm_rc_value);

    Ok(())
}

fn find_llvm_rc() -> Option<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(paths) = env::var_os("PATH") {
        candidates.extend(
            env::split_paths(&paths)
                .map(|dir| dir.join(executable_name("llvm-rc")))
                .collect::<Vec<_>>(),
        );
    }

    for known in [
        "/opt/homebrew/opt/llvm/bin/llvm-rc",
        "/usr/local/opt/llvm/bin/llvm-rc",
    ] {
        candidates.push(PathBuf::from(known));
    }

    if let Some(home) = env::var_os("HOME") {
        candidates.push(
            PathBuf::from(home)
                .join("Library")
                .join("Caches")
                .join("cargo-xwin")
                .join(executable_name("llvm-rc")),
        );
    }

    candidates
        .into_iter()
        .find(|candidate| is_executable_file(candidate))
}

fn executable_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

fn is_windows_msvc_target() -> Result<bool, env::VarError> {
    Ok(
        env::var("CARGO_CFG_TARGET_OS")? == "windows"
            && env::var("CARGO_CFG_TARGET_ENV")? == "msvc",
    )
}

/// Embed the Common Controls v6 manifest into every Windows MSVC artifact.
///
/// Tauri still generates its normal icon/version resource, but its copy of the
/// manifest is disabled above. Keeping the manifest in a separate resource lets
/// `embed-resource` link it into binaries, cdylibs, and library unit-test
/// harnesses without duplicating the application's VERSION or MANIFEST records.
fn embed_windows_manifest_resource() -> Result<(), Box<dyn Error>> {
    if !is_windows_msvc_target()? {
        return Ok(());
    }

    println!("cargo:rerun-if-changed=windows/common-controls-v6.manifest");
    println!("cargo:rerun-if-changed=windows/common-controls-v6.rc");
    embed_resource::compile_for_everything("windows/common-controls-v6.rc", embed_resource::NONE)
        .manifest_required()?;
    Ok(())
}

fn resolve_command_path(value: std::ffi::OsString) -> Option<PathBuf> {
    let candidate = PathBuf::from(&value);
    if candidate.components().count() > 1 {
        return is_executable_file(&candidate).then_some(candidate);
    }

    env::var_os("PATH").and_then(|paths| {
        env::split_paths(&paths)
            .map(|dir| dir.join(&value))
            .find(|path| is_executable_file(path))
    })
}
