//! Built-in static pricing table (MVP).
//!
//! Prices are $/token (the public $/MTok rates divided by 1e6). Unknown models
//! cost $0 (never blocks aggregation). The `ModelCosts` shape mirrors what a
//! future models.dev remote fetch would produce, so this module's internals can
//! be swapped for a cached remote table without touching callers.

use crate::stats::types::UsageSummary;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ModelCosts {
    /// $/token
    pub input: f64,
    pub output: f64,
    pub cache_write: f64,
    pub cache_read: f64,
}

/// Normalize a raw model name: lowercase, drop `@date`/pin suffix and common
/// provider prefixes so `anthropic/claude-opus-4-8@20260101` → `claude-opus-4-8`.
fn canonical(model: &str) -> String {
    let mut m = model.trim().to_lowercase();
    if let Some(pos) = m.find('@') {
        m.truncate(pos);
    }
    for prefix in ["anthropic/", "openai/", "claude-code/", "models/"] {
        if let Some(rest) = m.strip_prefix(prefix) {
            m = rest.to_string();
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
/// unknown models. Rates are public list prices (Anthropic / OpenAI), $/MTok.
pub fn lookup(model: &str) -> Option<ModelCosts> {
    let canon = canonical(model);
    // Claude: cache_write ≈ 1.25× input (5m), cache_read ≈ 0.1× input.
    if canon.starts_with("claude-opus") {
        return Some(mtok(15.0, 75.0, 18.75, 1.5));
    }
    if canon.starts_with("claude-sonnet") {
        return Some(mtok(3.0, 15.0, 3.75, 0.3));
    }
    if canon.starts_with("claude-haiku") {
        return Some(mtok(0.8, 4.0, 1.0, 0.08));
    }
    // OpenAI Codex / GPT-5 family: cached input billed at ~0.1× input.
    if canon.contains("codex") || canon.starts_with("gpt-5") {
        return Some(mtok(1.25, 10.0, 1.25, 0.125));
    }
    None
}

/// Cost in USD for one call's usage. Unknown model → $0.
pub fn cost(model: &str, usage: &UsageSummary) -> f64 {
    let Some(c) = lookup(model) else {
        return 0.0;
    };
    usage.input as f64 * c.input
        + usage.output as f64 * c.output
        + usage.cache_creation as f64 * c.cache_write
        + usage.cache_read as f64 * c.cache_read
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_strips_provider_and_pin() {
        assert_eq!(canonical("anthropic/claude-opus-4-8@20260101"), "claude-opus-4-8");
        assert_eq!(canonical("Claude-Sonnet-4-5"), "claude-sonnet-4-5");
    }

    #[test]
    fn known_models_have_costs() {
        assert!(lookup("claude-opus-4-8").is_some());
        assert!(lookup("gpt-5-codex").is_some());
        assert!(lookup("totally-unknown-model").is_none());
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
