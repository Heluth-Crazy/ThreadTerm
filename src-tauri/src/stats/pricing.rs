//! Built-in static pricing table.
//!
//! Prices are $/token (the public $/MTok list prices divided by 1e6). Unknown
//! models cost $0 (never blocks aggregation) — any match is a strict
//! improvement over the previous "date-suffixed models billed $0" hole. Rates
//! are approximate public list prices (Anthropic / OpenAI / Google / DeepSeek /
//! Zhipu); they drift, so treat cost figures as estimates, not invoices.
//!
//! The `ModelCosts` shape mirrors what a future models.dev remote fetch would
//! produce, so this module's internals can be swapped for a cached remote table
//! without touching callers.

use crate::stats::types::UsageSummary;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ModelCosts {
    /// $/token
    pub input: f64,
    pub output: f64,
    pub cache_write: f64,
    pub cache_read: f64,
}

/// Normalize a raw model name so provider pin, vendor prefix, and date suffixes
/// don't break pricing lookup.
///
/// Applied in order:
///   1. lowercase
///   2. drop `@pin` suffix (Claude Code date pins, e.g. `@20260101`)
///   3. drop `vendor/` prefix (e.g. `openai/`, `anthropic/`, `azure/`)
///   4. drop ISO date suffix `-YYYY-MM-DD` (e.g. `gpt-5.4-2026-03-05`)
///   5. drop compact date suffix `-YYYYMMDD` (e.g. `claude-opus-4-6-20260206`)
///
/// `anthropic/claude-opus-4-8@20260101` → `claude-opus-4-8`.
/// `openai/gpt-5.4-2026-03-05` → `gpt-5.4`.
fn canonical(model: &str) -> String {
    let mut m = model.trim().to_lowercase();

    // Drop `@pin` suffix.
    if let Some(pos) = m.find('@') {
        m.truncate(pos);
    }

    // Drop the last `vendor/` prefix segment (handles openai/, anthropic/,
    // azure/, claude-code/, models/, ... — anything with a slash).
    if let Some(pos) = m.rfind('/') {
        m = m[pos + 1..].to_string();
    }

    // Drop ISO date suffix `-YYYY-MM-DD` (exactly 11 chars).
    if m.len() > 11 && m.is_char_boundary(m.len() - 11) {
        let s = &m[m.len() - 11..];
        let b = s.as_bytes();
        if b[0] == b'-'
            && s[1..5].chars().all(|c| c.is_ascii_digit())
            && b[5] == b'-'
            && s[6..8].chars().all(|c| c.is_ascii_digit())
            && b[8] == b'-'
            && s[9..11].chars().all(|c| c.is_ascii_digit())
        {
            m.truncate(m.len() - 11);
        }
    }

    // Drop compact date suffix `-YYYYMMDD` (exactly 9 chars after last '-').
    if m.len() > 9 {
        let parts: Vec<&str> = m.rsplitn(2, '-').collect();
        if parts.len() == 2 {
            if let Some(suffix) = parts.first() {
                if suffix.len() == 8 && suffix.chars().all(|c| c.is_ascii_digit()) {
                    m = parts[1].to_string();
                }
            }
        }
    }

    m
}

/// $/MTok → ModelCosts ($/token).
fn mtok(input: f64, output: f64, cache_write: f64, cache_read: f64) -> ModelCosts {
    ModelCosts {
        input: input / 1e6,
        output: output / 1e6,
        cache_write: cache_write / 1e6,
        cache_read: cache_read / 1e6,
    }
}

/// Look up costs by canonical model name (prefix-matched). Returns `None` for
/// unknown models. Rates are public list prices (approximate), $/MTok.
///
/// Cache pricing convention:
///   - Claude: cache_write ≈ 1.25× input (5m TTL), cache_read ≈ 0.1× input.
///   - OpenAI: cached input billed at 0.1× input (cache_read only; Codex logs
///     never report cache_creation, so cache_write is unused in practice).
///   - Others: when the vendor doesn't publish cache pricing, cache_write is
///     set equal to input and cache_read to 0.1× input as a conservative guess.
pub fn lookup(model: &str) -> Option<ModelCosts> {
    let c = canonical(model);
    let compact = c.replace(['-', '_', ' '], "");

    // ── Anthropic Claude ──
    if compact.starts_with("claudefable5")
        || compact.starts_with("fable5")
        || compact.starts_with("claudemythos5")
        || compact.starts_with("mythos5")
    {
        return Some(mtok(10.0, 50.0, 12.5, 1.0));
    }
    if c.starts_with("claude-opus") {
        return Some(mtok(15.0, 75.0, 18.75, 1.5));
    }
    if c.starts_with("claude-sonnet") {
        return Some(mtok(3.0, 15.0, 3.75, 0.3));
    }
    if c.starts_with("claude-haiku") {
        return Some(mtok(0.8, 4.0, 1.0, 0.08));
    }

    // ── OpenAI Codex / GPT-5 family ──
    if c.contains("codex") || c.starts_with("gpt-5") {
        return Some(mtok(1.25, 10.0, 1.25, 0.125));
    }

    // ── OpenAI o-series (reasoning) ──
    if c.starts_with("o3") {
        return Some(mtok(10.0, 40.0, 10.0, 2.5));
    }
    if c.starts_with("o4-mini") {
        return Some(mtok(1.1, 4.4, 1.1, 0.275));
    }

    // ── OpenAI GPT-4.x ──
    if c.starts_with("gpt-4.1") {
        return Some(mtok(2.0, 8.0, 2.0, 0.5));
    }
    if c.starts_with("gpt-4o") {
        return Some(mtok(2.5, 10.0, 2.5, 0.625));
    }

    // ── Google Gemini ──
    if c.contains("gemini-2.5-pro") || c.contains("gemini-3") {
        return Some(mtok(1.25, 10.0, 1.25, 0.3125));
    }
    if c.contains("gemini-2.5-flash") || c.contains("gemini-flash") {
        return Some(mtok(0.15, 0.6, 0.15, 0.0375));
    }
    if c.starts_with("gemini") {
        return Some(mtok(1.25, 10.0, 1.25, 0.3125));
    }

    // ── DeepSeek ──
    if c.contains("deepseek-reasoner") || c.starts_with("deepseek-r") {
        return Some(mtok(0.55, 2.19, 0.55, 0.14));
    }
    if c.contains("deepseek") {
        return Some(mtok(0.27, 1.1, 0.27, 0.07));
    }

    // ── Zhipu GLM ──
    if c.contains("glm-4") || c.starts_with("glm") {
        return Some(mtok(0.6, 2.2, 0.6, 0.15));
    }

    None
}

/// Per-category USD cost for one call.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CostBreakdown {
    pub input: f64,
    pub output: f64,
    pub cache_write: f64,
    pub cache_read: f64,
    pub total: f64,
}

/// Per-category cost breakdown. Unknown model → all zeros.
pub fn cost_breakdown(model: &str, usage: &UsageSummary) -> CostBreakdown {
    let Some(c) = lookup(model) else {
        return CostBreakdown::default();
    };
    let input = usage.input as f64 * c.input;
    let output = usage.output as f64 * c.output;
    let cache_write = usage.cache_creation as f64 * c.cache_write;
    let cache_read = usage.cache_read as f64 * c.cache_read;
    CostBreakdown {
        input,
        output,
        cache_write,
        cache_read,
        total: input + output + cache_write + cache_read,
    }
}

/// Cost in USD for one call's usage. Unknown model → $0.
#[allow(dead_code)]
pub fn cost(model: &str, usage: &UsageSummary) -> f64 {
    cost_breakdown(model, usage).total
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_strips_provider_and_pin() {
        assert_eq!(
            canonical("anthropic/claude-opus-4-8@20260101"),
            "claude-opus-4-8"
        );
        assert_eq!(canonical("Claude-Sonnet-4-5"), "claude-sonnet-4-5");
    }

    #[test]
    fn canonical_strips_iso_date_suffix() {
        assert_eq!(canonical("gpt-5.4-2026-03-05"), "gpt-5.4");
        assert_eq!(canonical("gpt-5.4-pro-2026-03-05"), "gpt-5.4-pro");
        assert_eq!(canonical("openai/gpt-5.4-2026-03-05"), "gpt-5.4");
    }

    #[test]
    fn canonical_strips_compact_date_suffix() {
        assert_eq!(canonical("gpt-5.4-20260305"), "gpt-5.4");
        assert_eq!(canonical("claude-opus-4-6-20260206"), "claude-opus-4-6");
        assert_eq!(canonical("openai/gpt-5.4-20260305"), "gpt-5.4");
    }

    #[test]
    fn canonical_preserves_undated_names() {
        assert_eq!(canonical("gpt-5.4"), "gpt-5.4");
        assert_eq!(canonical("gpt-5.2-codex"), "gpt-5.2-codex");
        assert_eq!(canonical("o3"), "o3");
        assert_eq!(canonical("deepseek-chat"), "deepseek-chat");
    }

    #[test]
    fn known_models_have_costs() {
        assert!(lookup("claude-fable-5").is_some());
        assert!(lookup("fable5").is_some());
        assert!(lookup("Claude Fable 5").is_some());
        assert!(lookup("claude-mythos-5").is_some());
        assert!(lookup("claude-opus-4-8").is_some());
        assert!(lookup("gpt-5-codex").is_some());
        assert!(lookup("totally-unknown-model").is_none());
    }

    #[test]
    fn date_suffixed_models_match_pricing() {
        // Regression: previously these fell through to $0 because the date
        // suffix blocked the prefix match.
        assert!(lookup("gpt-5.4-2026-03-05").is_some());
        assert!(lookup("claude-opus-4-6-20260206").is_some());
        assert!(lookup("openai/gpt-5.4-20260305").is_some());
    }

    #[test]
    fn fable5_uses_anthropic_public_pricing() {
        let costs = lookup("anthropic/claude-fable-5").expect("fable pricing");
        assert_eq!(costs, mtok(10.0, 50.0, 12.5, 1.0));
    }

    #[test]
    fn expanded_families_have_costs() {
        assert!(lookup("glm-4.6").is_some());
        assert!(lookup("GLM-4.6").is_some());
        assert!(lookup("deepseek-chat").is_some());
        assert!(lookup("deepseek-reasoner").is_some());
        assert!(lookup("gemini-2.5-pro").is_some());
        assert!(lookup("gemini-2.5-flash").is_some());
        assert!(lookup("o3").is_some());
        assert!(lookup("o4-mini").is_some());
        assert!(lookup("gpt-4.1").is_some());
        assert!(lookup("gpt-4o").is_some());
    }

    #[test]
    fn cost_sums_categories() {
        let usage = UsageSummary {
            input: 1_000_000,
            output: 1_000_000,
            cache_creation: 0,
            cache_read: 0,
        };
        // opus: $15 input + $75 output per MTok
        let c = cost("claude-opus-4-8", &usage);
        assert!((c - 90.0).abs() < 1e-9, "expected 90.0, got {c}");
    }

    #[test]
    fn unknown_model_is_zero() {
        let usage = UsageSummary {
            input: 1_000_000,
            output: 0,
            cache_creation: 0,
            cache_read: 0,
        };
        assert_eq!(cost("mystery", &usage), 0.0);
    }
}
