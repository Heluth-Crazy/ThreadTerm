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
    let mut sink = Sink::new(root.path());
    let candidate = |key: String, name: String| Candidate {
        kind: "procfile",
        file: "Procfile".into(),
        name,
        command: "echo ok".into(),
        cwd: String::new(),
        entry_kind: "service",
        group: "Procfile".into(),
        key,
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
    let mut sink = Sink::new(root.path());
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