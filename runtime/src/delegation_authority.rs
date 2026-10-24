//! One provider-neutral authority order for delegation (F07).
//!
//! Providers name their permission modes differently; delegation needs one
//! order to compare a parent's ceiling with what a child can be made to do.
//! The envelope is only about how much authority an agent may exercise, not
//! about which labels a provider displays.
//!
//! A mode this runtime cannot place never widens anything: for a parent it
//! counts as the least permissive level (so the ceiling is low), for a child as
//! the most permissive one (so an unplaceable child cannot fit under a
//! restrictive parent). Such a pair needs the user's explicit widening.
use serde_json::Value;

/// What an agent may do without asking the user again, weakest first.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Authority {
    /// May read; cannot change files or run commands.
    ReadOnly,
    /// Can change files, but each change goes through an approval.
    AskBeforeWrites,
    /// Changes files in its folder without asking; no wider reach.
    WritesInWorkspace,
    /// No prompts left; the process may do whatever the user's OS allows.
    FullAccess,
}

impl Authority {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::ReadOnly => "read_only",
            Self::AskBeforeWrites => "ask_before_writes",
            Self::WritesInWorkspace => "writes_in_workspace",
            Self::FullAccess => "full_access",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "read_only" => Some(Self::ReadOnly),
            "ask_before_writes" => Some(Self::AskBeforeWrites),
            "writes_in_workspace" => Some(Self::WritesInWorkspace),
            "full_access" => Some(Self::FullAccess),
            _ => None,
        }
    }
}

/// One startup choice that produces a known authority. `rows` are the native
/// option selections the child starts with (`&[]` keeps its own default).
pub(crate) struct Rung {
    pub rows: &'static [(&'static str, &'static str)],
    pub authority: Authority,
}

const PI_READ_ONLY_TOOLS: &str = "read,grep,find,ls";

/// The closest thing every parent provider does by default: ask first. Used
/// when a parent has not saved a permission choice yet, so an existing Chat
/// that never changed its modes keeps delegating as it did before F07.
fn provider_default() -> Authority {
    Authority::AskBeforeWrites
}

fn option<'a>(saved: &'a Value, id: &str) -> Option<&'a str> {
    saved
        .as_array()
        .into_iter()
        .flatten()
        .find(|row| row.get("id").and_then(Value::as_str) == Some(id))
        .and_then(|row| row.get("value"))
        .and_then(Value::as_str)
}

/// The parent's ceiling, from the permission choices its Chat saved.
pub(crate) fn parent_envelope(provider: &str, saved: &Value) -> Authority {
    match provider {
        "codex" => match option(saved, "sandbox") {
            Some("read-only") => Authority::ReadOnly,
            // `never` means no approval prompts: the sandbox alone bounds it.
            Some("workspace-write") if option(saved, "mode") == Some("never") => {
                Authority::WritesInWorkspace
            }
            Some("danger-full-access") if option(saved, "mode") == Some("never") => {
                Authority::FullAccess
            }
            Some("workspace-write" | "danger-full-access") => Authority::AskBeforeWrites,
            Some(_) => Authority::ReadOnly,
            None => provider_default(),
        },
        "claude" | "kimi" | "grok" => match option(saved, "mode") {
            Some("plan") => Authority::ReadOnly,
            Some("default") => Authority::AskBeforeWrites,
            Some("acceptEdits") => Authority::WritesInWorkspace,
            // Modes that stop asking. `auto` has no derivable meaning here, so
            // it stays with the unplaceable values below.
            Some("dontAsk" | "bypassPermissions" | "yolo") => Authority::FullAccess,
            Some(_) => Authority::ReadOnly,
            None => provider_default(),
        },
        // A parent provider this runtime cannot place: read-only.
        _ => Authority::ReadOnly,
    }
}

/// The child's choices, weakest first. A provider whose authority cannot be
/// narrowed offers only the level it already has.
pub(crate) fn child_rungs(provider: &str, pi_read_only_tools: bool) -> Vec<Rung> {
    match provider {
        "claude" => vec![
            Rung { rows: &[("mode", "plan")], authority: Authority::ReadOnly },
            Rung { rows: &[("mode", "default")], authority: Authority::AskBeforeWrites },
            Rung { rows: &[("mode", "acceptEdits")], authority: Authority::WritesInWorkspace },
            Rung { rows: &[("mode", "dontAsk")], authority: Authority::FullAccess },
        ],
        "codex" => vec![
            Rung {
                rows: &[("mode", "never"), ("sandbox", "read-only")],
                authority: Authority::ReadOnly,
            },
            Rung {
                rows: &[("mode", "on-request"), ("sandbox", "workspace-write")],
                authority: Authority::AskBeforeWrites,
            },
            Rung {
                rows: &[("mode", "never"), ("sandbox", "workspace-write")],
                authority: Authority::WritesInWorkspace,
            },
            Rung {
                rows: &[("mode", "never"), ("sandbox", "danger-full-access")],
                authority: Authority::FullAccess,
            },
        ],
        "kimi" => vec![
            Rung { rows: &[("mode", "plan")], authority: Authority::ReadOnly },
            Rung { rows: &[("mode", "default")], authority: Authority::AskBeforeWrites },
            Rung { rows: &[("mode", "yolo")], authority: Authority::FullAccess },
        ],
        "grok" => vec![
            Rung { rows: &[("mode", "plan")], authority: Authority::ReadOnly },
            Rung { rows: &[("mode", "default")], authority: Authority::AskBeforeWrites },
            Rung { rows: &[("mode", "acceptEdits")], authority: Authority::WritesInWorkspace },
            Rung { rows: &[("mode", "dontAsk")], authority: Authority::FullAccess },
        ],
        // Pi has no approval channel: only its verified read-only tool
        // allowlist bounds it (read,grep,find,ls), otherwise it is unbounded.
        "pi" => {
            if pi_read_only_tools {
                vec![Rung {
                    rows: &[("roundtable-tools", PI_READ_ONLY_TOOLS)],
                    authority: Authority::ReadOnly,
                }]
            } else {
                vec![Rung { rows: &[], authority: Authority::FullAccess }]
            }
        }
        // OpenCode and plugin agents own their permission configuration, so the
        // runtime cannot tell how far they would go: treat them as unbounded.
        _ => vec![Rung { rows: &[], authority: Authority::FullAccess }],
    }
}

/// The strongest child choice that stays within the parent's ceiling.
pub(crate) fn fit(parent: Authority, rungs: &[Rung]) -> Option<&Rung> {
    rungs.iter().filter(|rung| rung.authority <= parent).max_by_key(|rung| rung.authority)
}

/// The authority a child would have if the user let it use its own defaults.
pub(crate) fn widest(rungs: &[Rung]) -> Authority {
    rungs.iter().map(|rung| rung.authority).max().unwrap_or(Authority::FullAccess)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rows(pairs: &[(&str, &str)]) -> Value {
        json!(pairs
            .iter()
            .map(|(id, value)| json!({"id":id,"value":value}))
            .collect::<Vec<_>>())
    }

    #[test]
    fn parent_modes_map_to_one_order_and_unplaceable_modes_never_widen() {
        assert_eq!(parent_envelope("claude", &rows(&[("mode", "plan")])), Authority::ReadOnly);
        assert_eq!(parent_envelope("claude", &rows(&[("mode", "default")])), Authority::AskBeforeWrites);
        assert_eq!(parent_envelope("claude", &rows(&[("mode", "acceptEdits")])), Authority::WritesInWorkspace);
        assert_eq!(parent_envelope("claude", &rows(&[("mode", "dontAsk")])), Authority::FullAccess);
        assert_eq!(parent_envelope("kimi", &rows(&[("mode", "yolo")])), Authority::FullAccess);
        assert_eq!(parent_envelope("grok", &rows(&[("mode", "bypassPermissions")])), Authority::FullAccess);
        assert_eq!(
            parent_envelope("codex", &rows(&[("sandbox", "workspace-write"), ("mode", "on-request")])),
            Authority::AskBeforeWrites
        );
        assert_eq!(
            parent_envelope("codex", &rows(&[("sandbox", "workspace-write"), ("mode", "never")])),
            Authority::WritesInWorkspace
        );
        assert_eq!(
            parent_envelope("codex", &rows(&[("sandbox", "danger-full-access"), ("mode", "never")])),
            Authority::FullAccess
        );
        assert_eq!(parent_envelope("codex", &rows(&[("sandbox", "read-only")])), Authority::ReadOnly);
        // A value this runtime cannot place counts as the least permissive level.
        for saved in [rows(&[("mode", "auto")]), rows(&[("mode", "sideways")])] {
            assert_eq!(parent_envelope("claude", &saved), Authority::ReadOnly, "{saved}");
        }
        assert_eq!(
            parent_envelope("codex", &rows(&[("sandbox", "retry"), ("mode", "never")])),
            Authority::ReadOnly
        );
        // No saved choice yet: the provider's ordinary default, which asks.
        assert_eq!(parent_envelope("claude", &json!([])), Authority::AskBeforeWrites);
        assert_eq!(parent_envelope("opencode", &json!([])), Authority::ReadOnly);
    }

    #[test]
    fn a_restrictive_parent_gets_a_narrower_child_and_a_wider_child_is_refused() {
        let claude = child_rungs("claude", false);
        assert_eq!(fit(Authority::ReadOnly, &claude).unwrap().authority, Authority::ReadOnly);
        assert_eq!(fit(Authority::AskBeforeWrites, &claude).unwrap().authority, Authority::AskBeforeWrites);
        assert_eq!(
            fit(Authority::WritesInWorkspace, &claude).unwrap().authority,
            Authority::WritesInWorkspace
        );
        assert_eq!(fit(Authority::FullAccess, &claude).unwrap().authority, Authority::FullAccess);
        // Pi without its verified tool allowlist has no approval channel.
        let pi = child_rungs("pi", false);
        assert!(fit(Authority::WritesInWorkspace, &pi).is_none());
        assert_eq!(fit(Authority::FullAccess, &pi).unwrap().authority, Authority::FullAccess);
        assert_eq!(widest(&pi), Authority::FullAccess);
        // ... and with it, Pi can only ever be read-only.
        let pi_read_only = child_rungs("pi", true);
        assert_eq!(fit(Authority::AskBeforeWrites, &pi_read_only).unwrap().authority, Authority::ReadOnly);
        assert_eq!(widest(&pi_read_only), Authority::ReadOnly);
        // A provider the runtime cannot narrow offers only full access.
        let unknown = child_rungs("some-plugin", false);
        assert!(fit(Authority::WritesInWorkspace, &unknown).is_none());
        assert_eq!(fit(Authority::FullAccess, &unknown).unwrap().rows.len(), 0);
    }

    #[test]
    fn the_fitted_child_mode_is_the_strongest_that_stays_under_the_parent() {
        let codex = child_rungs("codex", false);
        assert_eq!(
            fit(Authority::AskBeforeWrites, &codex).unwrap().rows,
            &[("mode", "on-request"), ("sandbox", "workspace-write")]
        );
        assert_eq!(
            fit(Authority::WritesInWorkspace, &codex).unwrap().rows,
            &[("mode", "never"), ("sandbox", "workspace-write")]
        );
        let grok = child_rungs("grok", false);
        assert_eq!(
            fit(Authority::WritesInWorkspace, &grok).unwrap().rows,
            &[("mode", "acceptEdits")]
        );
        let kimi = child_rungs("kimi", false);
        // Kimi has no workspace-write rung, so `default` (asking) is the fit.
        assert_eq!(fit(Authority::WritesInWorkspace, &kimi).unwrap().rows, &[("mode", "default")]);
    }
}
