//! Live detection of runnable entries in a worktree.
//!
//! Detection reads files only: a build script is code, and running a build tool
//! just to list its tasks is slow. Every detector is bounded so a large or
//! hostile tree cannot stall the runtime — manifests are capped at 1 MiB, the
//! result at 200 entries, workspace expansion at 64 members and two directory
//! levels, and the whole scan at roughly 250 ms. `truncated` reports any cap.
//!
//! Entries are never stored: each popover open recomputes them, so a deleted
//! script retires itself. Keys are stable and readable (`node:apps/web/package.json:dev`)
//! so a saved copy can later be linked back to its source.
use crate::environment;
use serde::Serialize;
use std::{
    collections::{BTreeSet, HashMap},
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const MANIFEST_LIMIT: u64 = 1024 * 1024;
const MAX_ENTRIES: usize = 200;
const MAX_MEMBERS: usize = 64;
// A flat root may hold thousands of loose files; the project-directory scan stops
// there instead of walking the whole listing.
const MAX_SCAN_ENTRIES: usize = 4096;
// Wildcard index bound: `*` (index 0) and `a/*` (index 1) expand; `a/b/*` is too deep.
const MAX_GLOB_DEPTH: usize = 2;
const BUDGET: Duration = Duration::from_millis(250);
const SKIPPED_DIRS: [&str; 3] = ["node_modules", "target", ".git"];
// Additionally skipped while looking for a project directory one level down: these
// hold an environment or build output, never a project of their own.
const NESTED_SKIPPED_DIRS: [&str; 6] = ["venv", ".venv", "__pycache__", "build", "dist", "out"];
const WEB_FRAMEWORKS: [&str; 9] = [
    "axum", "actix-web", "rocket", "warp", "poem", "tide", "hyper", "tonic", "salvo",
];
const NODE_SERVICES: [&str; 5] = ["dev", "start", "serve", "preview", "watch"];
const MAKE_FILES: [&str; 3] = ["Makefile", "makefile", "GNUmakefile"];
const JUST_FILES: [&str; 3] = ["justfile", "Justfile", ".justfile"];
const COMPOSE_FILES: [&str; 4] = ["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"];

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DetectedSource {
    pub kind: String,
    pub file: String,
    pub label: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DetectedRunEntry {
    pub key: String,
    pub source: DetectedSource,
    pub name: String,
    pub command: String,
    pub shell: String,
    pub cwd: String,
    pub kind: String,
    pub group: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub missing_tool: Option<String>,
    /// Inferred from source code rather than declared in a manifest.
    #[serde(skip_serializing_if = "not_true")]
    pub suggested: bool,
}

fn not_true(value: &bool) -> bool {
    !*value
}

pub(crate) struct Detection {
    pub entries: Vec<DetectedRunEntry>,
    pub truncated: bool,
}

pub(crate) fn detect(root: &Path) -> Detection {
    detect_with(root, Budget::default())
}

fn detect_with(root: &Path, budget: Budget) -> Detection {
    detect_with_env(root, budget, None)
}

/// The test seam: an injected environment replaces the runtime's own terminal
/// environment, so a fixture never depends on what is installed on the machine.
fn detect_with_env(
    root: &Path,
    mut budget: Budget,
    vars: Option<Vec<(OsString, OsString)>>,
) -> Detection {
    let mut sink = Sink::with_vars(root, vars);
    detect_node(root, &mut budget, &mut sink);
    detect_cargo(root, &mut budget, &mut sink);
    jvm::detect_maven(root, &mut budget, &mut sink);
    jvm::detect_gradle(root, &mut budget, &mut sink);
    python::detect_python(root, &mut budget, &mut sink);
    detect_make(root, &mut budget, &mut sink);
    detect_just(root, &mut budget, &mut sink);
    detect_compose(root, &mut budget, &mut sink);
    detect_procfile(root, &mut budget, &mut sink);
    let mut entries = sink.entries;
    // A detected entry is launched through the same shell adapter as a saved
    // command, so it must pass the same command invariants to be listed at all.
    entries.retain(|entry| command_is_safe(&entry.command, &entry.shell));
    entries.sort_by(|left, right| left.key.cmp(&right.key));
    Detection {
        entries,
        truncated: budget.truncated,
    }
}

/// The command-text invariants `quickLaunch.save` enforces: no NUL, at most
/// 8,000 UTF-16 units, and one line when the shell is cmd.
pub(crate) fn command_is_safe(command: &str, shell: &str) -> bool {
    !command.contains('\0')
        && units(command) <= 8000
        && !(shell == "cmd" && command.contains(['\r', '\n']))
}

fn units(value: &str) -> usize {
    value.encode_utf16().count()
}

/// Detected commands are single-line; Windows runs them through cmd like every
/// other Quick Launch default, and other platforms keep their own default.
fn detected_shell() -> &'static str {
    if cfg!(windows) {
        "cmd"
    } else {
        "powershell"
    }
}

#[derive(Default)]
struct Budget {
    started: Option<Instant>,
    truncated: bool,
}

impl Budget {
    fn expired(&mut self) -> bool {
        let started = *self.started.get_or_insert_with(Instant::now);
        if started.elapsed() >= BUDGET {
            self.truncated = true;
            return true;
        }
        false
    }
}

struct Candidate {
    kind: &'static str,
    file: String,
    name: String,
    command: String,
    cwd: String,
    entry_kind: &'static str,
    group: String,
    key: String,
    suggested: bool,
}

struct Sink {
    entries: Vec<DetectedRunEntry>,
    keys: BTreeSet<String>,
    root: PathBuf,
    vars: environment::Vars,
    tools: HashMap<String, bool>,
}

impl Sink {
    fn with_vars(root: &Path, vars: Option<Vec<(OsString, OsString)>>) -> Self {
        let vars = vars.unwrap_or_else(|| {
            environment::for_terminal().unwrap_or_else(|| std::env::vars_os().collect())
        });
        Self {
            entries: Vec::new(),
            keys: BTreeSet::new(),
            root: root.to_owned(),
            vars,
            tools: HashMap::new(),
        }
    }

    fn push(&mut self, budget: &mut Budget, candidate: Candidate) {
        // A key addresses exactly one entry: `quickLaunch.run` re-detects and
        // launches the single match, so repeated headers never duplicate it.
        if self.keys.contains(&candidate.key) {
            return;
        }
        if self.entries.len() >= MAX_ENTRIES || budget.expired() {
            budget.truncated = true;
            return;
        }
        // A listed row must be addressable by `quickLaunch.run` (a key of at
        // most 512 units) and nameable by `quickLaunch.save` (80 characters).
        if candidate.name.chars().count() > 80 || units(&candidate.key) > 512 {
            budget.truncated = true;
            return;
        }
        self.keys.insert(candidate.key.clone());
        let tool = command_tool(&candidate.command);
        let directory = if candidate.cwd.is_empty() {
            self.root.clone()
        } else {
            self.root.join(&candidate.cwd)
        };
        let missing_tool = tool.and_then(|tool| {
            let cache_key = format!("{}|{}", tool.to_lowercase(), candidate.cwd);
            let known = *self
                .tools
                .entry(cache_key)
                .or_insert_with(|| tool_available(tool, &self.vars, &directory));
            (!known).then(|| tool.to_owned())
        });
        let label = candidate
            .file
            .rsplit('/')
            .next()
            .unwrap_or(&candidate.file)
            .to_owned();
        self.entries.push(DetectedRunEntry {
            key: candidate.key,
            source: DetectedSource {
                kind: candidate.kind.to_owned(),
                file: candidate.file,
                label,
            },
            name: candidate.name,
            command: candidate.command,
            shell: detected_shell().to_owned(),
            cwd: candidate.cwd,
            kind: candidate.entry_kind.to_owned(),
            group: candidate.group,
            missing_tool,
            suggested: candidate.suggested,
        });
    }
}

// ---------------------------------------------------------------- Node/npm

fn detect_node(root: &Path, budget: &mut Budget, sink: &mut Sink) {
    let root_value = read_text(&root.join("package.json"))
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok());
    let manager = node_manager(root);
    let mut patterns = Vec::new();
    if let Some(value) = &root_value {
        patterns.extend(node_workspace_patterns(value));
    }
    if let Some(text) = read_text(&root.join("pnpm-workspace.yaml")) {
        patterns.extend(yaml_package_patterns(&text));
    }
    // npm and pnpm both let a later `!` pattern remove a matched package.
    let (patterns, excludes) = split_negations(patterns);
    let mut dirs = BTreeSet::new();
    for pattern in patterns {
        if budget.expired() {
            return;
        }
        if dirs.len() >= MAX_MEMBERS {
            budget.truncated = true;
            break;
        }
        for dir in expand_pattern(root, &pattern, budget) {
            if dirs.len() >= MAX_MEMBERS {
                budget.truncated = true;
                break;
            }
            if path_matches_any(&excludes, &dir) {
                continue;
            }
            dirs.insert(dir);
        }
    }
    dirs.insert(String::new());
    for dir in dirs {
        if budget.expired() {
            return;
        }
        let file = manifest_path(&dir, "package.json");
        let value = if dir.is_empty() {
            root_value.clone()
        } else {
            read_text(&root.join(&dir).join("package.json"))
                .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        };
        let Some(value) = value else { continue };
        let Some(scripts) = value.get("scripts").and_then(|scripts| scripts.as_object()) else {
            continue;
        };
        let group = value
            .get("name")
            .and_then(|name| name.as_str())
            .filter(|name| !name.trim().is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| directory_label(root, &dir));
        for (script, _) in scripts {
            if lifecycle(script, scripts) || !script_argument(script) {
                continue;
            }
            let command = node_command(manager, script);
            sink.push(
                budget,
                Candidate {
                    kind: "node",
                    file: file.clone(),
                    name: script.clone(),
                    key: format!("node:{file}:{script}"),
                    command,
                    cwd: dir.clone(),
                    entry_kind: if NODE_SERVICES
                        .iter()
                        .any(|service| script == *service || prefixed(script, service))
                    {
                        "service"
                    } else {
                        "task"
                    },
                    group: group.clone(),
                    suggested: false,
                },
            );
        }
    }
}

fn prefixed(name: &str, prefix: &str) -> bool {
    name.strip_prefix(prefix)
        .and_then(|rest| rest.chars().next())
        .is_some_and(|next| next == ':' || next == '-' || next == '.')
}

fn node_manager(root: &Path) -> &'static str {
    if root.join("pnpm-lock.yaml").is_file() {
        "pnpm"
    } else if root.join("yarn.lock").is_file() {
        "yarn"
    } else if root.join("bun.lockb").is_file() || root.join("bun.lock").is_file() {
        "bun"
    } else {
        "npm"
    }
}

fn node_command(manager: &str, script: &str) -> String {
    match manager {
        "pnpm" => format!("pnpm run {script}"),
        "yarn" => format!("yarn {script}"),
        "bun" => format!("bun run {script}"),
        _ => format!("npm run {script}"),
    }
}

/// npm lifecycle hooks would duplicate (or re-run) the script they wrap.
/// `preview` is a real script unless another script is literally named `pre`.
fn lifecycle(name: &str, scripts: &serde_json::Map<String, serde_json::Value>) -> bool {
    matches!(name, "prepare" | "install" | "postinstall")
        || ["pre", "post"].iter().any(|prefix| {
            name.strip_prefix(prefix)
                .is_some_and(|rest| scripts.contains_key(rest))
        })
}

/// Script names become part of a shell command line, so refuse anything that
/// could expand or split it.
fn script_argument(name: &str) -> bool {
    !name.is_empty()
        && name.chars().count() <= 128
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '.' | '/' | '@' | '-' | '_'))
}

fn node_workspace_patterns(value: &serde_json::Value) -> Vec<String> {
    let list = match value.get("workspaces") {
        Some(serde_json::Value::Array(items)) => items.clone(),
        Some(serde_json::Value::Object(map)) => map
            .get("packages")
            .and_then(|packages| packages.as_array())
            .cloned()
            .unwrap_or_default(),
        _ => return Vec::new(),
    };
    list.iter()
        .filter_map(|item| item.as_str())
        .map(str::to_owned)
        .collect()
}

fn yaml_package_patterns(text: &str) -> Vec<String> {
    let mut patterns = Vec::new();
    let mut in_packages = false;
    for raw in text.lines() {
        let line = strip_comment(raw);
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        if indent == 0 {
            in_packages = trimmed == "packages:" || trimmed.starts_with("packages: ");
            if let Some(rest) = trimmed.strip_prefix("packages:") {
                let rest = rest.trim();
                if rest.starts_with('[') {
                    for item in rest.trim_start_matches('[').trim_end_matches(']').split(',') {
                        push_pattern(&mut patterns, item);
                    }
                }
            }
            continue;
        }
        if !in_packages {
            continue;
        }
        if let Some(item) = trimmed.strip_prefix('-') {
            push_pattern(&mut patterns, item);
        }
    }
    patterns
}

fn push_pattern(patterns: &mut Vec<String>, item: &str) {
    let value = unquote(item.trim());
    if !value.is_empty() {
        patterns.push(value.to_owned());
    }
}

/// Splits `!pattern` negations from the patterns that expand workspaces.
fn split_negations(patterns: Vec<String>) -> (Vec<String>, Vec<String>) {
    let mut includes = Vec::new();
    let mut excludes = Vec::new();
    for pattern in patterns {
        match pattern.strip_prefix('!') {
            Some(rest) if !rest.is_empty() => excludes.push(rest.to_owned()),
            Some(_) => {}
            None => includes.push(pattern),
        }
    }
    (includes, excludes)
}

// ---------------------------------------------------------------- Cargo

fn detect_cargo(root: &Path, budget: &mut Budget, sink: &mut Sink) {
    let Some(text) = read_text(&root.join("Cargo.toml")) else {
        return;
    };
    let Ok(document) = text.parse::<toml_edit::DocumentMut>() else {
        return;
    };
    let mut dirs: Vec<String> = Vec::new();
    let mut workspace = false;
    if let Some(table) = document.get("workspace").and_then(toml_edit::Item::as_table) {
        let members = string_array(table.get("members"));
        workspace = !members.is_empty();
        let exclude = string_array(table.get("exclude"));
        for pattern in members {
            if budget.expired() {
                return;
            }
            if dirs.len() >= MAX_MEMBERS {
                budget.truncated = true;
                break;
            }
            for dir in expand_pattern(root, &pattern, budget) {
                if dirs.len() >= MAX_MEMBERS {
                    budget.truncated = true;
                    break;
                }
                if !dirs.contains(&dir) && !path_matches_any(&exclude, &dir) {
                    dirs.push(dir);
                }
            }
        }
    }
    if document.get("package").is_some() {
        dirs.insert(0, String::new());
    }
    // A single package needs no `-p`: cargo already resolves its only target.
    let single = dirs.len() == 1;
    for dir in dirs {
        if budget.expired() {
            return;
        }
        let manifest = if dir.is_empty() {
            Some(text.clone())
        } else {
            read_text(&root.join(&dir).join("Cargo.toml"))
        };
        let Some(manifest) = manifest else { continue };
        let Ok(package) = manifest.parse::<toml_edit::DocumentMut>() else {
            continue;
        };
        let Some(name) = package
            .get("package")
            .and_then(toml_edit::Item::as_table)
            .and_then(|table| table.get("name"))
            .and_then(toml_edit::Item::as_str)
        else {
            continue;
        };
        let name = name.to_owned();
        // The package name is interpolated into the command line as `-p <name>`.
        if !cargo_name(&name) {
            continue;
        }
        let file = manifest_path(&dir, "Cargo.toml");
        let scope = if dir.is_empty() {
            String::new()
        } else {
            format!("{dir}:")
        };
        let entry_kind = if web_framework(&package) {
            "service"
        } else {
            "task"
        };
        for binary in cargo_bins(root, &dir, &package, &name) {
            let command = if single {
                format!("cargo run --bin {binary}")
            } else {
                format!("cargo run -p {name} --bin {binary}")
            };
            sink.push(
                budget,
                Candidate {
                    kind: "cargo",
                    file: file.clone(),
                    name: binary.clone(),
                    key: format!("cargo:{scope}run:{binary}"),
                    command,
                    cwd: dir.clone(),
                    entry_kind,
                    group: name.clone(),
                    suggested: false,
                },
            );
        }
        for (task, command) in [
            ("test", cargo_task("test", &name, single)),
            ("build", cargo_task("build", &name, single)),
        ] {
            sink.push(
                budget,
                Candidate {
                    kind: "cargo",
                    file: file.clone(),
                    name: task.to_owned(),
                    key: format!("cargo:{scope}{task}"),
                    command,
                    cwd: dir.clone(),
                    entry_kind: "task",
                    group: name.clone(),
                    suggested: false,
                },
            );
        }
    }
    if workspace {
        for task in ["test", "build"] {
            sink.push(
                budget,
                Candidate {
                    kind: "cargo",
                    file: "Cargo.toml".into(),
                    name: task.to_owned(),
                    key: format!("cargo:workspace:{task}"),
                    command: format!("cargo {task}"),
                    cwd: String::new(),
                    entry_kind: "task",
                    group: "workspace".into(),
                    suggested: false,
                },
            );
        }
    }
}

fn cargo_task(task: &str, name: &str, single: bool) -> String {
    if single {
        format!("cargo {task}")
    } else {
        format!("cargo {task} -p {name}")
    }
}

fn string_array(item: Option<&toml_edit::Item>) -> Vec<String> {
    item.and_then(toml_edit::Item::as_array)
        .map(|array| {
            array
                .iter()
                .filter_map(toml_edit::Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn cargo_bins(root: &Path, dir: &str, package: &toml_edit::DocumentMut, name: &str) -> Vec<String> {
    let mut bins: Vec<String> = Vec::new();
    if let Some(tables) = package.get("bin").and_then(toml_edit::Item::as_array_of_tables) {
        for table in tables.iter() {
            if let Some(bin) = table.get("name").and_then(toml_edit::Item::as_str) {
                bins.push(bin.to_owned());
            }
        }
    }
    if let Some(array) = package.get("bin").and_then(toml_edit::Item::as_array) {
        for value in array.iter() {
            if let Some(bin) = value
                .as_inline_table()
                .and_then(|table| table.get("name"))
                .and_then(toml_edit::Value::as_str)
            {
                bins.push(bin.to_owned());
            }
        }
    }
    let base = if dir.is_empty() {
        root.to_path_buf()
    } else {
        root.join(dir)
    };
    if base.join("src").join("main.rs").is_file() {
        bins.push(name.to_owned());
    }
    if let Ok(read) = fs::read_dir(base.join("src").join("bin")) {
        let mut stems: Vec<String> = read
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
            .filter_map(|entry| {
                let file = entry.file_name().to_str()?.to_owned();
                file.strip_suffix(".rs").map(str::to_owned)
            })
            .collect();
        stems.sort();
        bins.extend(stems);
    }
    let mut seen = BTreeSet::new();
    bins.retain(|bin| cargo_name(bin));
    bins.retain(|bin| seen.insert(bin.clone()));
    bins
}

/// A package or bin name reaches the cmd line verbatim, so accept only the same
/// identifier shape the other detectors allow; anything else is skipped.
fn cargo_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|first| first.is_ascii_alphanumeric() || first == '_')
        && name.chars().count() <= 128
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
}

fn web_framework(package: &toml_edit::DocumentMut) -> bool {
    ["dependencies", "dev-dependencies", "build-dependencies"]
        .iter()
        .filter_map(|key| package.get(key).and_then(toml_edit::Item::as_table))
        .any(|table| {
            table.iter().any(|(name, _)| {
                WEB_FRAMEWORKS
                    .iter()
                    .any(|framework| name.eq_ignore_ascii_case(framework))
            })
        })
}

// ---------------------------------------------------------------- Makefile

fn detect_make(root: &Path, budget: &mut Budget, sink: &mut Sink) {
    let Some(file) = MAKE_FILES.iter().find(|name| root.join(name).is_file()) else {
        return;
    };
    let Some(text) = read_text(&root.join(file)) else {
        return;
    };
    for line in text.lines() {
        if budget.expired() {
            return;
        }
        if !line.starts_with(|c: char| c.is_ascii_alphanumeric()) {
            continue;
        }
        let Some((target, rest)) = line.split_once(':') else {
            continue;
        };
        // Variable assignments (:=) and double-colon rules are not targets, and
        // special (.PHONY) and pattern (%) rules are not runnable names.
        if rest.starts_with(['=', ':']) || target.contains(['%', ' ', '\t']) {
            continue;
        }
        if !valid_name(target) {
            continue;
        }
        sink.push(
            budget,
            Candidate {
                kind: "make",
                file: file.to_string(),
                name: target.to_owned(),
                key: format!("make:{file}:{target}"),
                command: format!("make {target}"),
                cwd: String::new(),
                entry_kind: "task",
                group: file.to_string(),
                    suggested: false,
            },
        );
    }
}

// ---------------------------------------------------------------- justfile

fn detect_just(root: &Path, budget: &mut Budget, sink: &mut Sink) {
    let Some(file) = JUST_FILES.iter().find(|name| root.join(name).is_file()) else {
        return;
    };
    let Some(text) = read_text(&root.join(file)) else {
        return;
    };
    for line in text.lines() {
        if budget.expired() {
            return;
        }
        if line.is_empty() || line.starts_with(|c: char| c.is_whitespace()) {
            continue;
        }
        // Attributes (`[private]`) and comments are not recipes.
        if line.starts_with(['#', '[']) {
            continue;
        }
        let line = line.strip_prefix('@').unwrap_or(line);
        let Some((header, rest)) = line.split_once(':') else {
            continue;
        };
        // `name := value` is a variable assignment, not a recipe.
        if rest.starts_with('=') {
            continue;
        }
        let name = header.split_whitespace().next().unwrap_or_default();
        if !valid_recipe(name)
            || matches!(
                name,
                "set" | "alias" | "import" | "mod" | "export" | "unexport"
            )
        {
            continue;
        }
        sink.push(
            budget,
            Candidate {
                kind: "just",
                file: file.to_string(),
                name: name.to_owned(),
                key: format!("just:{file}:{name}"),
                command: format!("just {name}"),
                cwd: String::new(),
                entry_kind: "task",
                group: file.to_string(),
                    suggested: false,
            },
        );
    }
}

fn valid_recipe(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
        && !name.starts_with('_')
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

// ---------------------------------------------------------------- Compose

fn detect_compose(root: &Path, budget: &mut Budget, sink: &mut Sink) {
    let Some(file) = COMPOSE_FILES.iter().find(|name| root.join(name).is_file()) else {
        return;
    };
    let Some(text) = read_text(&root.join(file)) else {
        return;
    };
    for service in compose_services(&text) {
        if budget.expired() {
            return;
        }
        sink.push(
            budget,
            Candidate {
                kind: "compose",
                file: file.to_string(),
                name: service.clone(),
                key: format!("compose:{file}:{service}"),
                command: format!("docker compose up {service}"),
                cwd: String::new(),
                entry_kind: "service",
                group: file.to_string(),
                    suggested: false,
            },
        );
    }
}

/// A deliberately small YAML subset: the indentation of the first key under
/// `services:` defines the service level, and deeper keys are nested config.
/// Malformed input yields no entries instead of an error.
fn compose_services(text: &str) -> Vec<String> {
    let mut services = Vec::new();
    let mut in_services = false;
    let mut level = 0usize;
    let mut names = BTreeSet::new();
    for raw in text.lines() {
        let line = strip_comment(raw);
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if line.contains('\t') {
            return Vec::new();
        }
        let indent = line.len() - line.trim_start().len();
        if !in_services {
            in_services = indent == 0 && trimmed == "services:";
            continue;
        }
        if indent == 0 {
            break;
        }
        if level == 0 {
            level = indent;
        } else if indent < level {
            return Vec::new();
        }
        if indent != level {
            continue;
        }
        let Some(name) = yaml_key(trimmed) else {
            return Vec::new();
        };
        if !valid_name(name) {
            return Vec::new();
        }
        if names.insert(name.to_owned()) {
            services.push(name.to_owned());
        }
    }
    services
}

fn yaml_key(trimmed: &str) -> Option<&str> {
    if let Some(rest) = trimmed.strip_prefix(['"', '\'']) {
        let quote = trimmed.chars().next()?;
        let end = rest.find(quote)?;
        let after = rest[end + 1..].trim_start();
        return after.starts_with(':').then(|| &rest[..end]);
    }
    let (key, after) = trimmed.split_once(':')?;
    let key = key.trim();
    (!key.is_empty() && (after.is_empty() || after.starts_with(' '))).then_some(key)
}

// ---------------------------------------------------------------- Procfile

fn detect_procfile(root: &Path, budget: &mut Budget, sink: &mut Sink) {
    let Some(text) = read_text(&root.join("Procfile")) else {
        return;
    };
    for raw in text.lines() {
        if budget.expired() {
            return;
        }
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((name, command)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim();
        let command = command.trim();
        if !valid_name(name) || command.is_empty() {
            continue;
        }
        sink.push(
            budget,
            Candidate {
                kind: "procfile",
                file: "Procfile".into(),
                name: name.to_owned(),
                key: format!("procfile:Procfile:{name}"),
                command: command.to_owned(),
                cwd: String::new(),
                entry_kind: "service",
                group: "Procfile".into(),
                    suggested: false,
            },
        );
    }
}

// ---------------------------------------------------------------- helpers

fn manifest_path(dir: &str, file: &str) -> String {
    if dir.is_empty() {
        file.to_owned()
    } else {
        format!("{dir}/{file}")
    }
}

fn directory_label(root: &Path, dir: &str) -> String {
    if dir.is_empty() {
        root.file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| ".".into())
    } else {
        dir.to_owned()
    }
}

fn read_text(path: &Path) -> Option<String> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MANIFEST_LIMIT {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    if bytes.len() as u64 > MANIFEST_LIMIT {
        return None;
    }
    Some(
        String::from_utf8_lossy(&bytes)
            .trim_start_matches('\u{feff}')
            .to_owned(),
    )
}

fn skipped_dir(name: &str) -> bool {
    name.starts_with('.') || SKIPPED_DIRS.iter().any(|skip| name.eq_ignore_ascii_case(skip))
}

/// Expands literal workspace paths and a single trailing `*`/`**` segment one
/// directory level deep (both spellings mean "any child directory"). `a/*` is
/// depth 1 and `a/b/*` exceeds the two-segment bound, which is reported as
/// truncation instead of silently dropping the pattern. Literal paths go
/// through the same directory filters as wildcard matches.
fn expand_pattern(root: &Path, pattern: &str, budget: &mut Budget) -> Vec<String> {
    let cleaned = unquote(pattern.trim()).replace('\\', "/");
    let segments: Vec<&str> = cleaned
        .split('/')
        .filter(|segment| !segment.is_empty() && *segment != ".")
        .collect();
    if segments.is_empty() || segments.iter().any(|segment| *segment == ".." || segment.contains(':')) {
        return Vec::new();
    }
    let Some(wildcard) = segments.iter().position(|segment| segment.contains('*')) else {
        // A literal path must exist, avoid the vendored/hidden directories and
        // resolve inside the worktree: a junction must not make detection read a
        // manifest outside the root.
        let relative = segments.join("/");
        let directory = root.join(&relative);
        if !directory.is_dir() || segments.iter().any(|segment| skipped_dir(segment)) {
            return Vec::new();
        }
        return match (directory.canonicalize(), root.canonicalize()) {
            (Ok(path), Ok(base)) if path.starts_with(&base) => vec![relative],
            _ => Vec::new(),
        };
    };
    if wildcard + 1 != segments.len() {
        return Vec::new();
    }
    if wildcard >= MAX_GLOB_DEPTH {
        budget.truncated = true;
        return Vec::new();
    }
    let prefix = segments[..wildcard].join("/");
    let directory = if prefix.is_empty() {
        root.to_path_buf()
    } else {
        root.join(&prefix)
    };
    let Ok(read) = fs::read_dir(directory) else {
        return Vec::new();
    };
    let mut found: Vec<String> = Vec::new();
    for entry in read.filter_map(Result::ok) {
        if budget.expired() {
            break;
        }
        // Collect one past the cap so the caller knows the tree is bigger.
        if found.len() > MAX_MEMBERS {
            budget.truncated = true;
            break;
        }
        if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if skipped_dir(&name) || !glob_matches(segments[wildcard], &name) {
            continue;
        }
        found.push(manifest_path(&prefix, &name));
    }
    found.sort();
    found
}

/// One path segment: `*` and `?` wildcards, with `**` behaving like `*` so
/// `dir/**` stays one directory level.
fn glob_matches(pattern: &str, name: &str) -> bool {
    let pattern: Vec<char> = pattern.chars().collect();
    let name: Vec<char> = name.chars().collect();
    let (mut p, mut n) = (0usize, 0usize);
    let mut star: Option<usize> = None;
    let mut resume = 0usize;
    while n < name.len() {
        if p < pattern.len() && (pattern[p] == '?' || pattern[p] == name[n]) {
            p += 1;
            n += 1;
        } else if p < pattern.len() && pattern[p] == '*' {
            star = Some(p + 1);
            resume = n;
            p += 1;
        } else if let Some(after) = star {
            resume += 1;
            n = resume;
            p = after;
        } else {
            return false;
        }
    }
    pattern[p..].iter().all(|c| *c == '*')
}

fn path_matches_any(patterns: &[String], rel: &str) -> bool {
    patterns.iter().any(|pattern| {
        let cleaned = unquote(pattern.trim()).replace('\\', "/");
        let cleaned = cleaned.trim_end_matches('/');
        if !cleaned.contains('*') {
            return cleaned == rel;
        }
        let parts: Vec<&str> = cleaned.split('/').collect();
        let candidate: Vec<&str> = rel.split('/').collect();
        parts.len() == candidate.len()
            && parts
                .iter()
                .zip(&candidate)
                .all(|(pattern, actual)| glob_matches(pattern, actual))
    })
}

/// Reads `PATH`/`PATHEXT` from the caller's environment snapshot. Like cmd.exe,
/// the entry's own working directory is searched first. This is a lookup only:
/// nothing is executed.
fn tool_available(tool: &str, vars: &[(OsString, OsString)], cwd: &Path) -> bool {
    if tool.is_empty() || tool.contains(['/', '\\', '=']) || tool.starts_with('-') {
        return true;
    }
    let extensions = executable_extensions(vars);
    if present_in(cwd, tool, &extensions) {
        return true;
    }
    tool_on_path(tool, vars)
}

/// A PATH lookup without the working directory: the Python detector only asks
/// whether the `py` launcher exists, never whether the project ships one.
fn tool_on_path(tool: &str, vars: &[(OsString, OsString)]) -> bool {
    let Some(path) = var(vars, "PATH") else {
        return false;
    };
    let extensions = executable_extensions(vars);
    std::env::split_paths(path).any(|directory| present_in(&directory, tool, &extensions))
}

fn executable_extensions(vars: &[(OsString, OsString)]) -> Vec<String> {
    if !cfg!(windows) {
        return Vec::new();
    }
    var(vars, "PATHEXT")
        .map(|value| {
            value
                .to_string_lossy()
                .split(';')
                .filter(|ext| !ext.trim().is_empty())
                .map(|ext| ext.trim().to_owned())
                .collect::<Vec<String>>()
        })
        .filter(|extensions| !extensions.is_empty())
        .unwrap_or_else(|| {
            [".COM", ".EXE", ".BAT", ".CMD"]
                .iter()
                .map(|ext| (*ext).to_owned())
                .collect()
        })
}

fn present_in(directory: &Path, tool: &str, extensions: &[String]) -> bool {
    directory.join(tool).is_file()
        || extensions
            .iter()
            .any(|extension| directory.join(format!("{tool}{extension}")).is_file())
}

fn var<'a>(vars: &'a [(OsString, OsString)], name: &str) -> Option<&'a OsString> {
    vars.iter()
        .find(|(key, _)| key.to_string_lossy().eq_ignore_ascii_case(name))
        .map(|(_, value)| value)
}

fn command_tool(command: &str) -> Option<&str> {
    let tool = command.split_whitespace().next()?;
    let tool = unquote(tool);
    (!tool.is_empty()).then_some(tool)
}

fn unquote(value: &str) -> &str {
    let value = value.trim();
    for quote in ['"', '\''] {
        if value.len() >= 2 && value.starts_with(quote) && value.ends_with(quote) {
            return &value[1..value.len() - 1];
        }
    }
    value
}

fn strip_comment(line: &str) -> &str {
    let mut quote = None;
    for (index, raw) in line.char_indices() {
        match (quote, raw) {
            (Some(open), _) if raw == open => quote = None,
            (Some(_), _) => {}
            (None, '"') | (None, '\'') => quote = Some(raw),
            (None, '#')
                if index == 0 || line[..index].chars().next_back().is_some_and(char::is_whitespace) =>
            {
                return &line[..index]
            }
            _ => {}
        }
    }
    line
}


/// The worktree root when it holds one of the ecosystem's manifests, else the
/// immediate child directories that do — the common `backend/` + `frontend/`
/// layout. Hidden, vendored, environment and build-output directories are
/// skipped; only candidate directories count toward the 64-project cap, the
/// whole listing is bounded separately, and every child must resolve inside the
/// root so a junction cannot make detection read a manifest outside the worktree.
fn project_dirs(root: &Path, budget: &mut Budget, is_project: &dyn Fn(&Path) -> bool) -> Vec<String> {
    if is_project(root) {
        return vec![String::new()];
    }
    let Ok(read) = fs::read_dir(root) else {
        return Vec::new();
    };
    // The root is the base a child must stay inside, resolved once.
    let Ok(base) = root.canonicalize() else {
        return Vec::new();
    };
    let mut found: Vec<String> = Vec::new();
    let mut iterated = 0usize;
    for entry in read.filter_map(Result::ok) {
        if budget.expired() {
            break;
        }
        if iterated >= MAX_SCAN_ENTRIES {
            budget.truncated = true;
            break;
        }
        iterated += 1;
        if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if skipped_dir(&name)
            || NESTED_SKIPPED_DIRS
                .iter()
                .any(|skip| name.eq_ignore_ascii_case(skip))
        {
            continue;
        }
        if found.len() >= MAX_MEMBERS {
            budget.truncated = true;
            break;
        }
        let directory = root.join(&name);
        if !directory
            .canonicalize()
            .is_ok_and(|path| path.starts_with(&base))
        {
            continue;
        }
        if is_project(&directory) {
            found.push(name);
        }
    }
    found.sort();
    found
}

#[path = "run_detect_jvm.rs"]
mod jvm;
#[path = "run_detect_python.rs"]
mod python;

#[cfg(test)]
#[path = "run_detect_tests.rs"]
mod tests;
