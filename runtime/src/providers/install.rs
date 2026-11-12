//! One recipe table for installing and updating agents (design: Settings › Agents, phase 2).
//!
//! Every command the renderer can run comes from here — a verified npm package name or a vendor
//! update flag — never from the renderer. `cwd` is filled with this computer's home folder, because
//! the renderer has no home path and a remote computer's home is only known to its own runtime.

use super::common;
use super::{ProviderCommand, ProviderSetup};
use std::path::{Path, PathBuf};

/// A verified way to install one agent. `npm` is the package published to the npm registry, checked
/// against this PC's installers on 2026-11-12; `vendor_update` is the CLI's own update subcommand,
/// used only when the CLI was not installed by npm.
struct Recipe {
    id: &'static str,
    npm: Option<&'static str>,
    vendor_update: Option<&'static [&'static str]>,
}

/// Kimi and Grok have no verified Windows install command, so their rows link to the homepage
/// instead; Grok still updates itself. Gemini ships as a bundled plugin whose manifest declares
/// `@google/gemini-cli`, so it is not in this table.
const RECIPES: &[Recipe] = &[
    Recipe { id: "codex", npm: Some("@openai/codex"), vendor_update: None },
    Recipe { id: "claude", npm: Some("@anthropic-ai/claude-code"), vendor_update: Some(&["update"]) },
    Recipe { id: "opencode", npm: Some("opencode-ai"), vendor_update: None },
    Recipe { id: "pi", npm: Some("@earendil-works/pi-coding-agent"), vendor_update: None },
    Recipe { id: "grok", npm: None, vendor_update: Some(&["update"]) },
    Recipe { id: "kimi", npm: None, vendor_update: None },
];

fn recipe(id: &str) -> Option<&'static Recipe> {
    RECIPES.iter().find(|recipe| recipe.id == id)
}

/// An npm package name (`@scope/name` or `name`), lower case, without shell metacharacters. A plugin
/// manifest may declare only this; the runtime builds the command line itself.
pub(crate) fn valid_npm_package(value: &str) -> bool {
    if value.is_empty() || value.len() > 214 || value.chars().any(char::is_control) {
        return false;
    }
    let (scope, name) = match value.strip_prefix('@') {
        Some(rest) => match rest.split_once('/') {
            Some((scope, name)) => (Some(scope), name),
            None => return false,
        },
        None => (None, value),
    };
    let part = |part: &str| {
        part.chars().next().is_some_and(|first| first.is_ascii_lowercase() || first.is_ascii_digit())
            && part.chars().all(|character| {
                character.is_ascii_lowercase() || character.is_ascii_digit() || matches!(character, '-' | '.' | '_' | '~')
            })
    };
    part(name) && scope.is_none_or(part)
}

/// The folder every handed-out command runs in: this computer's home folder.
pub(crate) fn home_directory() -> Option<String> {
    let environment = crate::environment::provider_environment();
    ["USERPROFILE", "HOME"].iter().find_map(|name| {
        crate::environment::value(&environment.vars, name)
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty() && Path::new(value).is_absolute())
            .map(str::to_owned)
    })
}

/// A command with a short display name: the user reads `npm install -g <pkg>`, not the resolved path.
fn command(program: &Path, name: &str, args: &[&str], home: Option<&str>) -> ProviderCommand {
    ProviderCommand {
        executable: program.to_string_lossy().into_owned(),
        args: args.iter().map(|arg| (*arg).to_owned()).collect(),
        display: std::iter::once(name).chain(args.iter().copied()).collect::<Vec<_>>().join(" "),
        cwd: home.map(str::to_owned),
    }
}

/// True when the resolved shim belongs to the npm global prefix: the package's `package.json` sits
/// next to it (Windows) or one `../lib/node_modules` up (Unix). That is what decides npm vs vendor.
fn npm_managed(shim: &Path, package: &str) -> bool {
    let Some(directory) = shim.parent() else { return false };
    let package_path = |base: PathBuf| {
        package
            .split('/')
            .filter(|part| !part.is_empty())
            .fold(base, |path, part| path.join(part))
    };
    if package_path(directory.join("node_modules")).join("package.json").is_file() {
        return true;
    }
    #[cfg(not(windows))]
    if package_path(directory.join("..").join("lib").join("node_modules")).join("package.json").is_file() {
        return true;
    }
    false
}

/// What one recipe offers for one computer. Kept explicit (paths in, no environment reads) so every
/// branch can be unit-tested against temp directories.
struct Inputs<'a> {
    installed: bool,
    /// The resolved CLI, when it is installed.
    shim: Option<&'a Path>,
    npm: Option<&'a Path>,
    /// `winget`, only on Windows.
    winget: Option<&'a Path>,
    home: Option<&'a str>,
    /// Plugins: the CLI lives inside the plugin folder, so nothing was npm- or vendor-installed.
    plugin_owned: bool,
}

fn install_command(npm: Option<&Path>, package: &str, home: Option<&str>) -> Option<ProviderCommand> {
    let npm = npm?;
    Some(command(npm, "npm", &["install", "-g", package], home))
}

fn update_command(npm: Option<&Path>, package: &str, home: Option<&str>) -> Option<ProviderCommand> {
    let npm = npm?;
    let latest = format!("{package}@latest");
    Some(command(npm, "npm", &["install", "-g", &latest], home))
}

fn node_install(winget: Option<&Path>, home: Option<&str>) -> Option<ProviderCommand> {
    let winget = winget?;
    Some(command(
        winget,
        "winget",
        &["install", "--id", "OpenJS.NodeJS.LTS", "-e", "--source", "winget"],
        home,
    ))
}

fn setup(recipe: Option<&Recipe>, package: Option<&str>, inputs: &Inputs<'_>) -> ProviderSetup {
    let home = inputs.home;
    let mut setup = ProviderSetup {
        executable_path: inputs.shim.map(|path| path.to_string_lossy().into_owned()),
        ..ProviderSetup::default()
    };
    if inputs.installed {
        let source = if inputs.plugin_owned {
            "plugin"
        } else if inputs.shim.zip(package).is_some_and(|(shim, package)| npm_managed(shim, package)) {
            "npm"
        } else {
            "vendor"
        };
        setup.install_source = Some(source);
        setup.update = match source {
            "npm" => package.and_then(|package| update_command(inputs.npm, package, home)),
            "vendor" => match (recipe.and_then(|recipe| recipe.vendor_update), inputs.shim) {
                (Some(args), Some(shim)) => Some(command(shim, recipe_id(recipe), args, home)),
                _ => None,
            },
            _ => None,
        };
        return setup;
    }
    if let Some(package) = package {
        setup.install = install_command(inputs.npm, package, home);
        if setup.install.is_none() {
            setup.install_blocked = Some("node_missing");
            setup.node_install = node_install(inputs.winget, home);
        }
    }
    setup
}

fn recipe_id(recipe: Option<&Recipe>) -> &'static str {
    recipe.map(|recipe| recipe.id).unwrap_or_default()
}

/// A built-in agent's setup. Reads this computer's environment, so an agent installed a moment ago is
/// found on the next capability round without restarting ThreadTerm.
pub(crate) fn builtin_setup(id: &str, installed: bool) -> ProviderSetup {
    let recipe = recipe(id);
    let shim = common::find_executable(id);
    let npm = common::find_executable("npm");
    let winget = winget_executable();
    let home = home_directory();
    setup(
        recipe,
        recipe.and_then(|recipe| recipe.npm),
        &Inputs {
            installed,
            shim: shim.as_deref(),
            npm: npm.as_deref(),
            winget: winget.as_deref(),
            home: home.as_deref(),
            plugin_owned: false,
        },
    )
}

/// A plugin agent's setup: the manifest may declare an npm package, which the runtime turns into the
/// same verified command lines. `plugin_owned` is true when the CLI ships inside the plugin folder.
pub(crate) fn plugin_setup(package: Option<&str>, installed: bool, shim: Option<&Path>, plugin_owned: bool) -> ProviderSetup {
    let npm = common::find_executable("npm");
    let winget = winget_executable();
    let home = home_directory();
    setup(
        None,
        package,
        &Inputs {
            installed,
            shim,
            npm: npm.as_deref(),
            winget: winget.as_deref(),
            home: home.as_deref(),
            plugin_owned,
        },
    )
}

/// The command lines a plugin's install and update would run, shown to the user before it is enabled.
pub(crate) fn plugin_command_lines(package: &str) -> Vec<String> {
    let npm = common::find_executable("npm");
    let home = home_directory();
    [install_command(npm.as_deref(), package, home.as_deref()), update_command(npm.as_deref(), package, home.as_deref())]
        .into_iter()
        .flatten()
        .map(|command| command.display)
        .collect()
}

#[cfg(windows)]
fn winget_executable() -> Option<PathBuf> {
    common::find_executable("winget")
}

#[cfg(not(windows))]
fn winget_executable() -> Option<PathBuf> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("tt-install-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn touch(path: &Path) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, "").unwrap();
    }

    /// A shim plus the npm global layout that owns it.
    fn npm_layout(root: &Path, package: &str, windows_layout: bool) -> PathBuf {
        let bin = root.join("bin");
        let shim = bin.join("agent");
        touch(&shim);
        let base = if windows_layout {
            bin.join("node_modules")
        } else {
            bin.join("..").join("lib").join("node_modules")
        };
        let package_dir = package.split('/').fold(base, |path, part| path.join(part));
        touch(&package_dir.join("package.json"));
        shim
    }

    fn inputs<'a>(shim: Option<&'a Path>, npm: Option<&'a Path>, winget: Option<&'a Path>, home: &'a str) -> Inputs<'a> {
        Inputs { installed: shim.is_some(), shim, npm, winget, home: Some(home), plugin_owned: false }
    }

    #[test]
    fn every_verified_recipe_has_its_package_and_install_line() {
        let root = scratch("recipes");
        let npm = root.join("npm");
        touch(&npm);
        for (id, package) in [
            ("codex", "@openai/codex"),
            ("claude", "@anthropic-ai/claude-code"),
            ("opencode", "opencode-ai"),
            ("pi", "@earendil-works/pi-coding-agent"),
        ] {
            let recipe = recipe(id).unwrap();
            assert_eq!(recipe.npm, Some(package), "{id} package");
            let setup = setup(Some(recipe), recipe.npm, &inputs(None, Some(&npm), None, "/home/qa"));
            let install = setup.install.expect(id);
            assert_eq!(install.display, format!("npm install -g {package}"));
            assert_eq!(install.args, ["install", "-g", package]);
            assert_eq!(install.cwd.as_deref(), Some("/home/qa"));
            assert_eq!(setup.install_blocked, None);
            assert_eq!(setup.update, None, "not installed: nothing to update");
            assert_eq!(setup.executable_path, None);
        }
        assert_eq!(recipe("kimi").unwrap().npm, None, "Kimi has no verified Windows installer");
        assert_eq!(recipe("kimi").unwrap().vendor_update, None);
        assert_eq!(recipe("grok").unwrap().npm, None);
        assert!(recipe("gemini").is_none(), "Gemini is a plugin, not a built-in recipe");
    }

    #[test]
    fn a_missing_npm_blocks_installation_and_offers_node_first() {
        let root = scratch("node");
        let winget = root.join("winget");
        touch(&winget);
        let blocked = setup(recipe("codex"), Some("@openai/codex"), &inputs(None, None, Some(&winget), "/home/qa"));
        assert_eq!(blocked.install, None);
        assert_eq!(blocked.install_blocked, Some("node_missing"));
        let node = blocked.node_install.expect("winget is available");
        assert_eq!(node.display, "winget install --id OpenJS.NodeJS.LTS -e --source winget");
        assert_eq!(node.args, ["install", "--id", "OpenJS.NodeJS.LTS", "-e", "--source", "winget"]);
        assert!(node.executable.ends_with("winget"));
        assert_eq!(node.cwd.as_deref(), Some("/home/qa"));
        // Without winget there is no command; the row links to nodejs.org instead.
        let no_winget = setup(recipe("codex"), Some("@openai/codex"), &inputs(None, None, None, "/home/qa"));
        assert_eq!(no_winget.install_blocked, Some("node_missing"));
        assert_eq!(no_winget.node_install, None);
        // A recipe-less agent (Kimi) never looks like a Node.js problem.
        let kimi = setup(recipe("kimi"), None, &inputs(None, None, None, "/home/qa"));
        assert_eq!(kimi.install, None);
        assert_eq!(kimi.install_blocked, None);
    }

    #[test]
    fn an_installed_agent_reports_npm_or_vendor_from_both_global_layouts() {
        let root = scratch("source");
        let npm = root.join("npm");
        touch(&npm);
        // Windows resolves an npm shim one level from `<prefix>/node_modules`; Unix from
        // `<prefix>/bin` to `<prefix>/lib/node_modules`. Each is checked on its own platform.
        let mut layouts = vec![(true, "windows")];
        if cfg!(not(windows)) {
            layouts.push((false, "unix"));
        }
        for (windows_layout, label) in layouts {
            let shim = npm_layout(&root.join(format!("layout-{label}")), "@openai/codex", windows_layout);
            let setup = setup(recipe("codex"), Some("@openai/codex"), &inputs(Some(&shim), Some(&npm), None, "/home/qa"));
            assert_eq!(setup.install_source, Some("npm"), "{}", shim.display());
            assert_eq!(setup.install, None, "installed: no install button");
            let update = setup.update.expect("npm can update its own install");
            assert_eq!(update.display, "npm install -g @openai/codex@latest");
            assert_eq!(update.args, ["install", "-g", "@openai/codex@latest"]);
            assert_eq!(setup.executable_path.as_deref(), Some(shim.to_string_lossy().as_ref()));
        }
        // A vendor binary that npm does not own: Claude updates itself, Codex offers nothing.
        let vendor = root.join("vendor-codex");
        touch(&vendor);
        let codex = setup(recipe("codex"), Some("@openai/codex"), &inputs(Some(&vendor), Some(&npm), None, "/home/qa"));
        assert_eq!(codex.install_source, Some("vendor"));
        assert_eq!(codex.update, None);
        // Grok and Claude update through their own CLI, using the resolved executable.
        for (id, package, name) in [("grok", None, "grok"), ("claude", Some("@anthropic-ai/claude-code"), "claude")] {
            let binary = root.join(format!("vendor-{id}")).join(name);
            touch(&binary);
            let built = setup(recipe(id), package, &inputs(Some(&binary), Some(&npm), None, "/home/qa"));
            assert_eq!(built.install_source, Some("vendor"), "{id}");
            let update = built.update.expect(id);
            assert_eq!(update.display, format!("{name} update"));
            assert_eq!(update.args, ["update"]);
            assert_eq!(update.executable, binary.to_string_lossy());
        }
        // npm missing but installed: no npm update is offered, and nothing is blocked.
        let shim = npm_layout(&root.join("no-npm"), "@openai/codex", true);
        let without_npm = setup(recipe("codex"), Some("@openai/codex"), &inputs(Some(&shim), None, None, "/home/qa"));
        assert_eq!(without_npm.install_source, Some("npm"));
        assert_eq!(without_npm.update, None);
        assert_eq!(without_npm.install_blocked, None);
    }

    #[test]
    fn a_plugin_may_declare_only_a_valid_npm_package() {
        for valid in ["@google/gemini-cli", "@openai/codex", "opencode-ai", "pi.coding-agent", "a"] {
            assert!(valid_npm_package(valid), "{valid} should be accepted");
        }
        let long = "a".repeat(215);
        for invalid in ["", "@google", "@google/", "@/gemini", "Gemini", "gemini cli", "gemini;rm -rf /", "gemini\ncli", "$(whoami)", "@Google/Gemini", "-leading", long.as_str()] {
            assert!(!valid_npm_package(invalid), "{invalid:?} should be rejected");
        }
        let root = scratch("plugin");
        let npm = root.join("npm");
        touch(&npm);
        let installable = setup(None, Some("@google/gemini-cli"), &inputs(None, Some(&npm), None, "/home/qa"));
        assert_eq!(installable.install.expect("plugin install").display, "npm install -g @google/gemini-cli");
        // A CLI shipped inside the plugin folder is neither npm- nor vendor-installed.
        let plugin_bin = root.join("plugin").join("gemini");
        touch(&plugin_bin);
        let owned = super::setup(
            None,
            Some("@google/gemini-cli"),
            &Inputs { installed: true, shim: Some(&plugin_bin), npm: Some(&npm), winget: None, home: Some("/home/qa"), plugin_owned: true },
        );
        assert_eq!(owned.install_source, Some("plugin"));
        assert_eq!(owned.update, None, "a plugin's own CLI is updated with the plugin");
    }

    #[test]
    fn setup_serialises_as_camel_case_and_omits_absent_fields() {
        assert_eq!(serde_json::to_value(ProviderSetup::default()).unwrap(), serde_json::json!({}), "an agent with no recipe adds no fields");
        let root = scratch("json");
        let shim = npm_layout(&root, "@openai/codex", true);
        let installed = super::setup(
            recipe("codex"),
            Some("@openai/codex"),
            &Inputs { installed: true, shim: Some(&shim), npm: None, winget: None, home: Some("/home/qa"), plugin_owned: false },
        );
        let value = serde_json::to_value(&installed).unwrap();
        assert_eq!(value["installSource"], "npm");
        assert_eq!(value["update"], serde_json::Value::Null, "no npm, so no update command");
        assert!(value["executablePath"].as_str().is_some_and(|path| path.ends_with("agent")));
        assert!(value.get("install").is_none());
        assert!(value.get("installBlocked").is_none());
        assert!(value.get("nodeInstall").is_none());
        let blocked = super::setup(recipe("codex"), Some("@openai/codex"), &inputs(None, None, None, "/home/qa"));
        let value = serde_json::to_value(&blocked).unwrap();
        assert_eq!(value["installBlocked"], "node_missing");
        assert_eq!(value["install"], serde_json::Value::Null);
        assert!(value.get("executablePath").is_none());
    }
}
