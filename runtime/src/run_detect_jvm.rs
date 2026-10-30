//! Maven and Gradle detectors for the Run view.
//!
//! Both read their build files as text only: a build script is code, and asking
//! the build tool to enumerate tasks would execute it. `pom.xml` goes through a
//! small XML-subset reader and the Gradle files through a comment stripper, so a
//! malformed or hostile manifest yields no entries instead of an error.
use super::*;

const POM: &str = "pom.xml";
const GRADLE_BUILD_FILES: [&str; 2] = ["build.gradle", "build.gradle.kts"];
const GRADLE_SETTINGS_FILES: [&str; 2] = ["settings.gradle", "settings.gradle.kts"];
const SPRING_BOOT_MAVEN: &str = "spring-boot-maven-plugin";
const SPRING_BOOT_GRADLE: &str = "org.springframework.boot";
// The XML reader is a subset: real poms nest a handful of levels, and an
// unbounded tree cannot be dropped without a recursive stack overflow.
const MAX_XML_DEPTH: usize = 64;

// ---------------------------------------------------------------- Maven

pub(super) fn detect_maven(root: &Path, budget: &mut Budget, sink: &mut Sink) {
    for dir in project_dirs(root, budget, &|dir| dir.join(POM).is_file()) {
        if budget.expired() {
            return;
        }
        detect_maven_project(root, &dir, budget, sink);
    }
}

fn detect_maven_project(root: &Path, dir: &str, budget: &mut Budget, sink: &mut Sink) {
    let pom = manifest_path(dir, POM);
    let Some(project) = read_text(&root.join(&pom)).and_then(|text| parse_xml(&text)) else {
        return;
    };
    if project.name != "project" {
        return;
    }
    // The wrapper is resolved from the directory the top pom lives in, and every
    // entry runs there so `mvnw` (or `mvnw.cmd`) resolves like a hand-typed command.
    let executable = maven_executable(root, dir);
    let group = group_name(child_text(&project, "artifactId"), root, dir);
    let packaging = child_text(&project, "packaging").unwrap_or_default();
    // `None` means the pom declares no `<modules>` at all. A reactor whose modules
    // are all unresolvable, or whose scan ran out of budget, is still a reactor and
    // must never fall back to the single-module goals.
    let modules = maven_modules(root, dir, &project, budget);
    let Some(modules) = modules else {
        // An aggregator (`<packaging>pom</packaging>`) has nothing to boot even when
        // the plugin is declared; its modules carry the runnable applications.
        if packaging != "pom" && declares_spring_boot(&project) {
            push_maven(
                sink,
                budget,
                &pom,
                dir,
                "spring-boot:run",
                format!("{executable} spring-boot:run"),
                "service",
                &group,
            );
        }
        for task in ["test", "package"] {
            push_maven(
                sink,
                budget,
                &pom,
                dir,
                task,
                format!("{executable} {task}"),
                "task",
                &group,
            );
        }
        return;
    };
    for task in ["test", "package"] {
        push_maven(
            sink,
            budget,
            &pom,
            dir,
            task,
            format!("{executable} {task}"),
            "task",
            &group,
        );
    }
    for module in modules {
        if budget.expired() {
            return;
        }
        let module_pom = manifest_path(dir, &format!("{}/pom.xml", module.path));
        if module.spring_boot {
            push_maven(
                sink,
                budget,
                &module_pom,
                dir,
                "spring-boot:run",
                format!("{executable} -pl {} spring-boot:run", module.path),
                "service",
                &module.group,
            );
        }
        push_maven(
            sink,
            budget,
            &module_pom,
            dir,
            "test",
            format!("{executable} -pl {} test", module.path),
            "task",
            &module.group,
        );
    }
}

#[allow(clippy::too_many_arguments)]
fn push_maven(
    sink: &mut Sink,
    budget: &mut Budget,
    pom: &str,
    cwd: &str,
    goal: &str,
    command: String,
    entry_kind: &'static str,
    group: &str,
) {
    sink.push(
        budget,
        Candidate {
            kind: "maven",
            file: pom.to_owned(),
            name: goal.to_owned(),
            key: format!("maven:{pom}:{goal}"),
            command,
            cwd: cwd.to_owned(),
            entry_kind,
            group: group.to_owned(),
            suggested: false,
        },
    );
}

fn maven_executable(root: &Path, dir: &str) -> &'static str {
    let base = if dir.is_empty() {
        root.to_path_buf()
    } else {
        root.join(dir)
    };
    if cfg!(windows) {
        if base.join("mvnw.cmd").is_file() {
            // `\`-prefixed so cmd searches the Maven root even when
            // NoDefaultCurrentDirectoryInExePath is set.
            r".\mvnw.cmd"
        } else {
            "mvn"
        }
    } else if base.join("mvnw").is_file() {
        "./mvnw"
    } else {
        "mvn"
    }
}

/// One module of a multi-module reactor, with the pom facts its entries need.
struct MavenModule {
    /// Relative to the Maven root, forward slashes: what `-pl` takes.
    path: String,
    group: String,
    spring_boot: bool,
}

fn maven_modules(
    root: &Path,
    project_dir: &str,
    project: &Element,
    budget: &mut Budget,
) -> Option<Vec<MavenModule>> {
    let declared = module_names(project);
    if declared.is_empty() {
        return None;
    }
    let maven_root = if project_dir.is_empty() {
        root.to_path_buf()
    } else {
        root.join(project_dir)
    };
    let mut paths: Vec<String> = Vec::new();
    for name in declared {
        if budget.expired() {
            break;
        }
        if paths.len() >= MAX_MEMBERS {
            budget.truncated = true;
            break;
        }
        if let Some(path) = maven_module_path(&maven_root, &name) {
            paths.push(path);
        }
    }
    // Nested `<modules>` are followed exactly one level further.
    'nested: for path in paths.clone() {
        if budget.expired() || paths.len() >= MAX_MEMBERS {
            break;
        }
        let Some(nested) = read_text(&maven_root.join(&path).join(POM))
            .and_then(|text| parse_xml(&text))
        else {
            continue;
        };
        for name in module_names(&nested) {
            if budget.expired() {
                break 'nested;
            }
            if paths.len() >= MAX_MEMBERS {
                budget.truncated = true;
                break;
            }
            if let Some(child) = maven_module_path(&maven_root, &format!("{path}/{name}")) {
                if !paths.contains(&child) {
                    paths.push(child);
                }
            }
        }
    }
    let mut modules: Vec<MavenModule> = Vec::new();
    for path in paths {
        if budget.expired() {
            break;
        }
        let Some(module) = read_text(&maven_root.join(&path).join(POM)) else {
            continue;
        };
        let Some(element) = parse_xml(&module) else {
            continue;
        };
        // The group fallback is the module's own directory, never the pom file.
        let module_dir = manifest_path(project_dir, &path);
        let group = group_name(child_text(&element, "artifactId"), root, &module_dir);
        modules.push(MavenModule {
            path,
            group,
            spring_boot: declares_spring_boot(&element),
        });
    }
    Some(modules)
}

/// A `<module>` entry: a relative directory that exists, contains a pom and stays
/// inside the Maven root. Anything else (an absolute path, `..`, a name with a
/// shell metacharacter or a junction out of the tree) is skipped.
fn maven_module_path(maven_root: &Path, name: &str) -> Option<String> {
    let cleaned = name.trim().replace('\\', "/");
    let segments: Vec<&str> = cleaned.split('/').filter(|part| !part.is_empty()).collect();
    if segments.is_empty()
        || segments
            .iter()
            .any(|part| matches!(*part, "." | "..") || !valid_name(part))
    {
        return None;
    }
    let relative = segments.join("/");
    let directory = maven_root.join(&relative);
    if !directory.join(POM).is_file() {
        return None;
    }
    let inside = directory.canonicalize().ok()?;
    let base = maven_root.canonicalize().ok()?;
    inside.starts_with(&base).then_some(relative)
}

fn declares_spring_boot(project: &Element) -> bool {
    // `pluginManagement/plugins` declares a version, not a build plugin.
    let Some(plugins) = child(project, "build").and_then(|build| child(build, "plugins")) else {
        return false;
    };
    plugins.children.iter().any(|plugin| {
        plugin.name == "plugin"
            && child_text(plugin, "artifactId").is_some_and(|text| text == SPRING_BOOT_MAVEN)
    })
}

fn module_names(project: &Element) -> Vec<String> {
    let Some(modules) = child(project, "modules") else {
        return Vec::new();
    };
    modules
        .children
        .iter()
        .filter(|module| module.name == "module")
        .filter_map(|module| {
            let name = module.text.trim();
            (!name.is_empty()).then(|| name.to_owned())
        })
        .collect()
}

fn group_name(artifact_id: Option<String>, root: &Path, dir: &str) -> String {
    match artifact_id {
        // The group is display text, but a hostile artifactId still should not leak
        // into a row: fall back to the directory label instead.
        Some(name) if valid_name(&name) => name,
        _ => directory_label(root, dir),
    }
}

// ---------------------------------------------------------------- Gradle

pub(super) fn detect_gradle(root: &Path, budget: &mut Budget, sink: &mut Sink) {
    for dir in project_dirs(root, budget, &|dir| {
        gradle_settings(dir).is_some() || gradle_build(dir).is_some()
    }) {
        if budget.expired() {
            return;
        }
        detect_gradle_project(root, &dir, budget, sink);
    }
}

fn gradle_settings(dir: &Path) -> Option<&'static str> {
    GRADLE_SETTINGS_FILES
        .iter()
        .copied()
        .find(|name| dir.join(name).is_file())
}

fn gradle_build(dir: &Path) -> Option<&'static str> {
    GRADLE_BUILD_FILES
        .iter()
        .copied()
        .find(|name| dir.join(name).is_file())
}

fn detect_gradle_project(root: &Path, dir: &str, budget: &mut Budget, sink: &mut Sink) {
    let gradle_root = if dir.is_empty() {
        root.to_path_buf()
    } else {
        root.join(dir)
    };
    let executable = gradle_executable(root, dir);
    let settings = gradle_settings(&gradle_root).and_then(|name| read_text(&gradle_root.join(name)));
    let settings = settings.map(|text| strip_gradle_comments(&text));
    let root_group = settings
        .as_deref()
        .and_then(root_project_name)
        .unwrap_or_else(|| ":".into());
    // The root project, then every `include`d project; each must exist inside the
    // Gradle root and is addressed by its Gradle path (`:a:b`).
    let mut projects: Vec<(String, String)> = vec![(String::new(), String::new())];
    if let Some(text) = settings.as_deref() {
        let mut seen = BTreeSet::new();
        for include in gradle_includes(text) {
            if budget.expired() {
                return;
            }
            if projects.len() >= MAX_MEMBERS {
                budget.truncated = true;
                break;
            }
            if let Some(project) = gradle_project_path(&gradle_root, &include) {
                if seen.insert(project.0.clone()) {
                    projects.push(project);
                }
            }
        }
    }
    for (relative, gradle_path) in projects {
        if budget.expired() {
            return;
        }
        let Some(build_name) = gradle_build(&gradle_root.join(&relative)) else {
            continue;
        };
        let Some(text) = read_text(&gradle_root.join(&relative).join(build_name)) else {
            continue;
        };
        let text = strip_gradle_comments(&text);
        let file = if relative.is_empty() {
            manifest_path(dir, build_name)
        } else {
            manifest_path(dir, &format!("{relative}/{build_name}"))
        };
        let group = if gradle_path.is_empty() {
            root_group.clone()
        } else {
            gradle_path.clone()
        };
        let prefix = if gradle_path.is_empty() {
            String::new()
        } else {
            format!("{gradle_path}:")
        };
        let (spring_boot, application) = gradle_plugins(&text);
        if spring_boot {
            push_gradle(
                sink,
                budget,
                &file,
                dir,
                "bootRun",
                format!("{executable} {prefix}bootRun"),
                "service",
                &group,
            );
        }
        if application {
            push_gradle(
                sink,
                budget,
                &file,
                dir,
                "run",
                format!("{executable} {prefix}run"),
                "task",
                &group,
            );
        }
        push_gradle(
            sink,
            budget,
            &file,
            dir,
            "test",
            format!("{executable} {prefix}test"),
            "task",
            &group,
        );
        if gradle_path.is_empty() {
            push_gradle(
                sink,
                budget,
                &file,
                dir,
                "build",
                format!("{executable} build"),
                "task",
                &group,
            );
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn push_gradle(
    sink: &mut Sink,
    budget: &mut Budget,
    file: &str,
    cwd: &str,
    task: &str,
    command: String,
    entry_kind: &'static str,
    group: &str,
) {
    sink.push(
        budget,
        Candidate {
            kind: "gradle",
            file: file.to_owned(),
            name: task.to_owned(),
            key: format!("gradle:{file}:{task}"),
            command,
            cwd: cwd.to_owned(),
            entry_kind,
            group: group.to_owned(),
            suggested: false,
        },
    );
}

fn gradle_executable(root: &Path, dir: &str) -> &'static str {
    let base = if dir.is_empty() {
        root.to_path_buf()
    } else {
        root.join(dir)
    };
    if cfg!(windows) {
        if base.join("gradlew.bat").is_file() {
            r".\gradlew.bat"
        } else {
            "gradle"
        }
    } else if base.join("gradlew").is_file() {
        "./gradlew"
    } else {
        "gradle"
    }
}

/// `:a:b` (or `a/b`) maps to the directory `a/b`; the Gradle path is `:a:b`.
fn gradle_project_path(gradle_root: &Path, include: &str) -> Option<(String, String)> {
    let cleaned = include.trim().replace('\\', "/");
    let segments: Vec<&str> = cleaned
        .split([':', '/'])
        .filter(|part| !part.is_empty())
        .collect();
    if segments.is_empty()
        || segments
            .iter()
            .any(|part| matches!(*part, "." | "..") || !valid_name(part))
    {
        return None;
    }
    let relative = segments.join("/");
    let directory = gradle_root.join(&relative);
    if !directory.is_dir() {
        return None;
    }
    let inside = directory.canonicalize().ok()?;
    let base = gradle_root.canonicalize().ok()?;
    if !inside.starts_with(&base) {
        return None;
    }
    Some((relative, format!(":{}", segments.join(":"))))
}

fn gradle_plugins(text: &str) -> (bool, bool) {
    let spring_boot = declares_gradle_plugin(text, SPRING_BOOT_GRADLE);
    // The Kotlin and Groovy DSLs also allow a bare plugin id line inside `plugins { }`.
    let application = declares_gradle_plugin(text, "application")
        || plugins_block(text).is_some_and(|block| {
            block
                .lines()
                .any(|line| line.trim().trim_end_matches(';') == "application")
        });
    (spring_boot, application)
}

/// Matches `id("x")`, `id 'x'` and `apply plugin: 'x'`; comments are already gone.
fn declares_gradle_plugin(text: &str, plugin: &str) -> bool {
    text.match_indices(plugin).any(|(index, _)| {
        let before = text[..index].trim_end();
        let after = text[index + plugin.len()..].trim_start();
        if !(after.starts_with(')') || after.starts_with('"') || after.starts_with('\'')) {
            return false;
        }
        let head = before.trim_end_matches(['"', '\'', ':', ' ']);
        let (callee, called) = match head.strip_suffix('(') {
            Some(rest) => (rest.trim_end(), true),
            None => (head, false),
        };
        let start = callee
            .rfind(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
            .map_or(0, |position| position + 1);
        if callee[..start].ends_with('.') {
            return false;
        }
        let identifier = &callee[start..];
        if called {
            identifier == "id"
        } else {
            identifier == "id" || identifier == "plugin"
        }
    })
}

fn plugins_block(text: &str) -> Option<&str> {
    // The first `plugins {` block of the file. Each `plugins` occurrence without an
    // opening brace is skipped by advancing past it, so a file of them stays linear.
    let mut rest = text;
    while let Some(index) = rest.find("plugins") {
        let after = &rest[index + "plugins".len()..];
        let trimmed = after.trim_start();
        if let Some(body) = trimmed.strip_prefix('{') {
            let end = body.find('}')?;
            return Some(&body[..end]);
        }
        rest = after;
    }
    None
}

fn root_project_name(text: &str) -> Option<String> {
    let index = text.find("rootProject.name")?;
    let after = text[index + "rootProject.name".len()..].trim_start();
    let after = after.strip_prefix('=')?.trim_start();
    quoted_strings(after)
        .into_iter()
        .next()
        .filter(|name| !name.is_empty())
}

fn gradle_includes(text: &str) -> Vec<String> {
    let mut includes = Vec::new();
    let mut rest = text;
    while let Some(index) = find_call(rest, "include") {
        let after = rest[index + "include".len()..].trim_start();
        let (body, tail) = if let Some(body) = after.strip_prefix('(') {
            match balanced(body, '(', ')') {
                Some(end) => (&body[..end], &body[end + 1..]),
                None => break,
            }
        } else {
            let end = after.find(['\n', ';']).unwrap_or(after.len());
            (&after[..end], &after[end..])
        };
        includes.extend(quoted_strings(body));
        if tail.is_empty() {
            break;
        }
        rest = tail;
    }
    includes
}

fn find_call(text: &str, word: &str) -> Option<usize> {
    let boundary = |value: Option<char>| {
        value.map_or(true, |c| !(c.is_ascii_alphanumeric() || c == '_'))
    };
    text.match_indices(word).find_map(|(index, _)| {
        let before = text[..index].chars().next_back();
        let after = text[index + word.len()..].chars().next();
        (boundary(before) && boundary(after)).then_some(index)
    })
}

fn balanced(text: &str, open: char, close: char) -> Option<usize> {
    let mut depth = 1usize;
    let mut quote: Option<char> = None;
    for (index, value) in text.char_indices() {
        match (quote, value) {
            (Some(open), _) if value == open => quote = None,
            (Some(_), _) => {}
            (None, '"') | (None, '\'') => quote = Some(value),
            (None, _) if value == open => depth += 1,
            (None, _) if value == close => {
                depth -= 1;
                if depth == 0 {
                    return Some(index);
                }
            }
            _ => {}
        }
    }
    None
}

fn quoted_strings(text: &str) -> Vec<String> {
    let mut values = Vec::new();
    let mut chars = text.chars();
    while let Some(value) = chars.next() {
        if value != '"' && value != '\'' {
            continue;
        }
        let mut string = String::new();
        let mut closed = false;
        for next in chars.by_ref() {
            if next == value {
                closed = true;
                break;
            }
            if next == '\n' {
                break;
            }
            string.push(next);
        }
        if closed {
            values.push(string);
        }
    }
    values
}

/// Gradle files are code, but `//` and `/* */` comments are not: a commented-out
/// plugin must not count. Quotes are respected so a URL is not cut in half.
fn strip_gradle_comments(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    let mut quote: Option<char> = None;
    while let Some(value) = chars.next() {
        match quote {
            Some(open) => {
                if value == '\\' {
                    out.push(value);
                    if let Some(next) = chars.next() {
                        out.push(next);
                    }
                    continue;
                }
                if value == open {
                    quote = None;
                }
                out.push(value);
            }
            None => {
                if value == '/' {
                    match chars.peek().copied() {
                        Some('/') => {
                            for next in chars.by_ref() {
                                if next == '\n' {
                                    out.push('\n');
                                    break;
                                }
                            }
                            continue;
                        }
                        Some('*') => {
                            chars.next();
                            let mut previous = '\0';
                            for next in chars.by_ref() {
                                if previous == '*' && next == '/' {
                                    break;
                                }
                                previous = next;
                            }
                            out.push(' ');
                            continue;
                        }
                        _ => {}
                    }
                }
                if value == '"' || value == '\'' {
                    quote = Some(value);
                }
                out.push(value);
            }
        }
    }
    out
}

// ---------------------------------------------------------------- XML subset

#[derive(Debug)]
struct Element {
    name: String,
    text: String,
    children: Vec<Element>,
}

/// A deliberately small XML reader: enough for `pom.xml`, not a general parser.
/// Comments, CDATA and declarations are handled; any malformed input yields
/// `None`, so a broken pom produces no entries instead of an error.
fn parse_xml(text: &str) -> Option<Element> {
    let mut stack: Vec<Element> = Vec::new();
    let mut root: Option<Element> = None;
    let mut rest = text;
    while let Some(offset) = rest.find('<') {
        if let Some(top) = stack.last_mut() {
            top.text.push_str(&rest[..offset]);
        }
        rest = &rest[offset..];
        if let Some(after) = rest.strip_prefix("<!--") {
            rest = &after[after.find("-->")? + 3..];
        } else if let Some(after) = rest.strip_prefix("<![CDATA[") {
            let end = after.find("]]>")?;
            if let Some(top) = stack.last_mut() {
                top.text.push_str(&after[..end]);
            }
            rest = &after[end + 3..];
        } else if rest.starts_with("<?") || rest.starts_with("<!") {
            rest = &rest[rest.find('>')? + 1..];
        } else if let Some(after) = rest.strip_prefix("</") {
            let end = after.find('>')?;
            let name = after[..end].trim();
            let element = stack.pop()?;
            if element.name != name {
                return None;
            }
            match stack.last_mut() {
                Some(parent) => parent.children.push(element),
                None if root.is_none() => root = Some(element),
                None => return None,
            }
            rest = &after[end + 1..];
        } else {
            let (name, self_closed, after) = start_tag(&rest[1..])?;
            let element = Element {
                name,
                text: String::new(),
                children: Vec::new(),
            };
            if self_closed {
                match stack.last_mut() {
                    Some(parent) => parent.children.push(element),
                    None if root.is_none() => root = Some(element),
                    None => return None,
                }
            } else {
                if stack.len() >= MAX_XML_DEPTH {
                    return None;
                }
                stack.push(element);
            }
            rest = after;
        }
    }
    if !stack.is_empty() {
        return None;
    }
    root
}

fn start_tag(text: &str) -> Option<(String, bool, &str)> {
    let name_end = text.find(|c: char| c.is_whitespace() || c == '/' || c == '>')?;
    let name = &text[..name_end];
    if name.is_empty() {
        return None;
    }
    let bytes = text.as_bytes();
    let mut quote: Option<u8> = None;
    let mut index = name_end;
    while index < bytes.len() {
        let byte = bytes[index];
        match (quote, byte) {
            (Some(open), _) if byte == open => quote = None,
            (Some(_), _) => {}
            (None, b'"') | (None, b'\'') => quote = Some(byte),
            (None, b'>') => {
                let self_closed = text[..index].trim_end().ends_with('/');
                return Some((name.to_owned(), self_closed, &text[index + 1..]));
            }
            _ => {}
        }
        index += 1;
    }
    None
}

fn child<'a>(element: &'a Element, name: &str) -> Option<&'a Element> {
    element.children.iter().find(|child| child.name == name)
}

fn child_text(element: &Element, name: &str) -> Option<String> {
    let text = child(element, name)?.text.trim();
    (!text.is_empty()).then(|| text.to_owned())
}
