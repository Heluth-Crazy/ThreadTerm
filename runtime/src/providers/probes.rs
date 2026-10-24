//! Small, reusable provider probes. These are demand-driven: callers opt in
//! when a feature needs an answer, and the result is retained until provider
//! refresh invalidates it.

use super::common::{command_output, find_executable, CommandSpec};
use std::{collections::HashMap, path::PathBuf, sync::Mutex, time::Duration};

const PI_PROBE: &str = "pi.tool_allowlist";
const PI_READ_ONLY_NOTE: &str =
    "This Pi version has no tool allowlist — update Pi to enforce read-only.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ReadOnlyProbe {
    pub supported: bool,
    pub note: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct ProbeKey {
    provider: String,
    executable: String,
    version: String,
    id: &'static str,
}

/// Kept by `Providers`, alongside its capability cache. The full key lets a
/// future compatibility UI share these facts without assuming a CLI version.
#[derive(Default)]
pub(crate) struct ProviderProbeCache {
    values: HashMap<ProbeKey, ReadOnlyProbe>,
}

impl ProviderProbeCache {
    fn get(&self, key: &ProbeKey) -> Option<ReadOnlyProbe> {
        self.values.get(key).cloned()
    }

    fn insert(&mut self, key: ProbeKey, value: ReadOnlyProbe) {
        self.values.insert(key, value);
    }

    pub(crate) fn clear(&mut self) {
        self.values.clear();
    }
}

/// The mutex deliberately covers the bounded probe, so simultaneous room opens
/// share one process instead of probing once per seat.
pub(crate) fn pi_read_only_probe(
    cache: &Mutex<ProviderProbeCache>,
    version: Option<&str>,
) -> ReadOnlyProbe {
    let Some(version) = version.filter(|version| !version.is_empty()) else {
        return unavailable(
            "Pi version has not been detected. Refresh providers before enforcing read-only.",
        );
    };
    let Some(executable) = find_executable("pi") else {
        return unavailable("Pi is not installed. Install the Pi CLI, then refresh providers.");
    };
    let executable = executable.to_string_lossy().into_owned();
    let key = ProbeKey {
        provider: "pi".to_owned(),
        executable,
        version: version.to_owned(),
        id: PI_PROBE,
    };
    let Ok(mut cache) = cache.lock() else {
        return unavailable(
            "Pi capability detection is unavailable. Refresh providers and try again.",
        );
    };
    if let Some(value) = cache.get(&key) {
        return value;
    }

    let value = probe_pi(PathBuf::from(&key.executable));
    cache.insert(key, value.clone());
    value
}

fn probe_pi(executable: PathBuf) -> ReadOnlyProbe {
    let help = CommandSpec::from_path(executable, vec!["--help".to_owned()])
        .and_then(|spec| command_output(&spec, Duration::from_secs(5)));
    pi_help_result(help.as_deref().ok())
}

fn pi_help_result(help: Option<&str>) -> ReadOnlyProbe {
    let supported = help.is_some_and(|text| {
        ["--tools", "--no-mcp", "--no-extensions"]
            .iter()
            .all(|flag| contains_flag(text, flag))
    });
    let note = if supported {
        "Pi tool allowlist verified for this installed CLI.".to_owned()
    } else {
        PI_READ_ONLY_NOTE.to_owned()
    };
    ReadOnlyProbe { supported, note }
}

fn unavailable(note: &str) -> ReadOnlyProbe {
    ReadOnlyProbe {
        supported: false,
        note: note.to_owned(),
    }
}

fn contains_flag(text: &str, wanted: &str) -> bool {
    text.split_ascii_whitespace().any(|part| {
        part.trim_matches(|character: char| !character.is_ascii_alphanumeric() && character != '-')
            == wanted
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pi_requires_every_read_only_flag() {
        let missing_tools = "Usage: pi\n  --no-mcp\n  --no-extensions\n";
        let missing = pi_help_result(Some(missing_tools));
        assert!(!missing.supported);
        assert_eq!(missing.note, PI_READ_ONLY_NOTE);
        let complete = "  --tools, -t <tools>\n  --no-mcp\n  --no-extensions\n";
        assert!(pi_help_result(Some(complete)).supported);
        assert!(!pi_help_result(None).supported);
    }

    #[test]
    fn cache_key_changes_with_executable_or_version() {
        let mut cache = ProviderProbeCache::default();
        let first = ProbeKey {
            provider: "pi".to_owned(),
            executable: "first-pi".to_owned(),
            version: "version-a".to_owned(),
            id: PI_PROBE,
        };
        cache.insert(
            first.clone(),
            ReadOnlyProbe {
                supported: true,
                note: "verified".to_owned(),
            },
        );
        assert!(cache.get(&first).is_some());
        let changed_version = ProbeKey {
            version: "version-b".to_owned(),
            ..first.clone()
        };
        let changed_executable = ProbeKey {
            executable: "second-pi".to_owned(),
            ..first
        };
        assert!(cache.get(&changed_version).is_none());
        assert!(cache.get(&changed_executable).is_none());
    }
}
