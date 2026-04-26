use std::{
  env,
  error::Error,
  path::{Path, PathBuf},
};

fn main() -> Result<(), Box<dyn Error>> {
  configure_windows_resource_compiler()?;
  tauri_build::try_build(tauri_build::Attributes::default())?;
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
    .filter_map(|name| env::var_os(name))
    .filter_map(resolve_command_path)
    .next()
  {
    println!("cargo:warning=using Windows resource compiler {}", existing.display());
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

  candidates.into_iter().find(|candidate| is_executable_file(candidate))
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
