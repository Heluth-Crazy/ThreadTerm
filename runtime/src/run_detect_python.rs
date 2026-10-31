//! Python detector for the Run view.
//!
//! Follows the agreed Python spec: the interpreter comes from a lockfile runner,
//! a project `.venv`/`venv` called directly, or PATH; entries are declared
//! `[project.scripts]`, Django's `manage.py` and pytest. FastAPI/Flask entries are
//! inferred from a bounded scan of the usual app modules and marked `suggested`.
//! Files are read only; nothing is executed and no environment is activated.
use super::*;
use std::io::Read;

const PYTHON_MANIFESTS: [&str; 6] = [
    "pyproject.toml",
    "manage.py",
    "setup.py",
    "setup.cfg",
    "requirements.txt",
    "pytest.ini",
];
const APP_FILES: [&str; 3] = ["main.py", "app.py", "app/main.py"];
const MAX_SRC_DIRS: usize = 8;
const HEAD_LIMIT: u64 = 64 * 1024;
const RUNNERS: [(&str, &str); 4] = [
    ("uv.lock", "uv"),
    ("poetry.lock", "poetry"),
    ("pdm.lock", "pdm"),
    ("Pipfile.lock", "pipenv"),
];

pub(super) fn detect_python(root: &Path, budget: &mut Budget, sink: &mut Sink) {
    for dir in project_dirs(root, budget, &|dir| python_project(dir)) {
        if budget.expired() {
            return;
        }
        detect_python_project(root, &dir, budget, sink);
    }
}

fn python_project(dir: &Path) -> bool {
    PYTHON_MANIFESTS.iter().any(|name| dir.join(name).is_file())
        || APP_FILES.iter().any(|name| dir.join(name).is_file())
        || !src_apps(dir, &mut Budget::default()).is_empty()
}

fn detect_python_project(root: &Path, dir: &str, budget: &mut Budget, sink: &mut Sink) {
    let project = if dir.is_empty() {
        root.to_path_buf()
    } else {
        root.join(dir)
    };
    let runner = resolve_runner(root, dir, sink);
    let pyproject = read_text(&project.join("pyproject.toml"))
        .and_then(|text| text.parse::<toml_edit::DocumentMut>().ok());
    let group = project_group(pyproject.as_ref(), root, dir);
    if let Some(document) = pyproject.as_ref() {
        let Some(names) = script_names(document, budget) else {
            return;
        };
        for name in names {
            if budget.expired() {
                return;
            }
            let Some(command) = script_command(&runner, &name) else {
                continue;
            };
            let file = manifest_path(dir, "pyproject.toml");
            sink.push(
                budget,
                Candidate {
                    kind: "python",
                    file: file.clone(),
                    name: name.clone(),
                    key: format!("python:{file}:script:{name}"),
                    command,
                    cwd: dir.to_owned(),
                    entry_kind: "task",
                    group: group.clone(),
                    suggested: false,
                },
            );
        }
    }
    detect_django(dir, &project, &runner, budget, sink, &group);
    detect_pytest(dir, &project, pyproject.as_ref(), &runner, budget, sink, &group);
    detect_frameworks(dir, &project, &runner, budget, sink, &group);
}

// ---------------------------------------------------------------- runner

enum Runner {
    /// `uv run` / `poetry run` / `pdm run` / `pipenv run`, with `<prefix> python`.
    Tool { prefix: String, interpreter: String },
    /// A project environment's interpreter and script directory, relative to the
    /// entry's cwd and called without activation.
    Venv {
        interpreter: String,
        scripts: String,
        /// Absolute `Scripts`/`bin` directory, used to check that a script exists.
        directory: PathBuf,
    },
    /// PATH only: `py -3` when the launcher exists, else `python`; scripts are bare.
    Path(String),
}

impl Runner {
    fn interpreter(&self) -> &str {
        match self {
            Runner::Tool { interpreter, .. } => interpreter,
            Runner::Venv { interpreter, .. } => interpreter,
            Runner::Path(interpreter) => interpreter,
        }
    }
}

fn resolve_runner(root: &Path, dir: &str, sink: &Sink) -> Runner {
    let project = if dir.is_empty() {
        root.to_path_buf()
    } else {
        root.join(dir)
    };
    // The project directory is resolved completely before the worktree root: its
    // own lockfile or environment always wins over a shared one at the root.
    let mut locations: Vec<(&Path, bool)> = vec![(&project, false)];
    if !dir.is_empty() {
        locations.push((root, true));
    }
    for (location, at_root) in locations {
        for (lockfile, tool) in RUNNERS {
            if location.join(lockfile).is_file() {
                return Runner::Tool {
                    prefix: format!("{tool} run"),
                    interpreter: format!("{tool} run python"),
                };
            }
        }
        for venv in [".venv", "venv"] {
            if let Some(runner) = venv_runner(location, venv, at_root) {
                return runner;
            }
        }
    }
    let interpreter = if cfg!(windows) {
        if tool_on_path("py", &sink.vars) {
            "py -3"
        } else {
            "python"
        }
    } else {
        "python3"
    };
    Runner::Path(interpreter.to_owned())
}

/// A `.venv`/`venv` interpreter, called directly and named relative to the entry's
/// own cwd (`..\` when the environment is the worktree-root one).
fn venv_runner(location: &Path, venv: &str, at_root: bool) -> Option<Runner> {
    let separator = if cfg!(windows) { '\\' } else { '/' };
    let bin = if cfg!(windows) { "Scripts" } else { "bin" };
    let executable = if cfg!(windows) { "python.exe" } else { "python" };
    let directory = location.join(venv).join(bin);
    if !directory.join(executable).is_file() {
        return None;
    }
    let prefix = if at_root { ".." } else { "" };
    let relative = |tail: &str| {
        let mut path = String::new();
        if !prefix.is_empty() {
            path.push_str(prefix);
            path.push(separator);
        }
        path.push_str(venv);
        path.push(separator);
        path.push_str(bin);
        path.push(separator);
        path.push_str(tail);
        path
    };
    Some(Runner::Venv {
        interpreter: relative(executable),
        scripts: relative(""),
        directory,
    })
}

/// Console-script names are shell arguments, so only a strict charset is allowed.
fn script_argument(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|first| first.is_ascii_alphanumeric())
        && name.chars().count() <= 128
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
}

fn identifier(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
        && name.chars().count() <= 128
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Script names are collected in one set and bounded like the entry list: a 1 MiB
/// `[project.scripts]` table must not cost a quadratic scan, so the loop stops at
/// `MAX_ENTRIES` names or when the budget runs out.
fn script_names(document: &toml_edit::DocumentMut, budget: &mut Budget) -> Option<Vec<String>> {
    let mut names: Vec<String> = Vec::new();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    for path in [&["project", "scripts"][..], &["tool", "poetry", "scripts"][..]] {
        let Some(table) = table_at(document, path) else {
            continue;
        };
        for (name, _) in table.iter() {
            if budget.expired() {
                return None;
            }
            if names.len() >= MAX_ENTRIES {
                budget.truncated = true;
                break;
            }
            if !script_argument(name) {
                continue;
            }
            let name = name.to_owned();
            if seen.insert(name.clone()) {
                names.push(name);
            }
        }
    }
    Some(names)
}

fn table_at<'a>(
    document: &'a toml_edit::DocumentMut,
    path: &[&str],
) -> Option<&'a toml_edit::Table> {
    let (last, parents) = path.split_last()?;
    let mut table = document.as_table();
    for key in parents {
        table = table.get(key)?.as_table()?;
    }
    table.get(last)?.as_table()
}

fn script_command(runner: &Runner, name: &str) -> Option<String> {
    match runner {
        Runner::Tool { prefix, .. } => Some(format!("{prefix} {name}")),
        Runner::Venv {
            scripts,
            directory,
            ..
        } => {
            // Only a script the environment actually ships is runnable there.
            let candidates: &[&str] = if cfg!(windows) {
                &[".exe", ".bat", ".cmd"]
            } else {
                &[""]
            };
            for suffix in candidates {
                let file = format!("{name}{suffix}");
                if directory.join(&file).is_file() {
                    return Some(format!("{scripts}{file}"));
                }
            }
            None
        }
        // A globally installed command: its own PATH lookup reports a missing tool.
        Runner::Path(_) => Some(name.to_owned()),
    }
}

// ---------------------------------------------------------------- Django

fn detect_django(
    dir: &str,
    project: &Path,
    runner: &Runner,
    budget: &mut Budget,
    sink: &mut Sink,
    group: &str,
) {
    let manage = project.join("manage.py");
    if !manage.is_file() {
        return;
    }
    // A `manage.py` that never mentions Django is not a Django project.
    let Some(head) = read_head(&manage, HEAD_LIMIT) else {
        return;
    };
    if !head.to_lowercase().contains("django") {
        return;
    }
    let file = manifest_path(dir, "manage.py");
    for (name, kind) in [
        ("runserver", "service"),
        ("test", "task"),
        ("migrate", "task"),
    ] {
        if budget.expired() {
            return;
        }
        sink.push(
            budget,
            Candidate {
                kind: "python",
                file: file.clone(),
                name: name.to_owned(),
                key: format!("python:{file}:{name}"),
                command: format!("{} manage.py {name}", runner.interpreter()),
                cwd: dir.to_owned(),
                entry_kind: kind,
                group: group.to_owned(),
                suggested: false,
            },
        );
    }
}

// ---------------------------------------------------------------- pytest

fn detect_pytest(
    dir: &str,
    project: &Path,
    pyproject: Option<&toml_edit::DocumentMut>,
    runner: &Runner,
    budget: &mut Budget,
    sink: &mut Sink,
    group: &str,
) {
    let setup_cfg = read_text(&project.join("setup.cfg"));
    // The first trigger names the entry: the file a user can go and look at.
    let trigger = if project.join("pytest.ini").is_file() {
        Some("pytest.ini".to_owned())
    } else if pyproject.and_then(|document| table_at(document, &["tool", "pytest", "ini_options"])).is_some() {
        Some("pyproject.toml".to_owned())
    } else if setup_cfg
        .as_deref()
        .is_some_and(|text| text.lines().any(|line| line.trim() == "[tool:pytest]"))
    {
        Some("setup.cfg".to_owned())
    } else if project.join("conftest.py").is_file() {
        Some("conftest.py".to_owned())
    } else if project.join("tests").is_dir() {
        Some("tests".to_owned())
    } else {
        None
    };
    let Some(trigger) = trigger else {
        return;
    };
    if budget.expired() {
        return;
    }
    let file = manifest_path(dir, &trigger);
    sink.push(
        budget,
        Candidate {
            kind: "python",
            file: file.clone(),
            name: "pytest".into(),
            key: format!("python:{file}:pytest"),
            command: format!("{} -m pytest", runner.interpreter()),
            cwd: dir.to_owned(),
            entry_kind: "task",
            group: group.to_owned(),
            suggested: false,
        },
    );
}

// ---------------------------------------------------------------- FastAPI/Flask

fn detect_frameworks(
    dir: &str,
    project: &Path,
    runner: &Runner,
    budget: &mut Budget,
    sink: &mut Sink,
    group: &str,
) {
    for file in app_files(project, budget) {
        if budget.expired() {
            return;
        }
        let Some(head) = read_head(&project.join(&file), HEAD_LIMIT) else {
            continue;
        };
        let manifest = manifest_path(dir, &file);
        if let Some(variable) = app_factory(&head, "FastAPI(") {
            let (module, app_dir) = if let Some(rest) = file.strip_prefix("src/") {
                (rest.trim_end_matches(".py").replace('/', "."), true)
            } else {
                (file.trim_end_matches(".py").replace('/', "."), false)
            };
            let segments: Vec<&str> = module.split('.').collect();
            if segments.iter().all(|segment| identifier(segment)) {
                let mut command = format!(
                    "{} -m uvicorn {module}:{variable} --reload",
                    runner.interpreter()
                );
                if app_dir {
                    command.push_str(" --app-dir src");
                }
                sink.push(
                    budget,
                    Candidate {
                        kind: "python",
                        file: manifest.clone(),
                        name: "uvicorn".into(),
                        key: format!("python:{manifest}:uvicorn"),
                        command,
                        cwd: dir.to_owned(),
                        entry_kind: "service",
                        group: group.to_owned(),
                        suggested: true,
                    },
                );
            }
        }
        if let Some(variable) = app_factory(&head, "Flask(__name__)") {
            sink.push(
                budget,
                Candidate {
                    kind: "python",
                    file: manifest.clone(),
                    name: "flask".into(),
                    key: format!("python:{manifest}:flask"),
                    command: format!(
                        "{} -m flask --app {file}:{variable} run",
                        runner.interpreter()
                    ),
                    cwd: dir.to_owned(),
                    entry_kind: "service",
                    group: group.to_owned(),
                    suggested: true,
                },
            );
        }
    }
}

/// The candidate app modules: the usual files, then `src/*/main.py` for a src layout.
fn app_files(project: &Path, budget: &mut Budget) -> Vec<String> {
    let mut files: Vec<String> = APP_FILES
        .iter()
        .filter(|name| project.join(name).is_file())
        .map(|name| (*name).to_owned())
        .collect();
    for name in src_apps(project, budget) {
        files.push(format!("src/{name}/main.py"));
    }
    files
}

fn src_apps(project: &Path, budget: &mut Budget) -> Vec<String> {
    let Ok(read) = fs::read_dir(project.join("src")) else {
        return Vec::new();
    };
    let mut names: Vec<String> = Vec::new();
    for entry in read.filter_map(Result::ok) {
        if budget.expired() || names.len() >= MAX_SRC_DIRS {
            break;
        }
        if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !identifier(&name) || !entry.path().join("main.py").is_file() {
            continue;
        }
        names.push(name);
    }
    names.sort();
    names
}

/// `<var> = FastAPI(` / `<var> = Flask(__name__)` at the start of a line.
fn app_factory(text: &str, factory: &str) -> Option<String> {
    for line in text.lines() {
        let name: String = line
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
            .collect();
        if !identifier(&name) {
            continue;
        }
        let rest = line[name.len()..].trim_start();
        let Some(rest) = rest.strip_prefix('=') else {
            continue;
        };
        if rest.trim_start().starts_with(factory) {
            return Some(name);
        }
    }
    None
}

// ---------------------------------------------------------------- helpers

fn project_group(document: Option<&toml_edit::DocumentMut>, root: &Path, dir: &str) -> String {
    let name = document
        .and_then(|document| table_at(document, &["project"]))
        .and_then(|table| table.get("name"))
        .and_then(toml_edit::Item::as_str)
        .or_else(|| {
            document
                .and_then(|document| table_at(document, &["tool", "poetry"]))
                .and_then(|table| table.get("name"))
                .and_then(toml_edit::Item::as_str)
        })
        .map(str::trim)
        .filter(|name| !name.is_empty());
    name.map(str::to_owned)
        .unwrap_or_else(|| directory_label(root, dir))
}

/// The first 64 KiB of a file, which is all the framework scan and the Django
/// marker need; the whole file is never loaded for an app module.
fn read_head(path: &Path, limit: u64) -> Option<String> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    let mut buffer = Vec::new();
    fs::File::open(path)
        .ok()?
        .take(limit)
        .read_to_end(&mut buffer)
        .ok()?;
    Some(String::from_utf8_lossy(&buffer).into_owned())
}
