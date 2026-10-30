use super::*;
use std::{ffi::OsString, path::Path};

/// The production detector, but with a start far in the future so the 250 ms
/// wall-clock budget cannot truncate a fixture on a busy CI machine. The budget
/// itself is covered by an explicit `Budget` test.
fn detect_all(root: &Path) -> Detection {
    super::detect_with(
        root,
        Budget {
            started: Some(Instant::now() + Duration::from_secs(3600)),
            truncated: false,
        },
    )
}

fn write(root: &Path, relative: &str, text: &str) {
    let path = root.join(relative);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(path, text).unwrap();
}

fn keys(detection: &Detection) -> Vec<&str> {
    detection.entries.iter().map(|entry| entry.key.as_str()).collect()
}

fn find<'a>(detection: &'a Detection, key: &str) -> &'a DetectedRunEntry {
    detection
        .entries
        .iter()
        .find(|entry| entry.key == key)
        .unwrap_or_else(|| panic!("missing {key} in {:?}", keys(detection)))
}

fn distinct_tools(entries: &[DetectedRunEntry]) -> Vec<&str> {
    entries
        .iter()
        .filter_map(|entry| entry.missing_tool.as_deref())
        .collect()
}

#[test]
fn node_reads_scripts_workspaces_and_the_lockfile_manager() {
    for (lockfile, expected, expected_web) in [
        (None, "npm run dev", "npm run start:dev"),
        (Some("pnpm-lock.yaml"), "pnpm run dev", "pnpm run start:dev"),
        (Some("yarn.lock"), "yarn dev", "yarn start:dev"),
        (Some("bun.lockb"), "bun run dev", "bun run start:dev"),
        (Some("bun.lock"), "bun run dev", "bun run start:dev"),
    ] {
        let root = tempfile::tempdir().unwrap();
        write(
            root.path(),
            "package.json",
            r#"{"name":"root-pkg","workspaces":["packages/*"],"scripts":{
                "dev":"vite","predev":"echo pre","build":"tsc","prepare":"husky",
                "install":"echo i","postinstall":"echo p","preview":"vite preview","watch:css":"tailwind"}}"#,
        );
        write(
            root.path(),
            "packages/web/package.json",
            r#"{"name":"@acme/web","scripts":{"start:dev":"node x","test":"node --test"}}"#,
        );
        if let Some(lockfile) = lockfile {
            write(root.path(), lockfile, "");
        }
        let detection = detect_all(root.path());
        assert_eq!(find(&detection, "node:package.json:dev").command, expected);
        assert_eq!(find(&detection, "node:package.json:dev").kind, "service");
        assert_eq!(find(&detection, "node:package.json:dev").cwd, "");
        assert_eq!(find(&detection, "node:package.json:dev").group, "root-pkg");
        assert_eq!(find(&detection, "node:package.json:build").kind, "task");
        assert_eq!(find(&detection, "node:package.json:preview").kind, "service");
        assert_eq!(find(&detection, "node:package.json:watch:css").kind, "service");
        let web = find(&detection, "node:packages/web/package.json:start:dev");
        assert_eq!(web.cwd, "packages/web");
        assert_eq!(web.group, "@acme/web");
        assert_eq!(web.source.kind, "node");
        assert_eq!(web.source.file, "packages/web/package.json");
        assert_eq!(web.source.label, "package.json");
        assert_eq!(web.command, expected_web);
        // Lifecycle hooks repeat the script they wrap; `preview` is a real script.
        for skipped in [
            "node:package.json:predev",
            "node:package.json:prepare",
            "node:package.json:install",
            "node:package.json:postinstall",
        ] {
            assert!(!keys(&detection).contains(&skipped), "{skipped}");
        }
    }
}

#[test]
fn node_reads_workspaces_from_pnpm_workspace_yaml_and_skips_vendored_directories() {
    let root = tempfile::tempdir().unwrap();
    write(root.path(), "package.json", r#"{"name":"root","scripts":{"build":"tsc"}}"#);
    write(
        root.path(),
        "pnpm-workspace.yaml",
        "# packages\npackages:\n  - 'apps/*'\n  - \"tools/**\"\n\ncatalog:\n  react: 19\n",
    );
    write(root.path(), "apps/api/package.json", r#"{"name":"api","scripts":{"serve":"node ."}}"#);
    write(root.path(), "tools/cli/package.json", r#"{"name":"cli","scripts":{"build":"tsc"}}"#);
    write(root.path(), "tools/deep/er/package.json", r#"{"name":"deep","scripts":{"build":"tsc"}}"#);
    write(root.path(), "node_modules/dep/package.json", r#"{"name":"dep","scripts":{"build":"x"}}"#);
    write(root.path(), "apps/.hidden/package.json", r#"{"name":"hidden","scripts":{"build":"x"}}"#);
    write(root.path(), "apps/target/package.json", r#"{"name":"targeted","scripts":{"build":"x"}}"#);
    let detection = detect_all(root.path());
    assert!(keys(&detection).contains(&"node:apps/api/package.json:serve"));
    assert!(keys(&detection).contains(&"node:tools/cli/package.json:build"));
    assert!(!keys(&detection).contains(&"node:tools/deep/er/package.json:build"));
    assert!(keys(&detection).iter().all(|key| !key.contains("node_modules")));
    assert!(keys(&detection).iter().all(|key| !key.contains(".hidden")));
    assert!(keys(&detection).iter().all(|key| !key.contains("/target/")));
}

#[test]
fn cargo_expands_members_honours_exclude_and_classifies_web_services() {
    let root = tempfile::tempdir().unwrap();
    write(
        root.path(),
        "Cargo.toml",
        "[workspace]\nmembers = [\"crates/*\"]\nexclude = [\"crates/legacy\"]\nresolver = \"2\"\n",
    );
    write(
        root.path(),
        "crates/api/Cargo.toml",
        "[package]\nname = \"api\"\nversion = \"0.1.0\"\n\n[dependencies]\naxum = \"0.7\"\n\n[[bin]]\nname = \"server\"\npath = \"src/server.rs\"\n",
    );
    write(root.path(), "crates/api/src/main.rs", "fn main() {}");
    write(root.path(), "crates/api/src/bin/seed.rs", "fn main() {}");
    write(root.path(), "crates/api/src/bin/tool.rs", "fn main() {}");
    write(
        root.path(),
        "crates/lib/Cargo.toml",
        "[package]\nname = \"acme-lib\"\nversion = \"0.1.0\"\n\n[dev-dependencies]\nwarp = \"0.3\"\n",
    );
    write(root.path(), "crates/lib/src/lib.rs", "");
    write(root.path(), "crates/lib/src/main.rs", "fn main() {}");
    write(
        root.path(),
        "crates/legacy/Cargo.toml",
        "[package]\nname = \"legacy\"\nversion = \"0.1.0\"\n",
    );
    write(root.path(), "crates/legacy/src/main.rs", "fn main() {}");
    let detection = detect_all(root.path());
    let server = find(&detection, "cargo:crates/api:run:server");
    assert_eq!(server.command, "cargo run -p api --bin server");
    assert_eq!(server.kind, "service");
    assert_eq!(server.cwd, "crates/api");
    assert_eq!(server.group, "api");
    assert_eq!(server.source.file, "crates/api/Cargo.toml");
    // src/main.rs becomes the package's own bin, plus every src/bin/*.rs stem.
    for binary in ["api", "seed", "tool"] {
        assert!(keys(&detection).contains(&format!("cargo:crates/api:run:{binary}").as_str()));
    }
    assert_eq!(find(&detection, "cargo:crates/api:test").command, "cargo test -p api");
    assert_eq!(find(&detection, "cargo:crates/api:test").kind, "task");
    assert_eq!(find(&detection, "cargo:crates/lib:run:acme-lib").kind, "service");
    assert!(!keys(&detection).iter().any(|key| key.contains("legacy")));
    assert_eq!(find(&detection, "cargo:workspace:test").command, "cargo test");
    assert_eq!(find(&detection, "cargo:workspace:test").group, "workspace");
    assert_eq!(find(&detection, "cargo:workspace:build").cwd, "");
}

#[test]
fn cargo_single_package_root_drops_the_package_flag() {
    let root = tempfile::tempdir().unwrap();
    write(
        root.path(),
        "Cargo.toml",
        "[package]\nname = \"solo\"\nversion = \"0.1.0\"\n",
    );
    write(root.path(), "src/main.rs", "fn main() {}");
    let detection = detect_all(root.path());
    assert_eq!(find(&detection, "cargo:run:solo").command, "cargo run --bin solo");
    assert_eq!(find(&detection, "cargo:run:solo").kind, "task");
    assert_eq!(find(&detection, "cargo:test").command, "cargo test");
    assert_eq!(find(&detection, "cargo:build").command, "cargo build");
    assert!(!keys(&detection).contains(&"cargo:workspace:test"));
}

#[test]
fn makefile_skips_variables_special_targets_and_pattern_rules() {
    let root = tempfile::tempdir().unwrap();
    write(
        root.path(),
        "Makefile",
        "VAR := value\nOTHER ?= x\n.PHONY: build test\nall: build\nbuild: main.o\n\tcc -o app main.o\n%.o: %.c\n\tcc -c $<\nrun-server: build\n\techo go\n\t@echo hidden\n",
    );
    let detection = detect_all(root.path());
    let found = keys(&detection);
    assert!(found.contains(&"make:Makefile:all"));
    assert!(found.contains(&"make:Makefile:build"));
    assert!(found.contains(&"make:Makefile:run-server"));
    for skipped in [
        "make:Makefile:VAR",
        "make:Makefile:OTHER",
        "make:Makefile:.PHONY",
        "make:Makefile:%",
    ] {
        assert!(!found.contains(&skipped), "{skipped}");
    }
    let build = find(&detection, "make:Makefile:build");
    assert_eq!(build.command, "make build");
    assert_eq!(build.kind, "task");
    assert_eq!(build.source.label, "Makefile");
    assert_eq!(build.group, "Makefile");
}

#[test]
fn justfile_reads_recipe_headers_only() {
    let root = tempfile::tempdir().unwrap();
    write(
        root.path(),
        "justfile",
        "set shell := [\"bash\", \"-c\"]\nalias b := build\nimport \"other.just\"\nmod sub\n\n# comment\nbuild:\n\techo build\nbuild target filter=\"*\": build\n_hidden:\n\techo hidden\ntest *ARGS: build\n",
    );
    let detection = detect_all(root.path());
    let found = keys(&detection);
    // `build` appears twice; the second line has parameters that are stripped.
    assert_eq!(found.iter().filter(|key| **key == "just:justfile:build").count(), 1);
    assert!(found.contains(&"just:justfile:test"));
    for skipped in ["just:justfile:set", "just:justfile:alias", "just:justfile:import", "just:justfile:mod", "just:justfile:_hidden"] {
        assert!(!found.contains(&skipped), "{skipped}");
    }
    let test = find(&detection, "just:justfile:test");
    assert_eq!(test.command, "just test");
    assert_eq!(test.kind, "task");
}

#[test]
fn compose_reads_top_level_services_with_comments_quotes_and_nesting() {
    let root = tempfile::tempdir().unwrap();
    write(
        root.path(),
        "compose.yaml",
        "# stack\nname: demo\nservices:\n  db:\n    image: postgres:16 # comment\n    environment:\n      POSTGRES_PASSWORD: secret\n  \"api-v2\":\n    build: .\n    depends_on:\n      - db\n  web: {image: nginx}\nvolumes:\n  data:\n",
    );
    let detection = detect_all(root.path());
    let found = keys(&detection);
    assert!(found.contains(&"compose:compose.yaml:db"));
    assert!(found.contains(&"compose:compose.yaml:api-v2"));
    assert!(found.contains(&"compose:compose.yaml:web"));
    assert!(!found.iter().any(|key| key.contains("volumes")));
    let db = find(&detection, "compose:compose.yaml:db");
    assert_eq!(db.command, "docker compose up db");
    assert_eq!(db.kind, "service");
    assert_eq!(db.source.label, "compose.yaml");
}

#[test]
fn compose_prefers_the_first_known_file_and_ignores_malformed_input() {
    let root = tempfile::tempdir().unwrap();
    write(root.path(), "docker-compose.yml", "services:\n  later:\n    image: x\n");
    write(root.path(), "compose.yaml", "services:\n  early:\n    image: x\n");
    let detection = detect_all(root.path());
    assert!(keys(&detection).contains(&"compose:compose.yaml:early"));
    assert!(!keys(&detection).iter().any(|key| key.contains("later")));
    let malformed = tempfile::tempdir().unwrap();
    write(malformed.path(), "compose.yaml", "services: [\n  broken\n");
    assert!(detect_all(malformed.path()).entries.is_empty());
    let broken = tempfile::tempdir().unwrap();
    write(broken.path(), "compose.yaml", "services:\n\tdb:\n    image: x\n");
    assert!(detect_all(broken.path()).entries.is_empty());
}

#[test]
fn procfile_keeps_the_command_text() {
    let root = tempfile::tempdir().unwrap();
    write(
        root.path(),
        "Procfile",
        "# comment\nweb: node server.js --port 5000\nworker:  python -m jobs.run\ninvalid name: node x\n",
    );
    let detection = detect_all(root.path());
    let web = find(&detection, "procfile:Procfile:web");
    assert_eq!(web.command, "node server.js --port 5000");
    assert_eq!(web.kind, "service");
    assert!(keys(&detection).contains(&"procfile:Procfile:worker"));
    assert!(!keys(&detection).iter().any(|key| key.contains("invalid")));
}

#[test]
fn caps_report_truncation_and_stop_at_two_hundred_entries() {
    let root = tempfile::tempdir().unwrap();
    let mut scripts = serde_json::Map::new();
    for index in 0..250 {
        scripts.insert(format!("task{index:03}"), serde_json::Value::from("x"));
    }
    write(
        root.path(),
        "package.json",
        &serde_json::json!({"name":"big","scripts":scripts}).to_string(),
    );
    let detection = detect_all(root.path());
    assert_eq!(detection.entries.len(), MAX_ENTRIES);
    assert!(detection.truncated);
}

#[test]
fn keys_are_deterministic_and_readable() {
    let root = tempfile::tempdir().unwrap();
    write(root.path(), "package.json", r#"{"name":"app","workspaces":["packages/*"],"scripts":{"dev":"vite","build":"tsc"}}"#);
    write(root.path(), "packages/web/package.json", r#"{"name":"web","scripts":{"dev":"vite"}}"#);
    write(root.path(), "Makefile", "build:\n\techo\n");
    write(root.path(), "Procfile", "web: node server.js\n");
    let first = detect_all(root.path());
    let second = detect_all(root.path());
    assert_eq!(keys(&first), keys(&second));
    let keys = keys(&first);
    for expected in [
        "node:package.json:dev",
        "node:packages/web/package.json:dev",
        "make:Makefile:build",
        "procfile:Procfile:web",
    ] {
        assert!(keys.contains(&expected), "{expected}: {keys:?}");
    }
}

#[test]
fn tool_lookup_uses_the_injected_path_and_pathext() {
    let root = tempfile::tempdir().unwrap();
    let bin = root.path().join("bin");
    fs::create_dir(&bin).unwrap();
    let executable = if cfg!(windows) { "mytool.CMD" } else { "mytool" };
    fs::write(bin.join(executable), "").unwrap();
    let vars: Vec<(OsString, OsString)> = vec![
        ("Path".into(), bin.as_os_str().to_owned()),
        ("PATHEXT".into(), ".COM;.EXE;.BAT;.CMD".into()),
    ];
    assert!(tool_available("mytool", &vars, root.path()));
    assert!(!tool_available("absent-tool", &vars, root.path()));
    // Nothing is executed: the lookup is a file existence test only.
    assert!(tool_available("C:\\tools\\explicit.exe", &vars, root.path()));
    assert!(tool_available("--flag", &vars, root.path()));
    assert!(!tool_available("mytool", &[], root.path()));
}

#[test]
fn tool_lookup_finds_an_executable_in_the_entry_cwd() {
    let root = tempfile::tempdir().unwrap();
    let executable = if cfg!(windows) { "tt-qa-local-tool.CMD" } else { "tt-qa-local-tool" };
    fs::write(root.path().join(executable), "").unwrap();
    write(root.path(), "Procfile", "web: tt-qa-local-tool --serve\n");
    let detection = detect_all(root.path());
    // cmd.exe searches the current directory before PATH, and the entry runs there.
    assert_eq!(find(&detection, "procfile:Procfile:web").missing_tool, None);
    assert!(tool_available("tt-qa-local-tool", &[], root.path()));
    assert!(!tool_available("tt-qa-local-tool", &[], &root.path().join("elsewhere")));
}

#[test]
fn detected_entries_report_missing_tools_without_running_anything() {
    let root = tempfile::tempdir().unwrap();
    write(root.path(), "Procfile", "web: tt-qa-definitely-missing-tool --serve\n");
    let detection = detect_all(root.path());
    assert_eq!(
        find(&detection, "procfile:Procfile:web").missing_tool.as_deref(),
        Some("tt-qa-definitely-missing-tool")
    );
    assert!(distinct_tools(&detection.entries)
        .iter()
        .all(|tool| *tool == "tt-qa-definitely-missing-tool"));
}

#[test]
fn unreadable_and_oversized_manifests_yield_no_entries() {
    let root = tempfile::tempdir().unwrap();
    write(root.path(), "package.json", "{}");
    let oversized = "x".repeat(MANIFEST_LIMIT as usize + 1);
    fs::write(root.path().join("package.json"), oversized).unwrap();
    assert!(detect_all(root.path()).entries.is_empty());
    let malformed = tempfile::tempdir().unwrap();
    write(malformed.path(), "package.json", "not json");
    write(malformed.path(), "Cargo.toml", "[[[");
    assert!(detect_all(malformed.path()).entries.is_empty());
}

/// Names that would break out of the command text if they were interpolated.
const HOSTILE_TOKENS: [&str; 7] = ["dev & calc", "x\" & calc & \"", "a|b", "%PATH%", "^", "!", "two words"];
const METACHARACTERS: [char; 15] = ['&', '|', '<', '>', '^', '%', '!', '"', '\'', '(', ')', ';', '\r', '\n', '\0'];

fn assert_no_metacharacters(detection: &Detection) {
    for entry in &detection.entries {
        assert!(
            !entry.command.chars().any(|c| METACHARACTERS.contains(&c)),
            "hostile command: {:?} ({})",
            entry.command,
            entry.key
        );
    }
}

#[test]
fn node_rejects_hostile_script_names() {
    let root = tempfile::tempdir().unwrap();
    let mut scripts = serde_json::Map::new();
    for name in HOSTILE_TOKENS {
        scripts.insert(name.to_owned(), serde_json::Value::from("vite"));
    }
    scripts.insert("dev\ncalc".into(), serde_json::Value::from("vite"));
    write(
        root.path(),
        "package.json",
        &serde_json::json!({"name":"hostile","scripts":scripts}).to_string(),
    );
    let detection = detect_all(root.path());
    assert!(detection.entries.is_empty(), "{:?}", keys(&detection));
    assert_no_metacharacters(&detection);
}

#[test]
fn make_just_compose_and_procfile_reject_hostile_names() {
    for token in HOSTILE_TOKENS {
        let make = tempfile::tempdir().unwrap();
        write(make.path(), "Makefile", &format!("{token}:\n\t@echo x\n"));
        assert!(detect_all(make.path()).entries.is_empty(), "make: {token}");

        let compose = tempfile::tempdir().unwrap();
        write(
            compose.path(),
            "compose.yaml",
            &format!("services:\n  {token}:\n    image: x\n"),
        );
        assert!(detect_all(compose.path()).entries.is_empty(), "compose: {token}");

        let procfile = tempfile::tempdir().unwrap();
        write(procfile.path(), "Procfile", &format!("{token}: node x\n"));
        assert!(detect_all(procfile.path()).entries.is_empty(), "procfile: {token}");
    }
    // Justfile recipe names are a single token; hostile tokens with spaces leave
    // only a safe first token behind.
    for token in ["a|b", "%PATH%", "^", "!", "x\"", "dev&calc", "a;b"] {
        let just = tempfile::tempdir().unwrap();
        write(just.path(), "justfile", &format!("{token}:\n\techo x\n"));
        let detection = detect_all(just.path());
        assert!(detection.entries.is_empty(), "just: {token} -> {:?}", keys(&detection));
    }
    let spaced = tempfile::tempdir().unwrap();
    write(spaced.path(), "justfile", "dev & calc:\n\techo x\n");
    let detection = detect_all(spaced.path());
    assert_eq!(keys(&detection), vec!["just:justfile:dev"]);
    assert_no_metacharacters(&detection);
}

#[test]
fn cargo_rejects_hostile_package_and_bin_names() {
    for token in HOSTILE_TOKENS {
        let root = tempfile::tempdir().unwrap();
        let quoted = serde_json::to_string(token).unwrap();
        write(
            root.path(),
            "Cargo.toml",
            &format!("[package]\nname = {quoted}\nversion = \"0.1.0\"\n"),
        );
        write(root.path(), "src/main.rs", "fn main() {}");
        let detection = detect_all(root.path());
        assert!(detection.entries.is_empty(), "package: {token} -> {:?}", keys(&detection));
    }
    // A TOML basic string may encode a newline, which must not reach a cmd line.
    let newline = tempfile::tempdir().unwrap();
    write(
        newline.path(),
        "Cargo.toml",
        "[package]\nname = \"dev\\ncalc\"\nversion = \"0.1.0\"\n",
    );
    write(newline.path(), "src/main.rs", "fn main() {}");
    assert!(detect_all(newline.path()).entries.is_empty());

    // [[bin]] names and src/bin file stems are interpolated too.
    for token in HOSTILE_TOKENS {
        let root = tempfile::tempdir().unwrap();
        write(
            root.path(),
            "Cargo.toml",
            &format!(
                "[package]\nname = \"demo\"\nversion = \"0.1.0\"\n\n[[bin]]\nname = {}\npath = \"src/main.rs\"\n",
                serde_json::to_string(token).unwrap()
            ),
        );
        let detection = detect_all(root.path());
        assert!(
            !keys(&detection).iter().any(|key| key.contains(":run:")),
            "bin: {token} -> {:?}",
            keys(&detection)
        );
        assert_no_metacharacters(&detection);
    }
    for stem in ["a&calc", "%PATH%", "^calc", "!calc", "a b"] {
        let root = tempfile::tempdir().unwrap();
        write(
            root.path(),
            "Cargo.toml",
            "[package]\nname = \"demo\"\nversion = \"0.1.0\"\n",
        );
        write(root.path(), "src/lib.rs", "");
        write(root.path(), &format!("src/bin/{stem}.rs"), "fn main() {}");
        let detection = detect_all(root.path());
        assert!(
            !keys(&detection).iter().any(|key| key.contains(":run:")),
            "src/bin stem: {stem} -> {:?}",
            keys(&detection)
        );
        assert_no_metacharacters(&detection);
    }
}

#[test]
fn unsafe_commands_are_never_detected() {
    assert!(command_is_safe("echo ok", "cmd"));
    assert!(!command_is_safe("echo a\0b", "cmd"));
    assert!(!command_is_safe(&"x".repeat(8001), "cmd"));
    assert!(command_is_safe(&"x".repeat(8000), "cmd"));
    assert!(!command_is_safe("echo a\necho b", "cmd"));
    assert!(command_is_safe("echo a\necho b", "powershell"));

    for command in ["node --x\0--y".to_owned(), "x".repeat(8001)] {
        let root = tempfile::tempdir().unwrap();
        write(root.path(), "Procfile", &format!("web: {command}\n"));
        let detection = detect_all(root.path());
        assert!(
            !keys(&detection).iter().any(|key| key.starts_with("procfile:")),
            "unsafe Procfile command was listed"
        );
    }
}

#[test]
fn unaddressable_keys_and_names_are_skipped() {
    // `quickLaunch.run` caps the key at 512 units and `quickLaunch.save` the name at 80 characters.
    let long_name = "n".repeat(81);
    let root = tempfile::tempdir().unwrap();
    write(root.path(), "Procfile", &format!("{long_name}: node x\n"));
    let detection = detect_all(root.path());
    assert!(detection.entries.is_empty());
    assert!(detection.truncated);

    let mut budget = Budget::default();
    let mut sink = Sink::with_vars(root.path(), None);
    let candidate = |key: String, name: String| Candidate {
        kind: "procfile",
        file: "Procfile".into(),
        name,
        command: "echo ok".into(),
        cwd: String::new(),
        entry_kind: "service",
        group: "Procfile".into(),
        key,
        suggested: false,
    };
    sink.push(&mut budget, candidate("x".repeat(513), "short".into()));
    assert!(sink.entries.is_empty(), "a key over 512 units is never listed");
    assert!(budget.truncated);
    sink.push(&mut budget, candidate("procfile:Procfile:ok".into(), long_name));
    assert!(sink.entries.is_empty(), "a name over 80 characters is never listed");
    sink.push(&mut budget, candidate("procfile:Procfile:ok".into(), "ok".into()));
    assert_eq!(sink.entries.len(), 1);
}

#[test]
fn workspace_negation_patterns_exclude_packages() {
    let root = tempfile::tempdir().unwrap();
    write(
        root.path(),
        "package.json",
        r#"{"name":"root","workspaces":["packages/*","!packages/legacy"],"scripts":{"build":"tsc"}}"#,
    );
    write(root.path(), "packages/web/package.json", r#"{"name":"web","scripts":{"dev":"vite"}}"#);
    write(root.path(), "packages/legacy/package.json", r#"{"name":"legacy","scripts":{"dev":"vite"}}"#);
    write(root.path(), "pnpm-workspace.yaml", "packages:\n  - 'apps/*'\n  - '!apps/legacy'\n");
    write(root.path(), "apps/api/package.json", r#"{"name":"api","scripts":{"dev":"node ."}}"#);
    write(root.path(), "apps/legacy/package.json", r#"{"name":"old-api","scripts":{"dev":"node ."}}"#);
    let detection = detect_all(root.path());
    let found = keys(&detection);
    assert!(found.contains(&"node:packages/web/package.json:dev"));
    assert!(found.contains(&"node:apps/api/package.json:dev"));
    assert!(!found.iter().any(|key| key.contains("legacy")), "{found:?}");
}

#[test]
fn literal_workspace_paths_are_filtered_like_globs() {
    let root = tempfile::tempdir().unwrap();
    write(
        root.path(),
        "Cargo.toml",
        "[workspace]\nmembers = [\"crates/api\", \"node_modules/pkg\", \"not-a-directory\"]\n",
    );
    write(root.path(), "crates/api/Cargo.toml", "[package]\nname = \"api\"\nversion = \"0.1.0\"\n");
    write(root.path(), "crates/api/src/main.rs", "fn main() {}");
    write(root.path(), "node_modules/pkg/Cargo.toml", "[package]\nname = \"planted\"\nversion = \"0.1.0\"\n");
    write(root.path(), "node_modules/pkg/src/main.rs", "fn main() {}");
    write(root.path(), "not-a-directory", "");
    let detection = detect_all(root.path());
    let found = keys(&detection);
    assert!(found.contains(&"cargo:crates/api:test"));
    assert!(!found.iter().any(|key| key.contains("planted")), "{found:?}");
    assert!(!found.iter().any(|key| key.contains("missing")));

    // A junction is not a way to read a manifest outside the worktree.
    #[cfg(windows)]
    {
        let outside = tempfile::tempdir().unwrap();
        write(outside.path(), "Cargo.toml", "[package]\nname = \"outside\"\nversion = \"0.1.0\"\n");
        write(outside.path(), "src/main.rs", "fn main() {}");
        let root = tempfile::tempdir().unwrap();
        use std::os::windows::process::CommandExt;
        write(root.path(), "Cargo.toml", "[workspace]\nmembers = [\"linked\"]\n");
        let junction = root.path().join("linked");
        let payload = format!(r#""mklink /J "{}" "{}"""#, junction.display(), outside.path().display());
        let status = std::process::Command::new("cmd.exe")
            .creation_flags(0x08000000)
            .args(["/D", "/S", "/C"])
            .raw_arg(payload)
            .status()
            .unwrap();
        assert!(status.success());
        let detection = detect_all(root.path());
        assert!(
            !keys(&detection).iter().any(|key| key.contains("outside")),
            "{:?}",
            keys(&detection)
        );
    }
}

#[test]
fn glob_depth_member_cap_and_budget_stop_expansion() {
    let root = tempfile::tempdir().unwrap();
    for dir in ["a/one", "a/b/two", "c"] {
        fs::create_dir_all(root.path().join(dir)).unwrap();
    }
    let mut budget = Budget::default();
    let mut top = expand_pattern(root.path(), "a/*", &mut budget);
    top.sort();
    assert_eq!(top, vec!["a/b".to_owned(), "a/one".to_owned()]);
    assert!(!budget.truncated);
    // `a/b/*` is a third segment: refused, and reported as truncation.
    assert!(expand_pattern(root.path(), "a/b/*", &mut budget).is_empty());
    assert!(budget.truncated);
    // A wildcard that is not the last segment is not expanded at all.
    let mut other = Budget::default();
    assert!(expand_pattern(root.path(), "a/*/x", &mut other).is_empty());

    // At most 64 workspace members are read; more are reported as truncated.
    let big = tempfile::tempdir().unwrap();
    let mut members = Vec::new();
    for index in 0..70 {
        members.push(format!("\"crates/m{index}\""));
        write(
            big.path(),
            &format!("crates/m{index}/Cargo.toml"),
            &format!("[package]\nname = \"m{index}\"\nversion = \"0.1.0\"\n"),
        );
        write(big.path(), &format!("crates/m{index}/src/main.rs"), "fn main() {}");
    }
    write(
        big.path(),
        "Cargo.toml",
        &format!("[workspace]\nmembers = [{}]\n", members.join(", ")),
    );
    let detection = detect_all(big.path());
    let tests = keys(&detection).iter().filter(|key| key.starts_with("cargo:crates/") && key.ends_with(":test")).count();
    assert_eq!(tests, MAX_MEMBERS, "the member cap bounds the scan: {:?}", keys(&detection));
    assert!(detection.truncated);

    // An expired budget stops new entries instead of listing a partial row.
    let mut expired = Budget {
        started: Some(Instant::now() - BUDGET - Duration::from_millis(1)),
        truncated: false,
    };
    assert!(expired.expired());
    let mut sink = Sink::with_vars(root.path(), None);
    sink.push(
        &mut expired,
        Candidate {
            kind: "procfile",
            file: "Procfile".into(),
            name: "web".into(),
            command: "echo ok".into(),
            cwd: String::new(),
            entry_kind: "service",
            group: "Procfile".into(),
            key: "procfile:Procfile:web".into(),
            suggested: false,
        },
    );
    assert!(sink.entries.is_empty());
    assert!(expired.truncated);
}

#[test]
fn production_detect_reports_entries_with_the_default_budget() {
    let root = tempfile::tempdir().unwrap();
    write(root.path(), "Procfile", "web: node server.js\n");
    let detection = detect(root.path());
    assert_eq!(keys(&detection), vec!["procfile:Procfile:web"]);
    assert!(!detection.truncated);
}
// ---------------------------------------------------------------- Maven, Gradle, Python

/// Detection with an injected PATH/PATHEXT: a fixture must never depend on which
/// build tools or interpreters the machine happens to have installed.
fn detect_env(root: &Path, vars: Vec<(OsString, OsString)>) -> Detection {
    super::detect_with_env(
        root,
        Budget {
            started: Some(Instant::now() + Duration::from_secs(3600)),
            truncated: false,
        },
        Some(vars),
    )
}

/// Nothing is on PATH: no `py`, `python`, `uv`, `mvn` or `gradle`.
fn no_tools() -> Vec<(OsString, OsString)> {
    vec![
        ("Path".into(), OsString::new()),
        ("PATHEXT".into(), ".COM;.EXE;.BAT;.CMD".into()),
    ]
}

fn tool_env(bin: &Path) -> Vec<(OsString, OsString)> {
    vec![
        ("Path".into(), bin.as_os_str().to_owned()),
        ("PATHEXT".into(), ".COM;.EXE;.BAT;.CMD".into()),
    ]
}

/// The PATH fallback interpreter, decided by the platform, never by this machine.
fn python_interpreter() -> &'static str {
    if cfg!(windows) {
        "python"
    } else {
        "python3"
    }
}

fn venv_interpreter(at_root: bool, venv: &str) -> String {
    if cfg!(windows) {
        format!(
            "{}{venv}\\Scripts\\python.exe",
            if at_root { "..\\" } else { "" }
        )
    } else {
        format!(
            "{}{venv}/bin/python",
            if at_root { "../" } else { "" }
        )
    }
}

const SPRING_BOOT_POM: &str = "<project><artifactId>demo</artifactId><build><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>";

#[test]
fn maven_reads_single_module_goals_and_prefers_the_wrapper() {
    let root = tempfile::tempdir().unwrap();
    write(root.path(), "pom.xml", SPRING_BOOT_POM);
    // Both wrappers exist so the platform-specific spelling is what decides.
    write(root.path(), "mvnw", "");
    write(root.path(), "mvnw.cmd", "");
    let wrapper = if cfg!(windows) { r".\mvnw.cmd" } else { "./mvnw" };
    let detection = detect_env(root.path(), no_tools());
    let run = find(&detection, "maven:pom.xml:spring-boot:run");
    assert_eq!(run.command, format!("{wrapper} spring-boot:run"));
    assert_eq!(run.kind, "service");
    assert_eq!(run.group, "demo");
    assert_eq!(run.cwd, "");
    assert_eq!(run.source.kind, "maven");
    assert_eq!(run.source.file, "pom.xml");
    assert_eq!(run.source.label, "pom.xml");
    assert!(!run.suggested);
    assert_eq!(find(&detection, "maven:pom.xml:test").command, format!("{wrapper} test"));
    assert_eq!(find(&detection, "maven:pom.xml:test").kind, "task");
    assert_eq!(find(&detection, "maven:pom.xml:package").command, format!("{wrapper} package"));
}

#[test]
fn maven_requires_the_spring_boot_plugin_outside_plugin_management() {
    // No plugin at all: no service, only the two tasks.
    let plain = tempfile::tempdir().unwrap();
    write(plain.path(), "pom.xml", "<project><artifactId>plain</artifactId></project>");
    let detection = detect_env(plain.path(), no_tools());
    assert!(!keys(&detection).contains(&"maven:pom.xml:spring-boot:run"));
    assert!(keys(&detection).contains(&"maven:pom.xml:test"));

    // A version declared under pluginManagement is not a build plugin.
    let managed = tempfile::tempdir().unwrap();
    write(
        managed.path(),
        "pom.xml",
        "<project><artifactId>managed</artifactId><build><pluginManagement><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId><version>3.2.0</version></plugin></plugins></pluginManagement></build></project>",
    );
    assert!(!keys(&detect_env(managed.path(), no_tools())).contains(&"maven:pom.xml:spring-boot:run"));

    // A pom-packaging aggregator has nothing to boot either.
    let aggregator = tempfile::tempdir().unwrap();
    write(
        aggregator.path(),
        "pom.xml",
        "<project><artifactId>all</artifactId><packaging>pom</packaging><build><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>",
    );
    assert!(!keys(&detect_env(aggregator.path(), no_tools())).contains(&"maven:pom.xml:spring-boot:run"));
}

#[test]
fn maven_reactor_groups_modules_and_follows_nested_modules() {
    let root = tempfile::tempdir().unwrap();
    write(
        root.path(),
        "pom.xml",
        "<project><artifactId>demo</artifactId><modules><module>services</module><module>apps</module></modules></project>",
    );
    write(
        root.path(),
        "services/pom.xml",
        "<project><artifactId>services</artifactId><modules><module>api</module></modules></project>",
    );
    write(
        root.path(),
        "services/api/pom.xml",
        "<project><artifactId>api</artifactId><build><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>",
    );
    write(root.path(), "apps/pom.xml", "<project><artifactId>apps</artifactId></project>");
    let detection = detect_env(root.path(), no_tools());
    assert_eq!(find(&detection, "maven:pom.xml:test").command, "mvn test");
    assert_eq!(find(&detection, "maven:pom.xml:package").group, "demo");
    assert!(!keys(&detection).contains(&"maven:pom.xml:spring-boot:run"), "the reactor itself is not runnable");
    assert_eq!(find(&detection, "maven:services/pom.xml:test").group, "services");
    let api = find(&detection, "maven:services/api/pom.xml:spring-boot:run");
    assert_eq!(api.command, "mvn -pl services/api spring-boot:run");
    assert_eq!(api.kind, "service");
    assert_eq!(api.cwd, "");
    assert_eq!(api.group, "api");
    assert_eq!(api.source.file, "services/api/pom.xml");
    assert_eq!(find(&detection, "maven:services/api/pom.xml:test").command, "mvn -pl services/api test");
    assert_eq!(find(&detection, "maven:apps/pom.xml:test").group, "apps");
    assert!(!keys(&detection).contains(&"maven:apps/pom.xml:spring-boot:run"));
}

#[test]
fn maven_parses_comments_cdata_and_rejects_malformed_xml() {
    let root = tempfile::tempdir().unwrap();
    write(
        root.path(),
        "pom.xml",
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!-- <modules><module>gone</module></modules> -->\n<project>\n  <artifactId>real</artifactId>\n  <description><![CDATA[ <artifactId>fake</artifactId> ]]></description>\n  <build><plugins><!-- <plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin> --></plugins></build>\n</project>\n",
    );
    let detection = detect_env(root.path(), no_tools());
    assert_eq!(find(&detection, "maven:pom.xml:test").group, "real");
    assert!(!keys(&detection).contains(&"maven:pom.xml:spring-boot:run"), "a commented plugin does not count");
    assert!(!keys(&detection).iter().any(|key| key.contains("gone") || key.contains("fake")));

    for broken in [
        "<project><artifactId>a</project>",
        "<project><artifactId>a</artifactId>",
        "not xml at all",
        "<project><artifactId>a</artifactId></project><project/>",
        "<project><artifactId>a</artifactId></projekt>",
    ] {
        let root = tempfile::tempdir().unwrap();
        write(root.path(), "pom.xml", broken);
        assert!(detect_env(root.path(), no_tools()).entries.is_empty(), "{broken}");
    }
}

#[test]
fn maven_skips_modules_that_escape_the_root_and_hostile_names() {
    let outside = tempfile::tempdir().unwrap();
    write(outside.path(), "pom.xml", SPRING_BOOT_POM);
    let root = tempfile::tempdir().unwrap();
    write(
        root.path(),
        "pom.xml",
        "<project><artifactId>demo</artifactId><modules><module>../escape</module><module>/absolute</module><module>missing</module><module>a&amp;b</module></modules></project>",
    );
    let detection = detect_env(root.path(), no_tools());
    assert_eq!(
        keys(&detection).iter().filter(|key| key.ends_with(":test")).count(),
        1,
        "only the reactor test survives: {:?}",
        keys(&detection)
    );
    assert_no_metacharacters(&detection);

    // A hostile artifactId never reaches a command: the group falls back to the label.
    for token in HOSTILE_TOKENS {
        let root = tempfile::tempdir().unwrap();
        write(
            root.path(),
            "pom.xml",
            &format!(
                "<project><artifactId>{}</artifactId></project>",
                token.replace('&', "&amp;").replace('<', "&lt;")
            ),
        );
        let detection = detect_env(root.path(), no_tools());
        assert_no_metacharacters(&detection);
        for entry in &detection.entries {
            assert!(
                !entry.group.chars().any(|c| METACHARACTERS.contains(&c)),
                "hostile group: {:?}",
                entry.group
            );
        }
    }
}

#[test]
fn maven_reads_a_child_project_directory() {
    let root = tempfile::tempdir().unwrap();
    write(root.path(), "backend/pom.xml", SPRING_BOOT_POM);
    write(root.path(), "backend/mvnw.cmd", "");
    write(root.path(), "backend/mvnw", "");
    let detection = detect_env(root.path(), no_tools());
    let wrapper = if cfg!(windows) { r".\mvnw.cmd" } else { "./mvnw" };
    let run = find(&detection, "maven:backend/pom.xml:spring-boot:run");
    assert_eq!(run.command, format!("{wrapper} spring-boot:run"));
    assert_eq!(run.cwd, "backend", "entries run in the Maven root so the wrapper resolves");
    assert_eq!(run.group, "demo");
    assert_eq!(run.source.file, "backend/pom.xml");
}

#[test]
fn gradle_reads_both_dsls_and_prefers_the_wrapper() {
    let root = tempfile::tempdir().unwrap();
    write(
        root.path(),
        "settings.gradle",
        "rootProject.name = 'demo'\ninclude ':api'\n",
    );
    write(
        root.path(),
        "build.gradle",
        "plugins {\n    id 'org.springframework.boot' version '3.2.0'\n    id 'application'\n}\n\ndependencies {}\n",
    );
    write(
        root.path(),
        "api/build.gradle.kts",
        "plugins {\n    id(\"org.springframework.boot\") version \"3.2.0\"\n}\n",
    );
    write(root.path(), "gradlew", "");
    write(root.path(), "gradlew.bat", "");
    let wrapper = if cfg!(windows) { r".\gradlew.bat" } else { "./gradlew" };
    let detection = detect_env(root.path(), no_tools());
    let run = find(&detection, "gradle:build.gradle:bootRun");
    assert_eq!(run.command, format!("{wrapper} bootRun"));
    assert_eq!(run.kind, "service");
    assert_eq!(run.group, "demo");
    assert_eq!(run.cwd, "");
    assert_eq!(run.source.kind, "gradle");
    assert_eq!(run.source.label, "build.gradle");
    assert!(!run.suggested);
    assert_eq!(find(&detection, "gradle:build.gradle:run").command, format!("{wrapper} run"));
    assert_eq!(find(&detection, "gradle:build.gradle:run").kind, "task");
    assert_eq!(find(&detection, "gradle:build.gradle:test").command, format!("{wrapper} test"));
    assert_eq!(find(&detection, "gradle:build.gradle:build").kind, "task");
    let api = find(&detection, "gradle:api/build.gradle.kts:bootRun");
    assert_eq!(api.command, format!("{wrapper} :api:bootRun"));
    assert_eq!(api.group, ":api");
    assert_eq!(api.source.file, "api/build.gradle.kts");
    assert_eq!(find(&detection, "gradle:api/build.gradle.kts:test").command, format!("{wrapper} :api:test"));
    assert!(!keys(&detection).contains(&"gradle:api/build.gradle.kts:run"), "no application plugin in api");
    assert!(
        !keys(&detection).iter().any(|key| key.starts_with("gradle:api/build.gradle.kts:build")),
        "only the root project gets build"
    );

    // Without a wrapper the plain executable is used; a Kotlin settings file works the same.
    let plain = tempfile::tempdir().unwrap();
    write(plain.path(), "settings.gradle.kts", "rootProject.name = \"plain\"\n");
    write(plain.path(), "build.gradle.kts", "plugins {\n    application\n}\n");
    let detection = detect_env(plain.path(), no_tools());
    assert_eq!(find(&detection, "gradle:build.gradle.kts:test").command, "gradle test");
    assert_eq!(find(&detection, "gradle:build.gradle.kts:test").group, "plain");
    assert_eq!(find(&detection, "gradle:build.gradle.kts:run").command, "gradle run");
    assert!(!keys(&detection).contains(&"gradle:build.gradle.kts:bootRun"));
}

#[test]
fn gradle_reads_include_forms_and_skips_missing_projects() {
    let root = tempfile::tempdir().unwrap();
    write(
        root.path(),
        "settings.gradle",
        "include(\"a\")\ninclude 'b', ':c:d'\ninclude(\n  \"e\"\n)\ninclude ':missing'\nincludeBuild(\"build-logic\")\n",
    );
    write(root.path(), "build.gradle", "plugins {}\n");
    for dir in ["a", "b", "c/d", "e", "build-logic"] {
        write(root.path(), &format!("{dir}/build.gradle"), "// project\n");
    }
    let detection = detect_env(root.path(), no_tools());
    let found = keys(&detection);
    for key in [
        "gradle:a/build.gradle:test",
        "gradle:b/build.gradle:test",
        "gradle:c/d/build.gradle:test",
        "gradle:e/build.gradle:test",
    ] {
        assert!(found.contains(&key), "{key}: {found:?}");
    }
    assert_eq!(find(&detection, "gradle:c/d/build.gradle:test").command, "gradle :c:d:test");
    assert_eq!(find(&detection, "gradle:c/d/build.gradle:test").group, ":c:d");
    assert!(!found.iter().any(|key| key.contains("missing")), "{found:?}");
    assert!(
        !found.iter().any(|key| key.contains("build-logic")),
        "includeBuild is not a project include: {found:?}"
    );
}

#[test]
fn gradle_ignores_commented_out_plugins_and_hostile_names() {
    let root = tempfile::tempdir().unwrap();
    write(
        root.path(),
        "build.gradle",
        "// id 'org.springframework.boot'\n/* apply plugin: 'application' */\nprintln 'https://example.invalid/x'\n",
    );
    let detection = detect_env(root.path(), no_tools());
    assert_eq!(keys(&detection), vec!["gradle:build.gradle:build", "gradle:build.gradle:test"]);

    for token in ["a&b", "a%b", "a!b", "a^b", "a;b", "a b", "a=b"] {
        let root = tempfile::tempdir().unwrap();
        write(root.path(), "settings.gradle", &format!("include '{token}'\n"));
        write(root.path(), "build.gradle", "apply plugin: 'application'\n");
        write(root.path(), &format!("{token}/build.gradle"), "\n");
        let detection = detect_env(root.path(), no_tools());
        assert_eq!(
            keys(&detection),
            vec!["gradle:build.gradle:build", "gradle:build.gradle:run", "gradle:build.gradle:test"],
            "include {token}"
        );
        assert_no_metacharacters(&detection);
    }
}

#[test]
fn python_runner_priority_uses_lockfiles_venvs_and_path() {
    for (lockfile, interpreter) in [
        ("uv.lock", "uv run python"),
        ("poetry.lock", "poetry run python"),
        ("pdm.lock", "pdm run python"),
        ("Pipfile.lock", "pipenv run python"),
    ] {
        let root = tempfile::tempdir().unwrap();
        write(root.path(), "pytest.ini", "[pytest]\n");
        write(root.path(), lockfile, "");
        let detection = detect_env(root.path(), no_tools());
        assert_eq!(
            find(&detection, "python:pytest.ini:pytest").command,
            format!("{interpreter} -m pytest"),
            "{lockfile}"
        );
    }
    // The worktree root's lockfile also serves a project one level down.
    let root = tempfile::tempdir().unwrap();
    write(root.path(), "uv.lock", "");
    write(root.path(), "backend/pytest.ini", "[pytest]\n");
    let detection = detect_env(root.path(), no_tools());
    assert_eq!(
        find(&detection, "python:backend/pytest.ini:pytest").command,
        "uv run python -m pytest"
    );
    assert_eq!(find(&detection, "python:backend/pytest.ini:pytest").cwd, "backend");

    // A project venv is called directly, with no activation; a root venv is
    // reached by a relative path from the entry's own cwd.
    let bin = if cfg!(windows) { "Scripts" } else { "bin" };
    let python = if cfg!(windows) { "python.exe" } else { "python" };
    for at_root in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let venv_at = if at_root { "" } else { "backend/" };
        write(root.path(), &format!("{venv_at}.venv/{bin}/{python}"), "");
        write(root.path(), "backend/pytest.ini", "[pytest]\n");
        let detection = detect_env(root.path(), no_tools());
        assert_eq!(
            find(&detection, "python:backend/pytest.ini:pytest").command,
            format!("{} -m pytest", venv_interpreter(at_root, ".venv")),
            "at_root={at_root}"
        );
    }
    // `py -3` when the launcher is on PATH, the plain interpreter otherwise.
    let root = tempfile::tempdir().unwrap();
    write(root.path(), "pytest.ini", "");
    let bin = tempfile::tempdir().unwrap();
    if cfg!(windows) {
        write(bin.path(), "py.cmd", "");
        let detection = detect_env(root.path(), tool_env(bin.path()));
        assert_eq!(find(&detection, "python:pytest.ini:pytest").command, "py -3 -m pytest");
        // The entry's tool is `py`, which is exactly what the fixture put on PATH.
        assert_eq!(find(&detection, "python:pytest.ini:pytest").missing_tool, None);
    }
    let detection = detect_env(root.path(), no_tools());
    assert_eq!(
        find(&detection, "python:pytest.ini:pytest").command,
        format!("{} -m pytest", python_interpreter())
    );
}

#[test]
fn python_reads_declared_scripts_per_runner() {
    let pyproject = "[project]\nname = \"demo\"\n[project.scripts]\nserve = \"demo:serve\"\nmodel-worker = \"demo:worker\"\n[tool.poetry.scripts]\nmigrate-db = \"demo:migrate\"\n";
    // A lockfile runner: `<tool> run <name>`.
    let root = tempfile::tempdir().unwrap();
    write(root.path(), "pyproject.toml", pyproject);
    write(root.path(), "uv.lock", "");
    let detection = detect_env(root.path(), no_tools());
    let serve = find(&detection, "python:pyproject.toml:script:serve");
    assert_eq!(serve.command, "uv run serve");
    assert_eq!(serve.kind, "task");
    assert_eq!(serve.group, "demo");
    assert_eq!(serve.cwd, "");
    assert_eq!(serve.source.file, "pyproject.toml");
    assert!(!serve.suggested);
    assert_eq!(find(&detection, "python:pyproject.toml:script:model-worker").command, "uv run model-worker");
    assert_eq!(find(&detection, "python:pyproject.toml:script:migrate-db").command, "uv run migrate-db");

    // A venv runner: the environment's own script, only when it exists.
    let root = tempfile::tempdir().unwrap();
    write(root.path(), "pyproject.toml", pyproject);
    let bin = if cfg!(windows) { "Scripts" } else { "bin" };
    let python = if cfg!(windows) { "python.exe" } else { "python" };
    let script = if cfg!(windows) { "serve.exe" } else { "serve" };
    write(root.path(), &format!(".venv/{bin}/{python}"), "");
    write(root.path(), &format!(".venv/{bin}/{script}"), "");
    let detection = detect_env(root.path(), no_tools());
    let expected = if cfg!(windows) {
        ".venv\\Scripts\\serve.exe"
    } else {
        ".venv/bin/serve"
    };
    assert_eq!(find(&detection, "python:pyproject.toml:script:serve").command, expected);
    assert!(
        !keys(&detection).contains(&"python:pyproject.toml:script:model-worker"),
        "a script the environment does not ship is not runnable there"
    );

    // The PATH fallback: the bare name, and its own PATH lookup reports the gap.
    let root = tempfile::tempdir().unwrap();
    write(root.path(), "pyproject.toml", pyproject);
    let detection = detect_env(root.path(), no_tools());
    let serve = find(&detection, "python:pyproject.toml:script:serve");
    assert_eq!(serve.command, "serve");
    assert_eq!(serve.missing_tool.as_deref(), Some("serve"));
}

#[test]
fn python_django_entries_need_a_django_manage_py() {
    let root = tempfile::tempdir().unwrap();
    write(root.path(), "manage.py", "#!/usr/bin/env python\nimport django\n");
    let detection = detect_env(root.path(), no_tools());
    let runserver = find(&detection, "python:manage.py:runserver");
    assert_eq!(runserver.command, format!("{} manage.py runserver", python_interpreter()));
    assert_eq!(runserver.kind, "service");
    assert_eq!(runserver.cwd, "");
    assert!(!runserver.suggested);
    assert_eq!(find(&detection, "python:manage.py:test").kind, "task");
    assert_eq!(
        find(&detection, "python:manage.py:migrate").command,
        format!("{} manage.py migrate", python_interpreter())
    );

    // A `manage.py` that never mentions Django is not a Django project.
    let root = tempfile::tempdir().unwrap();
    write(root.path(), "manage.py", "print('hello')\n");
    assert!(detect_env(root.path(), no_tools()).entries.is_empty());
}

#[test]
fn python_pytest_triggers_name_the_triggering_file() {
    let cases: [(&str, &str); 5] = [
        ("pytest.ini", "[pytest]\n"),
        ("pyproject.toml", "[tool.pytest.ini_options]\naddopts = \"-q\"\n"),
        ("setup.cfg", "[tool:pytest]\naddopts = -q\n"),
        ("conftest.py", "collect_ignore = []\n"),
        ("tests/placeholder.txt", ""),
    ];
    for (file, text) in cases {
        let root = tempfile::tempdir().unwrap();
        write(root.path(), "requirements.txt", "flask\n");
        write(root.path(), file, text);
        let detection = detect_env(root.path(), no_tools());
        let expected = if file == "tests/placeholder.txt" { "python:tests:pytest" } else { "" };
        let pytest: Vec<&str> = keys(&detection).iter().copied().filter(|key| key.ends_with(":pytest")).collect();
        assert_eq!(pytest.len(), 1, "{file}: {pytest:?}");
        if !expected.is_empty() {
            assert_eq!(pytest[0], expected);
        }
        assert_eq!(find(&detection, pytest[0]).command, format!("{} -m pytest", python_interpreter()));
        assert_eq!(find(&detection, pytest[0]).kind, "task");
    }
    // The trigger names the source file, e.g. `python:pyproject.toml:pytest`.
    let root = tempfile::tempdir().unwrap();
    write(root.path(), "pyproject.toml", "[tool.pytest.ini_options]\n");
    let detection = detect_env(root.path(), no_tools());
    assert_eq!(find(&detection, "python:pyproject.toml:pytest").source.file, "pyproject.toml");
}

#[test]
fn python_suggests_fastapi_and_flask_apps_including_a_src_layout() {
    let root = tempfile::tempdir().unwrap();
    write(root.path(), "pyproject.toml", "[project]\nname = \"demo\"\n");
    write(root.path(), "pytest.ini", "");
    write(root.path(), "app.py", "from flask import Flask\napp = Flask(__name__)\n");
    write(root.path(), "app/main.py", "from fastapi import FastAPI\napi = FastAPI()\n");
    write(root.path(), "src/acme/main.py", "import fastapi\nservice = FastAPI(title='x')\n");
    let detection = detect_env(root.path(), no_tools());
    let flask = find(&detection, "python:app.py:flask");
    assert_eq!(
        flask.command,
        format!("{} -m flask --app app.py:app run", python_interpreter())
    );
    assert_eq!(flask.kind, "service");
    assert_eq!(flask.group, "demo");
    assert!(flask.suggested, "an app found in source code is a suggestion");
    let fastapi = find(&detection, "python:app/main.py:uvicorn");
    assert_eq!(
        fastapi.command,
        format!("{} -m uvicorn app.main:api --reload", python_interpreter())
    );
    assert!(fastapi.suggested);
    let src = find(&detection, "python:src/acme/main.py:uvicorn");
    assert_eq!(
        src.command,
        format!("{} -m uvicorn acme.main:service --reload --app-dir src", python_interpreter())
    );
    assert!(src.suggested);
    // Manifest-declared entries are not suggestions.
    assert!(!find(&detection, "python:pytest.ini:pytest").suggested);

    // Only the exact factory shapes count, and only at line start.
    for source in [
        "app = Flask(\"other\")\n",
        "    app = Flask(__name__)\n",
        "my-app = FastAPI()\n",
        "app == FastAPI()\n",
    ] {
        let root = tempfile::tempdir().unwrap();
        write(root.path(), "app.py", source);
        let detection = detect_env(root.path(), no_tools());
        assert!(
            !keys(&detection).iter().any(|key| key.ends_with(":flask") || key.ends_with(":uvicorn")),
            "{source:?} -> {:?}",
            keys(&detection)
        );
    }
}

#[test]
fn python_rejects_hostile_script_and_app_names() {
    for token in HOSTILE_TOKENS {
        let root = tempfile::tempdir().unwrap();
        let quoted = serde_json::to_string(token).unwrap();
        write(
            root.path(),
            "pyproject.toml",
            &format!("[project]\nname = \"demo\"\n[project.scripts]\n{quoted} = \"demo:main\"\n"),
        );
        let detection = detect_env(root.path(), no_tools());
        assert!(detection.entries.is_empty(), "script {token}: {:?}", keys(&detection));
    }
    // A hostile environment variable name in an app module never reaches a command.
    let root = tempfile::tempdir().unwrap();
    write(root.path(), "app.py", "x = FastAPI()\n");
    write(root.path(), "src/a&b/main.py", "api = FastAPI()\n");
    let detection = detect_env(root.path(), no_tools());
    assert_no_metacharacters(&detection);
    assert!(
        !keys(&detection).iter().any(|key| key.contains("a&b")),
        "hostile src package: {:?}",
        keys(&detection)
    );
}
#[test]
fn project_directories_use_the_root_or_its_children() {
    // A root manifest suppresses the child scan: Node and Cargo keep this too.
    let root = tempfile::tempdir().unwrap();
    write(root.path(), "pom.xml", "<project><artifactId>root</artifactId></project>");
    write(root.path(), "backend/pom.xml", "<project><artifactId>backend</artifactId></project>");
    let detection = detect_env(root.path(), no_tools());
    assert!(
        keys(&detection).iter().all(|key| key.starts_with("maven:pom.xml:")),
        "{:?}",
        keys(&detection)
    );

    // Without a root manifest the immediate children are the projects; hidden,
    // vendored, environment and build-output directories are ignored.
    let root = tempfile::tempdir().unwrap();
    for dir in ["backend", ".hidden", "venv", ".venv", "__pycache__", "build", "out", "dist", "node_modules"] {
        write(root.path(), &format!("{dir}/pom.xml"), "<project><artifactId>x</artifactId></project>");
    }
    let detection = detect_env(root.path(), no_tools());
    assert!(keys(&detection).contains(&"maven:backend/pom.xml:test"));
    assert_eq!(
        keys(&detection).iter().filter(|key| key.ends_with(":test")).count(),
        1,
        "{:?}",
        keys(&detection)
    );

    // The rule covers all three ecosystems, so a `backend/` + `frontend/` tree works.
    let root = tempfile::tempdir().unwrap();
    write(root.path(), "backend/pyproject.toml", "[project]\nname = \"api\"\n[project.scripts]\nserve = \"api:serve\"\n");
    write(root.path(), "frontend/build.gradle", "plugins {\n    id 'application'\n}\n");
    write(root.path(), "greeter/pom.xml", SPRING_BOOT_POM);
    let detection = detect_env(root.path(), no_tools());
    assert!(keys(&detection).contains(&"python:backend/pyproject.toml:script:serve"));
    assert!(keys(&detection).contains(&"gradle:frontend/build.gradle:run"));
    assert!(keys(&detection).contains(&"maven:greeter/pom.xml:spring-boot:run"));
}

#[test]
fn nested_project_scan_is_capped_and_reports_truncation() {
    let root = tempfile::tempdir().unwrap();
    for index in 0..70 {
        write(
            root.path(),
            &format!("p{index:02}/pom.xml"),
            &format!("<project><artifactId>p{index:02}</artifactId></project>"),
        );
    }
    let detection = detect_env(root.path(), no_tools());
    let tests = keys(&detection)
        .iter()
        .filter(|key| key.starts_with("maven:p") && key.ends_with(":test"))
        .count();
    assert_eq!(tests, MAX_MEMBERS, "at most 64 directories are scanned");
    assert!(detection.truncated);
}

#[test]
fn jvm_and_python_keys_are_deterministic() {
    let root = tempfile::tempdir().unwrap();
    write(root.path(), "pom.xml", SPRING_BOOT_POM);
    write(root.path(), "settings.gradle", "include ':app'\n");
    write(root.path(), "build.gradle", "plugins {\n    id 'application'\n}\n");
    write(root.path(), "app/build.gradle", "\n");
    write(root.path(), "backend/pyproject.toml", "[project]\nname = \"api\"\n[project.scripts]\nserve = \"api:serve\"\n");
    write(root.path(), "backend/app.py", "app = Flask(__name__)\n");
    write(root.path(), "backend/tests/placeholder.txt", "");
    let first = detect_env(root.path(), no_tools());
    let second = detect_env(root.path(), no_tools());
    assert_eq!(keys(&first), keys(&second));
    for expected in [
        "maven:pom.xml:spring-boot:run",
        "gradle:build.gradle:run",
        "gradle:app/build.gradle:test",
        "python:backend/pyproject.toml:script:serve",
        "python:backend/app.py:flask",
        "python:backend/tests:pytest",
    ] {
        assert!(keys(&first).contains(&expected), "{expected}: {:?}", keys(&first));
    }
}

// ---------------------------------------------------------------- review round

#[test]
fn python_script_table_is_bounded_and_linear() {
    let root = tempfile::tempdir().unwrap();
    let mut pyproject = String::from("[project]\nname = \"big\"\n[project.scripts]\n");
    for index in 0..30_000 {
        pyproject.push_str(&format!("serve{index:05} = \"demo:serve\"\n"));
    }
    write(root.path(), "pyproject.toml", &pyproject);
    let started = Instant::now();
    let detection = detect_env(root.path(), no_tools());
    // ~30k distinct names: a set plus the entry cap instead of a quadratic scan.
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "the script table took {:?}",
        started.elapsed()
    );
    let scripts = keys(&detection)
        .iter()
        .filter(|key| key.contains(":script:"))
        .count();
    assert_eq!(scripts, MAX_ENTRIES, "the script list is capped like the entry list");
    assert!(detection.truncated);
}

#[test]
fn xml_depth_is_refused_instead_of_overflowing_the_stack() {
    // A realistically deep pom still parses.
    let mut ok = String::from("<project><artifactId>deep</artifactId>");
    for _ in 0..60 {
        ok.push_str("<a>");
    }
    for _ in 0..60 {
        ok.push_str("</a>");
    }
    ok.push_str("</project>");
    let root = tempfile::tempdir().unwrap();
    write(root.path(), "pom.xml", &ok);
    assert!(keys(&detect_env(root.path(), no_tools())).contains(&"maven:pom.xml:test"));

    // Past the nesting bound the document is refused: no tree, no recursive drop.
    let depth = 140_000usize;
    let mut deep = String::from("<project>");
    for _ in 0..depth {
        deep.push_str("<a>");
    }
    for _ in 0..depth {
        deep.push_str("</a>");
    }
    deep.push_str("</project>");
    assert!(deep.len() < MANIFEST_LIMIT as usize);
    let root = tempfile::tempdir().unwrap();
    write(root.path(), "pom.xml", &deep);
    assert!(detect_env(root.path(), no_tools()).entries.is_empty());
}

#[test]
fn gradle_plugin_scan_stays_linear_on_a_hostile_file() {
    let root = tempfile::tempdir().unwrap();
    write(root.path(), "build.gradle", &"plugins ".repeat(125_000));
    let started = Instant::now();
    let detection = detect_env(root.path(), no_tools());
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "the plugin scan took {:?}",
        started.elapsed()
    );
    assert_eq!(
        keys(&detection),
        vec!["gradle:build.gradle:build", "gradle:build.gradle:test"]
    );
}

#[test]
fn maven_reactor_with_unresolved_modules_is_never_single_module() {
    let root = tempfile::tempdir().unwrap();
    write(
        root.path(),
        "pom.xml",
        "<project><artifactId>demo</artifactId><modules><module>missing</module></modules><build><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>",
    );
    let detection = detect_env(root.path(), no_tools());
    assert_eq!(
        keys(&detection),
        vec!["maven:pom.xml:package", "maven:pom.xml:test"],
        "a declared reactor keeps the reactor goals even when no module resolves"
    );
}

#[test]
fn maven_module_group_falls_back_to_the_module_directory() {
    let root = tempfile::tempdir().unwrap();
    write(
        root.path(),
        "pom.xml",
        "<project><artifactId>demo</artifactId><modules><module>services/api</module></modules></project>",
    );
    write(root.path(), "services/api/pom.xml", "<project><packaging>jar</packaging></project>");
    let detection = detect_env(root.path(), no_tools());
    assert_eq!(
        find(&detection, "maven:services/api/pom.xml:test").group,
        "services/api",
        "the fallback is the module directory, not the pom file"
    );
}

#[test]
fn gradle_include_cap_is_sixty_four_projects_total() {
    let root = tempfile::tempdir().unwrap();
    let mut settings = String::new();
    for index in 0..70 {
        settings.push_str(&format!("include ':p{index:02}'\n"));
        write(root.path(), &format!("p{index:02}/build.gradle"), "\n");
    }
    write(root.path(), "settings.gradle", &settings);
    write(root.path(), "build.gradle", "\n");
    let detection = detect_env(root.path(), no_tools());
    let modules = keys(&detection)
        .iter()
        .filter(|key| key.starts_with("gradle:p") && key.ends_with(":test"))
        .count();
    assert_eq!(modules, MAX_MEMBERS - 1, "the root plus 63 includes is 64 projects");
    assert!(detection.truncated);
}

#[test]
fn python_project_lockfile_and_venv_win_over_the_worktree_root() {
    // The child's own lockfile beats a different root lockfile.
    let root = tempfile::tempdir().unwrap();
    write(root.path(), "uv.lock", "");
    write(root.path(), "backend/poetry.lock", "");
    write(root.path(), "backend/pytest.ini", "");
    let detection = detect_env(root.path(), no_tools());
    assert_eq!(
        find(&detection, "python:backend/pytest.ini:pytest").command,
        "poetry run python -m pytest"
    );

    // The child's own environment beats the root lockfile too.
    let root = tempfile::tempdir().unwrap();
    write(root.path(), "uv.lock", "");
    let bin = if cfg!(windows) { "Scripts" } else { "bin" };
    let python = if cfg!(windows) { "python.exe" } else { "python" };
    write(root.path(), &format!("backend/.venv/{bin}/{python}"), "");
    write(root.path(), "backend/pytest.ini", "");
    let detection = detect_env(root.path(), no_tools());
    assert_eq!(
        find(&detection, "python:backend/pytest.ini:pytest").command,
        format!("{} -m pytest", venv_interpreter(false, ".venv"))
    );
}

#[test]
fn project_scan_ignores_loose_files_and_caps_the_listing() {
    // Files are not projects: 70 of them must not exhaust the project cap.
    let root = tempfile::tempdir().unwrap();
    for index in 0..70 {
        write(root.path(), &format!("file{index:02}.txt"), "");
    }
    write(root.path(), "backend/pom.xml", "<project><artifactId>api</artifactId></project>");
    let detection = detect_env(root.path(), no_tools());
    assert!(
        keys(&detection).contains(&"maven:backend/pom.xml:test"),
        "{:?}",
        keys(&detection)
    );

    // A flat root with thousands of entries stops at the listing bound.
    let flat = tempfile::tempdir().unwrap();
    for index in 0..(MAX_SCAN_ENTRIES + 4) {
        write(flat.path(), &format!("f{index:05}"), "");
    }
    let mut budget = Budget {
        started: Some(Instant::now() + Duration::from_secs(3600)),
        truncated: false,
    };
    assert!(super::project_dirs(flat.path(), &mut budget, &|_| false).is_empty());
    assert!(budget.truncated);
}

#[cfg(windows)]
#[test]
fn project_scan_refuses_a_junction_out_of_the_root() {
    let outside = tempfile::tempdir().unwrap();
    write(outside.path(), "pom.xml", "<project><artifactId>outside</artifactId></project>");
    let root = tempfile::tempdir().unwrap();
    write(root.path(), "real/pom.xml", "<project><artifactId>real</artifactId></project>");
    use std::os::windows::process::CommandExt;
    let junction = root.path().join("linked");
    let payload = format!(
        r#""mklink /J "{}" "{}"""#,
        junction.display(),
        outside.path().display()
    );
    let status = std::process::Command::new("cmd.exe")
        .creation_flags(0x08000000)
        .args(["/D", "/S", "/C"])
        .raw_arg(payload)
        .status()
        .unwrap();
    assert!(status.success());
    let detection = detect_env(root.path(), no_tools());
    let found = keys(&detection);
    assert!(found.contains(&"maven:real/pom.xml:test"));
    assert!(
        !found.iter().any(|key| key.contains("linked") || key.contains("outside")),
        "{found:?}"
    );
}

#[test]
fn newline_hostile_names_are_rejected_for_every_new_field() {
    // Maven: a module path and an artifactId with a literal newline.
    let root = tempfile::tempdir().unwrap();
    write(
        root.path(),
        "pom.xml",
        "<project><artifactId>de\nmo</artifactId><modules><module>serv\nices</module></modules></project>",
    );
    let detection = detect_env(root.path(), no_tools());
    assert!(!keys(&detection).iter().any(|key| key.contains("services")), "{:?}", keys(&detection));
    for entry in &detection.entries {
        assert!(!entry.command.contains('\n') && !entry.group.contains('\n'), "{entry:?}");
    }

    // Gradle: a newline inside an include string never becomes a project.
    let root = tempfile::tempdir().unwrap();
    write(root.path(), "settings.gradle", "include 'app\ncore'\n");
    write(root.path(), "build.gradle", "\n");
    let detection = detect_env(root.path(), no_tools());
    assert!(keys(&detection).iter().all(|key| !key.contains("core")), "{:?}", keys(&detection));

    // Python: a TOML escaped newline in a script name is rejected.
    let root = tempfile::tempdir().unwrap();
    write(
        root.path(),
        "pyproject.toml",
        "[project]\nname = \"demo\"\n[project.scripts]\n\"a\\nb\" = \"demo:main\"\n",
    );
    assert!(detect_env(root.path(), no_tools()).entries.is_empty());
}
