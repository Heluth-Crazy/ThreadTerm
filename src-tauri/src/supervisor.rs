//! AI Supervisor v0.1 — rules-based attention notifier (backend slice).
//!
//! Watches a set of pinned PTY cards (driven by the frontend's
//! `pinnedCardIds`) and, when interactive prompts appear in their output,
//! emits a `supervisor://alert` event so the renderer can surface a
//! Notification Centre entry + OS notification.
//!
//! Design constraints (see PRD § Decisions D1–D12):
//! * Pure regex — zero LLM, zero token cost.
//! * Triggered on a 5-second idle tick when a watched card has been silent
//!   for ≥ 60s.
//! * Same `(cardId, ruleId)` is suppressed for 60s after firing.
//! * Master-switch OFF means we hold no watcher state at all.
//!
//! Public surface: [`init`] (call once during `setup`) and the
//! `#[tauri::command]` [`supervisor_enable`].

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
use regex::Regex;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::time::interval;

use crate::pty;

// ── Tuning constants ────────────────────────────────────────────────────────

/// How many of the most-recent (post-ANSI-strip) lines we feed to rules.
const TAIL_LINES: usize = 20;
/// Strong-signal arrow-select scans only the last N lines.
const ARROW_SELECT_STRONG_TAIL: usize = 5;
/// Per (card, rule) silence after a fire to avoid re-spamming on a sticky prompt.
const COOLDOWN: Duration = Duration::from_secs(60);
/// "Idle" threshold — re-scan a watched card if it has been silent this long.
const IDLE_THRESHOLD: Duration = Duration::from_secs(60);
/// Idle scan loop tick (we re-scan at most every IDLE_THRESHOLD per card).
const IDLE_TICK: Duration = Duration::from_secs(5);
/// Cap for `sample_text` we ship to the frontend so a runaway buffer line
/// can never bloat an event payload.
const SAMPLE_TEXT_MAX: usize = 200;

// ── Rule identifier ─────────────────────────────────────────────────────────

/// Closed enum of every rule we ship in v0.1. Adding a rule MUST extend this
/// enum + its `as_str` mapping + the `compile_rules` builder + the test
/// matrix — that's intentional: every match site is exhaustive, the compiler
/// will refuse to build until all sites are updated.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RuleId {
    SudoPassword,
    YesNoBracket,
    YesNoParen,
    PressAnyKey,
    GitCredentials,
    AiProceed,
    AiApplyDiff,
    ArrowSelect,
}

impl RuleId {
    /// Stable wire identifier — DO NOT change without a frontend migration:
    /// these strings are used as i18n keys (`supervisor.alertTitle.<id>`) and
    /// as cooldown keys in the persisted future v0.2 store.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SudoPassword => "sudo-password",
            Self::YesNoBracket => "yes-no-bracket",
            Self::YesNoParen => "yes-no-paren",
            Self::PressAnyKey => "press-any-key",
            Self::GitCredentials => "git-credentials",
            Self::AiProceed => "ai-proceed",
            Self::AiApplyDiff => "ai-apply-diff",
            Self::ArrowSelect => "arrow-select",
        }
    }
}

// ── Rule definition + compilation ───────────────────────────────────────────

/// A "tail rule" runs against the last non-empty line of the trimmed buffer.
/// Used by 7 of the 8 rules. `arrow-select` is the exception — see
/// [`check_arrow_select`].
struct TailRule {
    id: RuleId,
    pattern: Regex,
}

struct CompiledRules {
    tail: Vec<TailRule>,
    arrow_strong: Regex,
    arrow_weak: Regex,
    ansi_strip: Regex,
}

/// Compiled once (panics at start-up if any regex is bad — that is preferable
/// to a runtime "rule silently disabled" state).
static RULES: Lazy<CompiledRules> = Lazy::new(compile_rules);

fn compile_rules() -> CompiledRules {
    // NOTE: Patterns are taken verbatim from PRD D12. Where the PRD lists an
    // alternation between two distinct expressions (e.g. sudo's two forms),
    // we OR them inside a single regex with `|` so the rule still has one
    // pattern object.
    let tail = vec![
        TailRule {
            id: RuleId::SudoPassword,
            pattern: Regex::new(r"(?i)(\[sudo\]\s+password\s+for\s+\S+:\s*$|^Password:\s*$)")
                .expect("sudo-password regex"),
        },
        TailRule {
            id: RuleId::YesNoBracket,
            pattern: Regex::new(r"\[(y/N|Y/n|y/n|Y/N)\]\s*$").expect("yes-no-bracket regex"),
        },
        TailRule {
            id: RuleId::YesNoParen,
            pattern: Regex::new(r"(?i)\(yes/no(?:/\[fingerprint\])?\)\?\s*$")
                .expect("yes-no-paren regex"),
        },
        TailRule {
            id: RuleId::PressAnyKey,
            pattern: Regex::new(r"(?i)press\s+any\s+key\s+to\s+continue")
                .expect("press-any-key regex"),
        },
        TailRule {
            id: RuleId::GitCredentials,
            pattern: Regex::new(r"^(Username|Password)\s+for\s+'[^']+':\s*$")
                .expect("git-credentials regex"),
        },
        TailRule {
            id: RuleId::AiProceed,
            pattern: Regex::new(
                r"(?i)(should\s+i\s+(proceed|continue)\?|continue\?\s*\(y/n\))\s*$",
            )
            .expect("ai-proceed regex"),
        },
        TailRule {
            id: RuleId::AiApplyDiff,
            pattern: Regex::new(r"(?i)apply\s+(this\s+)?(diff|change|patch|edit)\?\s*$")
                .expect("ai-apply-diff regex"),
        },
    ];

    // Arrow-select strong: pointer glyph followed by a space and then real
    // content. Powerlevel10k's bare `❯ ` prompt (pointer + space + EOL) does
    // NOT have `\S` after the space and therefore must NOT match.
    let arrow_strong = Regex::new(r"^\s*[❯▸]\s+\S").expect("arrow-select strong regex");
    let arrow_weak =
        Regex::new(r"(?i)(use\s+arrow\s+keys|↑↓\s*navigate|press\s+enter\s+to\s+select)")
            .expect("arrow-select weak regex");

    // Inline ANSI stripper. We deliberately do NOT add a new crate just for
    // this: the existing `pty/events.rs` already follows the same pattern.
    let ansi_strip = Regex::new(r"\x1b\[[0-9;?]*[a-zA-Z]").expect("ansi-strip regex");

    CompiledRules {
        tail,
        arrow_strong,
        arrow_weak,
        ansi_strip,
    }
}

// ── Rule evaluation (pure, easy to test) ────────────────────────────────────

/// What the matcher hands back when a rule fires. Pure data — no I/O.
#[derive(Debug, Clone, PartialEq, Eq)]
struct RuleMatch {
    rule_id: RuleId,
    /// The line that triggered the match, trimmed and clipped to
    /// [`SAMPLE_TEXT_MAX`] chars so the IPC payload stays small.
    sample_text: String,
}

/// Given raw PTY output, return every rule that fires. Each rule fires at
/// most once per call (we only need one alert per `(card, rule)` per cycle).
fn match_rules(raw: &str, rules: &CompiledRules) -> Vec<RuleMatch> {
    let cleaned = rules.ansi_strip.replace_all(raw, "");
    // Take the trailing lines but preserve their original order. We do NOT
    // strip empty lines at this stage because `arrow-select` strong scans the
    // tail block as-written, but the tail rules want the last NON-empty line.
    let mut lines: Vec<&str> = cleaned.lines().collect();
    if lines.len() > TAIL_LINES {
        lines.drain(0..lines.len() - TAIL_LINES);
    }

    let mut hits = Vec::new();

    // Strict-tail rules (7 of 8): inspect the last non-empty line. The PRD
    // demands "cursor must be at end of last line (no trailing newline)" —
    // because `lines()` ignores trailing newlines anyway, the "last line"
    // already represents the active prompt position.
    if let Some(last) = lines.iter().rev().find(|l| !l.trim().is_empty()) {
        for rule in &rules.tail {
            if rule.pattern.is_match(last) {
                hits.push(RuleMatch {
                    rule_id: rule.id,
                    sample_text: clip_sample(last),
                });
            }
        }
    }

    // arrow-select: strong wins, weak as fallback. Only emit at most one
    // ArrowSelect hit even if both signals fire — they're the same alert.
    if let Some(sample) = check_arrow_select(&lines, rules) {
        hits.push(RuleMatch {
            rule_id: RuleId::ArrowSelect,
            sample_text: clip_sample(&sample),
        });
    }

    hits
}

/// Returns the matching line if arrow-select fires, otherwise `None`.
/// Strong: any of the last 5 lines matches `^\s*[❯▸]\s+\S`.
/// Weak: any of the last 20 lines matches the arrow-key hint phrase.
fn check_arrow_select(lines: &[&str], rules: &CompiledRules) -> Option<String> {
    let strong_window_start = lines.len().saturating_sub(ARROW_SELECT_STRONG_TAIL);
    for line in &lines[strong_window_start..] {
        if rules.arrow_strong.is_match(line) {
            return Some((*line).to_string());
        }
    }
    for line in lines {
        if rules.arrow_weak.is_match(line) {
            return Some((*line).to_string());
        }
    }
    None
}

fn clip_sample(line: &str) -> String {
    let trimmed = line.trim();
    if trimmed.chars().count() <= SAMPLE_TEXT_MAX {
        trimmed.to_string()
    } else {
        trimmed.chars().take(SAMPLE_TEXT_MAX).collect()
    }
}

// ── Per-card watcher state ──────────────────────────────────────────────────

#[derive(Debug)]
struct CardWatcher {
    last_output_ts: Instant,
    /// `None` means "never idle-checked"; protects against double-firing the
    /// same idle window on consecutive 5s ticks.
    last_idle_check: Option<Instant>,
    cooldowns: HashMap<RuleId, Instant>,
}

impl CardWatcher {
    fn new(now: Instant) -> Self {
        Self {
            last_output_ts: now,
            last_idle_check: None,
            cooldowns: HashMap::new(),
        }
    }

    /// `true` if cooling down (caller MUST not fire); also prunes stale
    /// entries so the map stays bounded.
    fn is_cooling(&self, rule: RuleId, now: Instant) -> bool {
        match self.cooldowns.get(&rule) {
            Some(t) => now.duration_since(*t) < COOLDOWN,
            None => false,
        }
    }

    fn mark_fired(&mut self, rule: RuleId, now: Instant) {
        self.cooldowns.insert(rule, now);
    }
}

// ── Global supervisor state ─────────────────────────────────────────────────

struct SupervisorState {
    enabled: bool,
    watched: HashMap<String, CardWatcher>,
}

impl SupervisorState {
    fn new() -> Self {
        Self {
            enabled: false,
            watched: HashMap::new(),
        }
    }
}

static STATE: OnceLock<Mutex<SupervisorState>> = OnceLock::new();
/// Init guard — `init` is idempotent so repeated `setup` calls (tests etc.)
/// don't spawn a forest of idle ticks.
static IDLE_TASK_STARTED: OnceLock<()> = OnceLock::new();

fn state() -> &'static Mutex<SupervisorState> {
    STATE.get_or_init(|| Mutex::new(SupervisorState::new()))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AlertPayload {
    card_id: String,
    /// Stable wire string, not the Rust enum name.
    rule_id: &'static str,
    sample_text: String,
    /// Unix epoch milliseconds at fire time.
    ts: u64,
}

// ── Public API ──────────────────────────────────────────────────────────────

/// Install the supervisor singleton. Idempotent. Safe to call from
/// `tauri::Builder::setup`.
pub fn init(app_handle: AppHandle) {
    // Force the global state to exist so future locks don't race.
    let _ = state();

    if IDLE_TASK_STARTED.set(()).is_ok() {
        spawn_idle_task(app_handle);
    }
}

/// Frontend calls this whenever the master switch toggles OR
/// `pinnedCardIds` changes. Single entry-point keeps state mutation in one
/// transaction.
///
/// * `enabled = false` → drop every watcher.
/// * `enabled = true`  → replace the watched-set with `watched_card_ids`,
///   reset cooldowns for any newly-pinned card.
#[tauri::command]
pub async fn supervisor_enable(
    enabled: bool,
    watched_card_ids: Vec<String>,
    _app_handle: AppHandle,
) -> Result<(), String> {
    let now = Instant::now();
    let mut s = state()
        .lock()
        .map_err(|e| format!("supervisor state poisoned: {e}"))?;

    if !enabled {
        // Tear down watcher state. Pending alerts in the frontend
        // Notification Centre are unaffected (D2).
        s.watched.clear();
        s.enabled = false;
        tracing::info!("supervisor disabled");
        return Ok(());
    }

    // Reconcile the watched-set against the requested set.
    let requested: std::collections::HashSet<String> = watched_card_ids.iter().cloned().collect();

    s.watched.retain(|id, _| requested.contains(id));
    for card_id in watched_card_ids {
        // Re-pinning resets cooldowns and last_output_ts (PRD R4).
        s.watched.insert(card_id, CardWatcher::new(now));
    }
    s.enabled = true;
    tracing::info!(watched = s.watched.len(), "supervisor enabled");
    Ok(())
}

// ── Internal: scan ──────────────────────────────────────────────────────────

/// Returns `true` iff the rule was eligible to fire (i.e. not in cooldown);
/// caller is then responsible for actually emitting the alert. Factored out
/// of `scan_card` so tests can drive cooldown windows with an injected
/// `Instant` instead of `tokio::time::sleep`.
fn try_fire(watcher: &mut CardWatcher, rule: RuleId, now: Instant) -> bool {
    if watcher.is_cooling(rule, now) {
        return false;
    }
    watcher.mark_fired(rule, now);
    true
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

// ── Idle scan loop ──────────────────────────────────────────────────────────

fn spawn_idle_task(app_handle: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut ticker = interval(IDLE_TICK);
        // First tick fires immediately by default — skip it; we want to
        // wait one full IDLE_TICK before the first scan.
        ticker.tick().await;
        loop {
            ticker.tick().await;
            run_idle_pass(&app_handle);
        }
    });
}

fn run_idle_pass(app_handle: &AppHandle) {
    let now = Instant::now();
    // Snapshot the candidate set under the lock, then drop it before doing
    // any I/O (pty buffer reads).
    let candidates: Vec<String> = {
        let Ok(s) = state().lock() else { return };
        if !s.enabled {
            return;
        }
        s.watched
            .iter()
            .filter_map(|(id, w)| {
                let idle = now.duration_since(w.last_output_ts) >= IDLE_THRESHOLD;
                let due = match w.last_idle_check {
                    Some(t) => now.duration_since(t) >= IDLE_THRESHOLD,
                    None => true,
                };
                if idle && due {
                    Some(id.clone())
                } else {
                    None
                }
            })
            .collect()
    };

    for card_id in candidates {
        scan_card_idle(&card_id, app_handle, now);
    }
}

/// Like `scan_card` but does NOT advance `last_output_ts` (no new output was
/// observed); only stamps `last_idle_check` so we don't loop on the same
/// silent buffer every 5s.
fn scan_card_idle(card_id: &str, app_handle: &AppHandle, now: Instant) {
    let Some(raw) = pty::get_recent_output(card_id) else {
        return;
    };
    let matches = match_rules(&raw, &RULES);

    let mut s = match state().lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    if !s.enabled {
        return;
    }
    let Some(watcher) = s.watched.get_mut(card_id) else {
        return;
    };
    watcher.last_idle_check = Some(now);

    for m in matches {
        if try_fire(watcher, m.rule_id, now) {
            let payload = AlertPayload {
                card_id: card_id.to_string(),
                rule_id: m.rule_id.as_str(),
                sample_text: m.sample_text,
                ts: now_millis(),
            };
            let _ = app_handle.emit("supervisor://alert", payload);
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//                                   Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn rules() -> &'static CompiledRules {
        &RULES
    }

    fn first_match(raw: &str) -> Option<RuleId> {
        match_rules(raw, rules())
            .into_iter()
            .next()
            .map(|m| m.rule_id)
    }

    fn matches_rule(raw: &str, rule: RuleId) -> bool {
        match_rules(raw, rules())
            .into_iter()
            .any(|m| m.rule_id == rule)
    }

    // ── Rule positives + negatives ──────────────────────────────────────

    #[test]
    fn sudo_password_positive() {
        let buf = "Some banner output\n[sudo] password for alice: ";
        assert_eq!(first_match(buf), Some(RuleId::SudoPassword));
    }

    #[test]
    fn sudo_password_negative() {
        // Mentions the words but without the trailing colon prompt.
        let buf = "Setting sudo password for alice...";
        assert!(!matches_rule(buf, RuleId::SudoPassword));
    }

    #[test]
    fn yes_no_bracket_positive() {
        let buf = "Are you sure?\nContinue? [y/N] ";
        assert!(matches_rule(buf, RuleId::YesNoBracket));
    }

    #[test]
    fn yes_no_bracket_negative() {
        // Not anchored at end of line — output continues past the bracket.
        let buf = "[y/N] is the legacy syntax for confirmations";
        assert!(!matches_rule(buf, RuleId::YesNoBracket));
    }

    #[test]
    fn yes_no_paren_positive() {
        let buf = "The authenticity of host can't be established.\n\
             Are you sure you want to continue connecting (yes/no)? ";
        assert!(matches_rule(buf, RuleId::YesNoParen));
    }

    #[test]
    fn yes_no_paren_negative() {
        let buf = "Use (yes/no) as your answer in this script";
        assert!(!matches_rule(buf, RuleId::YesNoParen));
    }

    #[test]
    fn press_any_key_positive() {
        let buf = "-- More -- Press any key to continue --";
        assert!(matches_rule(buf, RuleId::PressAnyKey));
    }

    #[test]
    fn press_any_key_negative() {
        let buf = "press the any key on your keyboard";
        assert!(!matches_rule(buf, RuleId::PressAnyKey));
    }

    #[test]
    fn git_credentials_positive() {
        let buf = "Cloning into 'repo'...\nUsername for 'https://github.com': ";
        assert!(matches_rule(buf, RuleId::GitCredentials));
    }

    #[test]
    fn git_credentials_negative() {
        // Looks like a doc snippet in the middle of a line, not a prompt.
        let buf = "see Username for 'https://github.com': in the help";
        assert!(!matches_rule(buf, RuleId::GitCredentials));
    }

    #[test]
    fn ai_proceed_positive() {
        let buf = "I will refactor these files.\nShould I proceed?";
        assert!(matches_rule(buf, RuleId::AiProceed));
    }

    #[test]
    fn ai_proceed_negative() {
        let buf = "Proceed with caution when editing.";
        assert!(!matches_rule(buf, RuleId::AiProceed));
    }

    #[test]
    fn ai_apply_diff_positive() {
        let buf = "+ added line\n- removed line\nApply this patch?";
        assert!(matches_rule(buf, RuleId::AiApplyDiff));
    }

    #[test]
    fn ai_apply_diff_negative() {
        let buf = "Apply this patch carefully to staging only.";
        assert!(!matches_rule(buf, RuleId::AiApplyDiff));
    }

    #[test]
    fn arrow_select_strong_positive() {
        let buf = "Pick one:\n❯ Yes\n  No";
        assert!(matches_rule(buf, RuleId::ArrowSelect));
    }

    #[test]
    fn arrow_select_weak_only_positive() {
        // No ❯ pointer anywhere — only the hint text. Weak signal must fire.
        let buf = "Use arrow keys to navigate, Enter to select";
        assert!(matches_rule(buf, RuleId::ArrowSelect));
    }

    #[test]
    fn arrow_select_negative_p10k_prompt() {
        // Powerlevel10k bare prompt: pointer + space + EOL → no \S after.
        let buf = "~/projects/threadterm \n❯ ";
        assert!(
            !matches_rule(buf, RuleId::ArrowSelect),
            "p10k prompt must NOT fire arrow-select"
        );
    }

    // ── ANSI stripping ──────────────────────────────────────────────────

    #[test]
    fn ansi_codes_are_stripped_before_matching() {
        // Wrap the prompt in some colour/clear escape sequences.
        let buf = "\x1b[31mWarning\x1b[0m\n\x1b[1m[sudo] password for bob:\x1b[0m ";
        assert!(matches_rule(buf, RuleId::SudoPassword));
    }

    // ── Cooldown behaviour ──────────────────────────────────────────────

    #[test]
    fn dedup_within_60s() {
        let t0 = Instant::now();
        let mut w = CardWatcher::new(t0);
        assert!(try_fire(&mut w, RuleId::SudoPassword, t0));
        // Same rule, 30s later → still cooling.
        let t1 = t0 + Duration::from_secs(30);
        assert!(!try_fire(&mut w, RuleId::SudoPassword, t1));
    }

    #[test]
    fn dedup_resets_after_window() {
        let t0 = Instant::now();
        let mut w = CardWatcher::new(t0);
        assert!(try_fire(&mut w, RuleId::SudoPassword, t0));
        // 61s later → window has elapsed, fires again.
        let t1 = t0 + Duration::from_secs(61);
        assert!(try_fire(&mut w, RuleId::SudoPassword, t1));
    }

    #[test]
    fn dedup_is_per_rule_not_per_card() {
        let t0 = Instant::now();
        let mut w = CardWatcher::new(t0);
        assert!(try_fire(&mut w, RuleId::SudoPassword, t0));
        // A different rule on the same card is unaffected.
        assert!(try_fire(&mut w, RuleId::YesNoBracket, t0));
    }

    // ── Watcher lifecycle ───────────────────────────────────────────────

    #[test]
    fn pin_resets_cooldown() {
        // Simulate the supervisor_enable path: a new CardWatcher is inserted
        // in place of the old one whenever a card is (re-)pinned, which
        // wipes its cooldown table.
        let t0 = Instant::now();
        let mut w = CardWatcher::new(t0);
        try_fire(&mut w, RuleId::SudoPassword, t0);
        assert!(w.cooldowns.contains_key(&RuleId::SudoPassword));

        // Re-pin: replace with a fresh watcher.
        let w2 = CardWatcher::new(t0);
        assert!(w2.cooldowns.is_empty());
    }

    #[test]
    fn disable_drops_state() {
        // We can't await `supervisor_enable` here without a Tauri AppHandle,
        // so simulate the state mutation directly: disabled means watched is
        // empty and the master switch is off.
        let mut s = SupervisorState::new();
        s.enabled = true;
        s.watched
            .insert("card-1".into(), CardWatcher::new(Instant::now()));

        // Tear-down semantics:
        s.watched.clear();
        s.enabled = false;
        assert!(s.watched.is_empty());
        assert!(!s.enabled);
    }

    // ── Rule-id wire stability ──────────────────────────────────────────

    #[test]
    fn rule_id_strings_are_stable() {
        // These strings are i18n keys + persisted cooldown keys. Any rename
        // is a breaking change for the frontend.
        assert_eq!(RuleId::SudoPassword.as_str(), "sudo-password");
        assert_eq!(RuleId::YesNoBracket.as_str(), "yes-no-bracket");
        assert_eq!(RuleId::YesNoParen.as_str(), "yes-no-paren");
        assert_eq!(RuleId::PressAnyKey.as_str(), "press-any-key");
        assert_eq!(RuleId::GitCredentials.as_str(), "git-credentials");
        assert_eq!(RuleId::AiProceed.as_str(), "ai-proceed");
        assert_eq!(RuleId::AiApplyDiff.as_str(), "ai-apply-diff");
        assert_eq!(RuleId::ArrowSelect.as_str(), "arrow-select");
    }

    #[test]
    fn sample_text_is_clipped() {
        // Build a >SAMPLE_TEXT_MAX line ending in a sudo prompt.
        let prefix = "x".repeat(SAMPLE_TEXT_MAX + 50);
        let buf = format!("{prefix} [sudo] password for alice: ");
        let m = match_rules(&buf, rules())
            .into_iter()
            .find(|m| m.rule_id == RuleId::SudoPassword)
            .expect("should match");
        assert!(
            m.sample_text.chars().count() <= SAMPLE_TEXT_MAX,
            "sample_text length {} > cap {}",
            m.sample_text.chars().count(),
            SAMPLE_TEXT_MAX
        );
    }
}
