use crate::providers::common::{command_output, find_executable, CommandSpec};
use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    time::Duration,
};

const MAX_JAVA_STARTUP_LOG_DIRECTORY_ENTRIES: usize = 64;
const MAX_JAVA_STARTUP_LOG_FILES: usize = 8;
const MAX_JAVA_STARTUP_LOG_BYTES: u64 = 128 * 1024;
const MAX_JAVA_STARTUP_LOG_TOTAL_BYTES: u64 = 256 * 1024;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ToolConfiguration {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub(super) typescript: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub(super) rust: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub(super) python: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub(super) java: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub(super) jdtls: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Family {
    TypeScript,
    Rust,
    Python,
    Java,
}

impl Family {
    pub(super) fn from_language(language: &str) -> Option<Self> {
        match language {
            "typescript" | "javascript" => Some(Self::TypeScript),
            "rust" => Some(Self::Rust),
            "python" => Some(Self::Python),
            "java" => Some(Self::Java),
            _ => None,
        }
    }

    pub(super) fn key(self) -> &'static str {
        match self {
            Self::TypeScript => "typescript-javascript",
            Self::Rust => "rust",
            Self::Python => "python",
            Self::Java => "java",
        }
    }
}

pub(super) fn language_id(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "ts" | "mts" | "cts" => Some("typescript"),
        "tsx" => Some("typescriptreact"),
        "js" | "mjs" | "cjs" => Some("javascript"),
        "jsx" => Some("javascriptreact"),
        "rs" => Some("rust"),
        "py" | "pyi" => Some("python"),
        "java" => Some("java"),
        _ => None,
    }
}

pub(super) struct Launch {
    pub(super) spec: CommandSpec,
    pub(super) initialize_options: Value,
    pub(super) settings: Option<Value>,
    pub(super) initialization_timeout: Duration,
}

#[derive(Clone, Debug)]
pub(super) struct Detection {
    pub(super) id: &'static str,
    pub(super) available: bool,
    pub(super) path: Option<String>,
    pub(super) message: Option<String>,
}

pub(super) fn resolve(
    family: Family,
    tools: &ToolConfiguration,
    root: &Path,
    context_data: &Path,
) -> Result<Launch> {
    match family {
        Family::TypeScript => typescript(tools, root),
        Family::Rust => rust(tools),
        Family::Python => python(tools),
        Family::Java => java(tools, context_data),
    }
}

pub(super) fn detect(tools: &ToolConfiguration) -> Vec<Detection> {
    let typescript = executable(&tools.typescript, "typescript-language-server");
    let rust = executable(&tools.rust, "rust-analyzer");
    let python = executable(&tools.python, "pyright-langserver");
    let java = executable(&tools.java, "java");
    let jdtls = jdtls_root(&tools.jdtls);
    vec![
        detection("typescript", typescript, "typescript-language-server was not found; install it explicitly or configure its executable path"),
        rust_detection(rust),
        detection("python", python, "pyright-langserver was not found; install Pyright explicitly or configure its executable path"),
        java_detection(java),
        detection("jdtls", jdtls, "JDT LS server directory was not found; configure the extracted server directory"),
    ]
}

pub(super) fn detect_quick(tools: &ToolConfiguration) -> Vec<Detection> {
    let pending = |id: &'static str, value: Result<PathBuf>, missing: &str| match value {
        Ok(path) => Detection {
            id,
            available: false,
            path: Some(path.to_string_lossy().into_owned()),
            message: Some("Compatibility check is running".into()),
        },
        Err(error) => Detection {
            id,
            available: false,
            path: None,
            message: Some(if error.to_string().contains("not found") {
                missing.to_owned()
            } else {
                error.to_string()
            }),
        },
    };
    vec![
        detection(
            "typescript",
            executable(&tools.typescript, "typescript-language-server"),
            "typescript-language-server was not found; install it explicitly or configure its executable path",
        ),
        pending(
            "rust",
            executable(&tools.rust, "rust-analyzer"),
            "rust-analyzer was not found; install the rust-analyzer component or configure its executable path",
        ),
        detection(
            "python",
            executable(&tools.python, "pyright-langserver"),
            "pyright-langserver was not found; install Pyright explicitly or configure its executable path",
        ),
        pending(
            "java",
            executable(&tools.java, "java"),
            "Java 21 or newer was not found; configure its executable path",
        ),
        detection(
            "jdtls",
            jdtls_root(&tools.jdtls),
            "JDT LS server directory was not found; configure the extracted server directory",
        ),
    ]
}

fn detection(id: &'static str, value: Result<PathBuf>, missing: &str) -> Detection {
    match value {
        Ok(path) => Detection {
            id,
            available: true,
            path: Some(path.to_string_lossy().into_owned()),
            message: None,
        },
        Err(error) => Detection {
            id,
            available: false,
            path: None,
            message: Some(if error.to_string().contains("not found") {
                missing.to_owned()
            } else {
                error.to_string()
            }),
        },
    }
}

fn java_detection(value: Result<PathBuf>) -> Detection {
    match value {
        Ok(path) => match java_major(&path) {
            Ok(major) if major >= 21 => Detection {
                id: "java",
                available: true,
                path: Some(path.to_string_lossy().into_owned()),
                message: None,
            },
            Ok(major) => Detection {
                id: "java",
                available: false,
                path: Some(path.to_string_lossy().into_owned()),
                message: Some(format!(
                    "Java 21 or newer is required by JDT LS; detected Java {major}"
                )),
            },
            Err(error) => Detection {
                id: "java",
                available: false,
                path: Some(path.to_string_lossy().into_owned()),
                message: Some(error.to_string()),
            },
        },
        Err(error) => Detection {
            id: "java",
            available: false,
            path: None,
            message: Some(if error.to_string().contains("not found") {
                "Java 21 or newer was not found; configure its executable path".into()
            } else {
                error.to_string()
            }),
        },
    }
}

fn rust_detection(value: Result<PathBuf>) -> Detection {
    match value {
        Ok(path) => {
            let result = CommandSpec::from_path(path.clone(), vec!["--version".into()])
                .map_err(|error| error.message)
                .and_then(|spec| command_output(&spec, Duration::from_secs(3)).map_err(|error| error.message));
            match result {
                Ok(_) => Detection {
                    id: "rust",
                    available: true,
                    path: Some(path.to_string_lossy().into_owned()),
                    message: None,
                },
                Err(message) => Detection {
                    id: "rust",
                    available: false,
                    path: Some(path.to_string_lossy().into_owned()),
                    message: Some(format!(
                        "rust-analyzer is present but unusable: {}",
                        message.chars().take(512).collect::<String>()
                    )),
                },
            }
        }
        Err(_) => Detection {
            id: "rust",
            available: false,
            path: None,
            message: Some(
                "rust-analyzer was not found; install the rust-analyzer component or configure its executable path"
                    .into(),
            ),
        },
    }
}

fn typescript(tools: &ToolConfiguration, root: &Path) -> Result<Launch> {
    let path = executable(&tools.typescript, "typescript-language-server")?;
    let tsserver = root.join("node_modules").join("typescript").join("lib");
    let mut options = json!({
        "disableAutomaticTypingAcquisition": true,
        "maxTsServerMemory": 512,
        "preferences": {"includePackageJsonAutoImports":"off"},
        "tsserver": {"useSyntaxServer":"never"}
    });
    if tsserver.is_dir() {
        options["tsserver"]["path"] = json!(crate::git_read::plain_path(&tsserver)
            .to_string_lossy()
            .into_owned());
    }
    Ok(Launch {
        spec: CommandSpec::from_path(path, vec!["--stdio".into()])
            .map_err(|error| anyhow!("navigation_server_unavailable: {}", error.message))?,
        initialize_options: options,
        settings: Some(json!({
            "typescript": {"disableAutomaticTypeAcquisition":true},
            "javascript": {"disableAutomaticTypeAcquisition":true}
        })),
        initialization_timeout: Duration::from_secs(30),
    })
}

fn rust(tools: &ToolConfiguration) -> Result<Launch> {
    let path = executable(&tools.rust, "rust-analyzer")?;
    Ok(Launch {
        spec: CommandSpec::from_path(path, Vec::new())
            .map_err(|error| anyhow!("navigation_server_unavailable: {}", error.message))?,
        initialize_options: json!({
            "cargo": {
                "buildScripts":{"enable":false},
                "noDeps":true,
                "autoreload":true,
                "extraArgs":["--offline"]
            },
            "procMacro": {"enable":false},
            "checkOnSave": false,
            "cachePriming": {"enable":false},
            // ThreadTerm does not claim client watched-file notifications. Let
            // rust-analyzer own disk watching while overlays remain explicit.
            "files": {"watcher":"server"},
            "numThreads": 1
        }),
        settings: None,
        initialization_timeout: Duration::from_secs(60),
    })
}

fn python(tools: &ToolConfiguration) -> Result<Launch> {
    let path = executable(&tools.python, "pyright-langserver")?;
    Ok(Launch {
        spec: CommandSpec::from_path(path, vec!["--stdio".into()])
            .map_err(|error| anyhow!("navigation_server_unavailable: {}", error.message))?,
        initialize_options: Value::Null,
        settings: Some(json!({"python":{"analysis":{"diagnosticMode":"openFilesOnly"}}})),
        initialization_timeout: Duration::from_secs(30),
    })
}

fn java(tools: &ToolConfiguration, context_data: &Path) -> Result<Launch> {
    let java = executable(&tools.java, "java")?;
    let major = java_major(&java)?;
    if major < 21 {
        return Err(anyhow!("navigation_java_incompatible: Java 21 or newer is required by JDT LS; detected Java {major}"));
    }
    let root = jdtls_root(&tools.jdtls)?;
    java_launch(java, root, context_data)
}

fn java_launch(java: PathBuf, root: PathBuf, context_data: &Path) -> Result<Launch> {
    let launcher = launcher_jar(&root)?;
    let shipped_configuration = root.join(platform_configuration());
    if !shipped_configuration.is_dir() {
        return Err(anyhow!(
            "navigation_server_unavailable: JDT LS platform configuration is missing at {}",
            shipped_configuration.display()
        ));
    }
    let configuration = context_data.join("configuration");
    let workspace = context_data.join("workspace");
    fs::create_dir_all(&configuration)
        .context("creating private JDT LS configuration directory")?;
    fs::create_dir_all(&workspace).context("creating private JDT LS workspace directory")?;
    copy_jdt_configuration(&shipped_configuration, &configuration)?;
    // Keep canonical paths for validation and filesystem reads, but Java's jar
    // loader rejects Windows' verbatim spelling at the child argv boundary.
    let child_launcher = crate::git_read::plain_path(&launcher);
    let child_configuration = crate::git_read::plain_path(&configuration);
    let child_workspace = crate::git_read::plain_path(&workspace);
    let safe_settings = json!({
        "java": {
            "autobuild": {"enabled":false},
            "configuration": {"updateBuildConfiguration":"disabled"},
            "import": {
                "gradle":{"enabled":false,"annotationProcessing":{"enabled":false}},
                "maven":{"enabled":false}
            },
            "sharedIndexes": {"enabled":"off"},
            "maxConcurrentBuilds": 1
        }
    });
    let args = vec![
        "--add-opens".into(),
        "java.base/java.util=ALL-UNNAMED".into(),
        "--add-opens".into(),
        "java.base/java.lang=ALL-UNNAMED".into(),
        format!("-Dosgi.install.area={}", super::lsp::file_uri(&root)),
        "-Declipse.application=org.eclipse.jdt.ls.core.id1".into(),
        "-Dosgi.bundles.defaultStartLevel=4".into(),
        "-Declipse.product=org.eclipse.jdt.ls.core.product".into(),
        "-Dlog.protocol=false".into(),
        "-Dlog.level=WARNING".into(),
        "-Xmx768m".into(),
        "-jar".into(),
        child_launcher.to_string_lossy().into_owned(),
        "-configuration".into(),
        child_configuration.to_string_lossy().into_owned(),
        "-data".into(),
        child_workspace.to_string_lossy().into_owned(),
    ];
    Ok(Launch {
        spec: CommandSpec::from_path(crate::git_read::plain_path(&java), args)
            .map_err(|error| anyhow!("navigation_server_unavailable: {}", error.message))?,
        // JDT can begin import work during initialize, so the same fail-closed
        // profile is present both here and in didChangeConfiguration.
        initialize_options: json!({"workspaceFolders":true,"settings":safe_settings}),
        settings: Some(safe_settings),
        initialization_timeout: Duration::from_secs(120),
    })
}

pub(super) fn java_startup_failure(context_data: &Path) -> Option<String> {
    let context_name = context_data.file_name()?.to_str()?;
    let context_id = uuid::Uuid::parse_str(context_name).ok()?;
    if context_id.to_string() != context_name {
        return None;
    }
    let context_metadata = fs::symlink_metadata(context_data).ok()?;
    if context_metadata.file_type().is_symlink() || !context_metadata.is_dir() {
        return None;
    }
    let context = context_data.canonicalize().ok()?;
    if context.file_name() != context_data.file_name() {
        return None;
    }

    let requested_configuration = context_data.join("configuration");
    let configuration_metadata = fs::symlink_metadata(&requested_configuration).ok()?;
    if configuration_metadata.file_type().is_symlink() || !configuration_metadata.is_dir() {
        return None;
    }
    let configuration = requested_configuration.canonicalize().ok()?;
    if configuration.parent() != Some(context.as_path()) {
        return None;
    }

    let mut logs = Vec::new();
    let mut total_bytes = 0_u64;
    let mut entries = fs::read_dir(&configuration).ok()?;
    for index in 0..=MAX_JAVA_STARTUP_LOG_DIRECTORY_ENTRIES {
        let Some(entry) = entries.next() else {
            break;
        };
        if index == MAX_JAVA_STARTUP_LOG_DIRECTORY_ENTRIES {
            return None;
        }
        let entry = entry.ok()?;
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("log") {
            continue;
        }
        let entry_type = entry.file_type().ok()?;
        if entry_type.is_symlink() || !entry_type.is_file() {
            continue;
        }
        let metadata = fs::symlink_metadata(&path).ok()?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            continue;
        }
        if logs.len() == MAX_JAVA_STARTUP_LOG_FILES {
            return None;
        }
        let canonical = path.canonicalize().ok()?;
        if canonical.parent() != Some(configuration.as_path()) {
            return None;
        }
        let canonical_metadata = fs::symlink_metadata(&canonical).ok()?;
        if canonical_metadata.file_type().is_symlink()
            || !canonical_metadata.is_file()
            || canonical_metadata.len() != metadata.len()
            || canonical_metadata.len() > MAX_JAVA_STARTUP_LOG_BYTES
        {
            return None;
        }
        total_bytes = total_bytes.checked_add(canonical_metadata.len())?;
        if total_bytes > MAX_JAVA_STARTUP_LOG_TOTAL_BYTES {
            return None;
        }
        logs.push((canonical, canonical_metadata.len()));
    }

    let mut required = None;
    for (path, expected_len) in logs {
        let file = fs::File::open(path).ok()?;
        let opened_metadata = file.metadata().ok()?;
        if !opened_metadata.is_file() || opened_metadata.len() != expected_len {
            return None;
        }
        let mut bytes = Vec::with_capacity(expected_len as usize);
        file.take(expected_len + 1).read_to_end(&mut bytes).ok()?;
        if bytes.len() as u64 != expected_len {
            return None;
        }
        let Ok(log) = std::str::from_utf8(&bytes) else {
            continue;
        };
        if let Some(version) = equinox_required_java_major(log) {
            required = Some(required.map_or(version, |current: u32| current.max(version)));
        }
    }
    required.map(|version| {
        format!(
            "navigation_java_incompatible: configured JDT LS requires Java {version} or newer; choose a compatible Java executable in Editor navigation settings"
        )
    })
}

fn equinox_required_java_major(log: &str) -> Option<u32> {
    const REQUIREMENT: &str = "Unresolved requirement: Require-Capability: osgi.ee";
    log.lines()
        .filter_map(|line| {
            let start = line.find(REQUIREMENT)? + REQUIREMENT.len();
            let filter = &line[start..];
            if !filter.contains("(osgi.ee=JavaSE)") {
                return None;
            }
            let version = ["(version>=", "(version="].into_iter().find_map(|marker| {
                let start = filter.find(marker)? + marker.len();
                let tail = &filter[start..];
                let end = tail.find(')')?;
                let version = &tail[..end];
                if version.is_empty()
                    || version.split('.').any(|part| {
                        part.is_empty() || !part.bytes().all(|byte| byte.is_ascii_digit())
                    })
                {
                    return None;
                }
                parse_java_major(version)
            })?;
            (1..=999).contains(&version).then_some(version)
        })
        .max()
}

fn executable(configured: &str, command: &str) -> Result<PathBuf> {
    if !configured.is_empty() {
        let path = PathBuf::from(configured);
        if !path.is_absolute() {
            return Err(anyhow!(
                "navigation_invalid_configuration: {command} path must be absolute"
            ));
        }
        if !path.is_file() {
            return Err(anyhow!(
                "navigation_server_unavailable: configured {command} executable does not exist"
            ));
        }
        // Canonicalize before trusting the configured file, then hand external
        // Node/cmd/native launchers the ordinary Windows drive/UNC spelling.
        return path
            .canonicalize()
            .map(|path| crate::git_read::plain_path(&path))
            .context("canonicalizing configured executable");
    }
    find_executable(command)
        .ok_or_else(|| anyhow!("navigation_server_unavailable: {command} executable was not found"))
}

fn jdtls_root(configured: &str) -> Result<PathBuf> {
    if !configured.is_empty() {
        let path = PathBuf::from(configured);
        if !path.is_absolute() {
            return Err(anyhow!(
                "navigation_invalid_configuration: JDT LS directory must be absolute"
            ));
        }
        if !path.is_dir() {
            return Err(anyhow!(
                "navigation_server_unavailable: configured JDT LS directory does not exist"
            ));
        }
        return path
            .canonicalize()
            .context("canonicalizing configured JDT LS directory");
    }
    if let Some(wrapper) = find_executable("jdtls") {
        for ancestor in wrapper.ancestors().skip(1).take(3) {
            if ancestor.join("plugins").is_dir() {
                return ancestor
                    .canonicalize()
                    .context("canonicalizing detected JDT LS directory");
            }
        }
    }
    Err(anyhow!(
        "navigation_server_unavailable: JDT LS server directory was not found"
    ))
}

fn launcher_jar(root: &Path) -> Result<PathBuf> {
    let plugins = root.join("plugins");
    let mut matches = fs::read_dir(&plugins)
        .with_context(|| format!("reading {}", plugins.display()))?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    name.starts_with("org.eclipse.equinox.launcher_") && name.ends_with(".jar")
                })
        })
        .collect::<Vec<_>>();
    matches.sort();
    matches
        .pop()
        .ok_or_else(|| anyhow!("navigation_server_unavailable: JDT LS launcher jar is missing"))
}

fn copy_jdt_configuration(source: &Path, target: &Path) -> Result<()> {
    let source = source.join("config.ini");
    let metadata =
        fs::metadata(&source).with_context(|| format!("reading {}", source.display()))?;
    if !metadata.is_file() || metadata.len() > 1024 * 1024 {
        return Err(anyhow!(
            "navigation_server_unavailable: JDT LS config.ini is missing or too large"
        ));
    }
    fs::copy(&source, target.join("config.ini")).context("copying private JDT LS config.ini")?;
    Ok(())
}

fn java_major(path: &Path) -> Result<u32> {
    let spec = CommandSpec::from_path(path.to_path_buf(), vec!["-version".into()])
        .map_err(|error| anyhow!("navigation_java_incompatible: {}", error.message))?;
    let output = command_output(&spec, Duration::from_secs(3)).map_err(|error| {
        anyhow!(
            "navigation_java_incompatible: unable to query Java version: {}",
            error.message
        )
    })?;
    parse_java_major(&output).ok_or_else(|| {
        anyhow!("navigation_java_incompatible: Java version output was not recognized")
    })
}

fn parse_java_major(output: &str) -> Option<u32> {
    let start = output.find(|character: char| character.is_ascii_digit())?;
    let token = output[start..]
        .split(|character: char| !(character.is_ascii_digit() || character == '.'))
        .next()?;
    let first = token.split('.').next()?.parse::<u32>().ok()?;
    if first == 1 {
        token.split('.').nth(1)?.parse().ok()
    } else {
        Some(first)
    }
}

#[cfg(target_os = "windows")]
fn platform_configuration() -> &'static str {
    "config_win"
}
#[cfg(target_os = "macos")]
fn platform_configuration() -> &'static str {
    "config_mac"
}
#[cfg(all(unix, not(target_os = "macos")))]
fn platform_configuration() -> &'static str {
    "config_linux"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn executable_fixture(root: &Path, name: &str) -> PathBuf {
        let path = root.join(name);
        fs::write(&path, b"fixture").unwrap();
        path.canonicalize().unwrap()
    }

    #[test]
    fn java_versions_cover_legacy_and_modern_formats() {
        assert_eq!(parse_java_major("java version \"1.8.0_212\""), Some(8));
        assert_eq!(
            parse_java_major("openjdk version \"17.0.4\" 2022-07-19"),
            Some(17)
        );
        assert_eq!(parse_java_major("openjdk 21.0.5 2024-10-15"), Some(21));
        assert_eq!(parse_java_major("not a version"), None);
    }

    #[test]
    fn language_ids_accept_the_full_dirty_group_without_claiming_unknown_files() {
        for (path, expected) in [
            ("a.tsx", Some("typescriptreact")),
            ("a.rs", Some("rust")),
            ("a.py", Some("python")),
            ("A.java", Some("java")),
            ("README.md", None),
        ] {
            assert_eq!(language_id(Path::new(path)), expected);
        }
    }

    #[test]
    fn fixed_non_java_adapters_keep_commands_and_safe_profiles_owned_by_runtime() {
        let temp = tempfile::tempdir().unwrap();
        let typescript_exe = executable_fixture(temp.path(), "typescript-language-server.exe");
        let rust_exe = executable_fixture(temp.path(), "rust-analyzer.exe");
        let pyright_exe = executable_fixture(temp.path(), "pyright-langserver.exe");
        fs::create_dir_all(temp.path().join("node_modules/typescript/lib")).unwrap();
        let root = temp.path().canonicalize().unwrap();

        let typescript = typescript(
            &ToolConfiguration {
                typescript: typescript_exe.to_string_lossy().into_owned(),
                ..ToolConfiguration::default()
            },
            &root,
        )
        .unwrap();
        assert_eq!(
            typescript.spec.program,
            crate::git_read::plain_path(&typescript_exe)
                .to_string_lossy()
                .into_owned()
        );
        assert_eq!(typescript.spec.args, vec!["--stdio".to_owned()]);
        assert_eq!(
            typescript.initialize_options["disableAutomaticTypingAcquisition"],
            true
        );
        assert_eq!(typescript.initialize_options["maxTsServerMemory"], 512);
        assert_eq!(
            typescript.initialize_options["tsserver"]["path"],
            crate::git_read::plain_path(&root.join("node_modules/typescript/lib"))
                .to_string_lossy()
                .into_owned()
        );
        assert_eq!(
            typescript.initialize_options["tsserver"]["useSyntaxServer"],
            "never"
        );

        let rust = rust(&ToolConfiguration {
            rust: rust_exe.to_string_lossy().into_owned(),
            ..ToolConfiguration::default()
        })
        .unwrap();
        assert_eq!(
            rust.spec.program,
            crate::git_read::plain_path(&rust_exe)
                .to_string_lossy()
                .into_owned()
        );
        assert!(rust.spec.args.is_empty());
        assert_eq!(
            rust.initialize_options,
            json!({
                "cargo": {
                    "buildScripts":{"enable":false},
                    "noDeps":true,
                    "autoreload":true,
                    "extraArgs":["--offline"]
                },
                "procMacro":{"enable":false},
                "checkOnSave":false,
                "cachePriming":{"enable":false},
                "files":{"watcher":"server"},
                "numThreads":1
            })
        );

        let python = python(&ToolConfiguration {
            python: pyright_exe.to_string_lossy().into_owned(),
            ..ToolConfiguration::default()
        })
        .unwrap();
        assert_eq!(
            python.spec.program,
            crate::git_read::plain_path(&pyright_exe)
                .to_string_lossy()
                .into_owned()
        );
        assert_eq!(python.spec.args, vec!["--stdio".to_owned()]);
        assert_eq!(
            python.settings.unwrap()["python"]["analysis"]["diagnosticMode"],
            "openFilesOnly"
        );
    }

    #[cfg(windows)]
    #[test]
    fn configured_windows_script_is_launched_without_the_verbatim_prefix() {
        let temp = tempfile::tempdir().unwrap();
        let canonical = executable_fixture(temp.path(), "language-server.cmd");
        assert!(canonical.to_string_lossy().starts_with(r"\\?\"));
        let configured = executable(&canonical.to_string_lossy(), "language-server").unwrap();
        assert_eq!(configured, crate::git_read::plain_path(&canonical));
        assert!(!configured.to_string_lossy().starts_with(r"\\?\"));
    }

    #[test]
    fn java_adapter_uses_private_configuration_workspace_and_preinitialize_safety() {
        let temp = tempfile::tempdir().unwrap();
        let server = temp.path().join("server");
        fs::create_dir_all(server.join("plugins")).unwrap();
        fs::create_dir_all(server.join(platform_configuration())).unwrap();
        fs::write(
            server.join("plugins/org.eclipse.equinox.launcher_1.0.0.jar"),
            b"jar",
        )
        .unwrap();
        fs::write(
            server.join(platform_configuration()).join("config.ini"),
            b"osgi.framework=file:plugins/framework.jar\n",
        )
        .unwrap();
        let java = executable_fixture(temp.path(), "java.exe");
        let private = temp.path().join("private-context");
        let server = server.canonicalize().unwrap();
        let launch = java_launch(java.clone(), server.clone(), &private).unwrap();
        let configuration = crate::git_read::plain_path(&private.join("configuration"))
            .to_string_lossy()
            .into_owned();
        let workspace = crate::git_read::plain_path(&private.join("workspace"))
            .to_string_lossy()
            .into_owned();
        let launcher = crate::git_read::plain_path(
            &server.join("plugins/org.eclipse.equinox.launcher_1.0.0.jar"),
        )
        .to_string_lossy()
        .into_owned();
        assert!(private.join("configuration/config.ini").is_file());
        assert_eq!(
            launch.spec.program,
            crate::git_read::plain_path(&java)
                .to_string_lossy()
                .into_owned()
        );
        assert!(launch
            .spec
            .args
            .windows(2)
            .any(|args| args[0] == "-jar" && args[1] == launcher.as_str()));
        assert!(launch
            .spec
            .args
            .windows(2)
            .any(|args| args[0] == "-configuration" && args[1] == configuration.as_str()));
        assert!(launch
            .spec
            .args
            .windows(2)
            .any(|args| args[0] == "-data" && args[1] == workspace.as_str()));
        assert!(!launch
            .spec
            .args
            .iter()
            .any(|arg| arg == "--add-modules=ALL-SYSTEM"));
        assert_eq!(
            launch.initialize_options["settings"]["java"]["autobuild"]["enabled"],
            false
        );
        assert_eq!(
            launch.settings.unwrap()["java"]["import"]["maven"]["enabled"],
            false
        );
    }

    fn private_java_context(root: &Path) -> PathBuf {
        let context = root
            .join("editor-navigation")
            .join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(context.join("configuration")).unwrap();
        context
    }

    fn equinox_java_requirement(version: &str) -> String {
        format!(
            "!MESSAGE Could not resolve module: private.bundle\n  Unresolved requirement: Require-Capability: osgi.ee; filter:=\"(&(osgi.ee=JavaSE)(version={version}))\"\n"
        )
    }

    #[test]
    fn java_startup_failure_reports_required_java_without_disclosing_log_text() {
        let temp = tempfile::tempdir().unwrap();
        let context = private_java_context(temp.path());
        let mut log = "x".repeat(72 * 1024);
        log.push('\n');
        log.push_str(&equinox_java_requirement("25"));
        log.push_str("private path and unrelated failure detail must not escape\n");
        fs::write(context.join("configuration/100.log"), log).unwrap();
        fs::write(
            context.join("configuration/200.log"),
            equinox_java_requirement("21"),
        )
        .unwrap();

        let message = java_startup_failure(&context).unwrap();
        assert_eq!(
            message,
            "navigation_java_incompatible: configured JDT LS requires Java 25 or newer; choose a compatible Java executable in Editor navigation settings"
        );
        assert!(!message.contains("private path"));
        assert!(!message.contains("private.bundle"));
    }

    #[test]
    fn java_startup_failure_ignores_unrelated_malformed_and_non_log_text() {
        let temp = tempfile::tempdir().unwrap();
        let context = private_java_context(temp.path());
        fs::write(
            context.join("configuration/unrelated.log"),
            "Require-Capability: osgi.ee; filter:=\"(&(osgi.ee=JavaSE)(version=25))\"\n",
        )
        .unwrap();
        fs::write(
            context.join("configuration/malformed.log"),
            equinox_java_requirement("twenty-five"),
        )
        .unwrap();
        fs::write(
            context.join("configuration/not-a-log.txt"),
            equinox_java_requirement("25"),
        )
        .unwrap();
        assert_eq!(java_startup_failure(&context), None);

        let invalid_context = temp.path().join("editor-navigation/not-a-uuid");
        fs::create_dir_all(invalid_context.join("configuration")).unwrap();
        fs::write(
            invalid_context.join("configuration/valid.log"),
            equinox_java_requirement("25"),
        )
        .unwrap();
        assert_eq!(java_startup_failure(&invalid_context), None);
    }

    #[test]
    fn java_startup_failure_rejects_oversize_and_excess_log_sets() {
        let temp = tempfile::tempdir().unwrap();
        let context = private_java_context(temp.path());
        let log = equinox_java_requirement("25");
        let mut oversized = log.as_bytes().to_vec();
        oversized.resize(MAX_JAVA_STARTUP_LOG_BYTES as usize + 1, b'x');
        let oversized_path = context.join("configuration/oversized.log");
        fs::write(&oversized_path, oversized).unwrap();
        assert_eq!(java_startup_failure(&context), None);
        fs::remove_file(oversized_path).unwrap();

        let mut bounded_log = log.as_bytes().to_vec();
        bounded_log.resize(56 * 1024, b'x');
        for index in 0..5 {
            fs::write(
                context
                    .join("configuration")
                    .join(format!("total-{index}.log")),
                &bounded_log,
            )
            .unwrap();
        }
        assert_eq!(java_startup_failure(&context), None);
        for index in 0..5 {
            fs::remove_file(
                context
                    .join("configuration")
                    .join(format!("total-{index}.log")),
            )
            .unwrap();
        }

        for index in 0..=MAX_JAVA_STARTUP_LOG_FILES {
            fs::write(
                context.join("configuration").join(format!("{index}.log")),
                if index == 0 {
                    log.as_str()
                } else {
                    "unrelated"
                },
            )
            .unwrap();
        }
        assert_eq!(java_startup_failure(&context), None);
    }

    #[cfg(unix)]
    #[test]
    fn java_startup_failure_does_not_follow_configuration_symlinks() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let context = private_java_context(temp.path());
        let outside = temp.path().join("outside-configuration");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("outside.log"), equinox_java_requirement("25")).unwrap();
        fs::remove_dir(context.join("configuration")).unwrap();
        symlink(&outside, context.join("configuration")).unwrap();

        assert_eq!(java_startup_failure(&context), None);
    }
}
