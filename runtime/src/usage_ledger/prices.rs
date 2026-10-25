//! Offline API-equivalent price estimates for normalized usage facts.
//!
//! The bundled catalog is generated from LiteLLM's public MIT-licensed model
//! price data. It never performs network I/O at runtime. A missing rate leaves
//! the request unpriced so callers can report coverage rather than a $0 cost.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::facts::Fact;

const SNAPSHOT: &str = include_str!("prices.snapshot.json");
const ALIAS_NORMALIZATION_VERSION: &str = "alias-normalization-v3";

/// Stable input to the ledger's pricing revision. A snapshot or safe alias
/// normalization change must reprice existing facts even when user overrides
/// did not change.
pub fn catalog_revision() -> &'static str {
    static REVISION: OnceLock<String> = OnceLock::new();
    REVISION.get_or_init(|| catalog_revision_for(ALIAS_NORMALIZATION_VERSION, SNAPSHOT))
}

fn catalog_revision_for(alias_version: &str, snapshot: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(b"threadterm-usage-price-catalog\0");
    hash.update(alias_version.as_bytes());
    hash.update(b"\0");
    hash.update(snapshot.as_bytes());
    hex::encode(hash.finalize())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    #[allow(dead_code)]
    version: u8,
    models: BTreeMap<String, ModelPrice>,
    #[serde(skip)]
    aliases: OnceLock<BTreeMap<String, String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelPrice {
    #[allow(dead_code)]
    provider: String,
    #[serde(default)]
    aliases: Vec<String>,
    rates: Rates,
    #[serde(default)]
    tiers: Vec<Tier>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Rates {
    input: Option<f64>,
    output: Option<f64>,
    cache_read: Option<f64>,
    cache_write5m: Option<f64>,
    cache_write1h: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Tier {
    threshold: i64,
    rates: Rates,
}

fn snapshot() -> Option<&'static Snapshot> {
    static CATALOG: OnceLock<Option<Snapshot>> = OnceLock::new();
    CATALOG
        .get_or_init(|| serde_json::from_str(SNAPSHOT).ok())
        .as_ref()
}

/// Estimate USD API-equivalent cost. `None` means at least one non-zero,
/// reported bucket has no usable rate. Null buckets are not silently converted
/// to zero; they remain outside priced-token coverage in the caller's totals.
pub fn estimate(fact: &Fact, overrides: &Value) -> Option<f64> {
    // Legacy Claude writes can report a cache creation total but omit the TTL.
    // It is counted in token totals, but choosing either cache-write rate would
    // turn an unknown rate into a misleading API-equivalent amount.
    if fact.buckets.cache_write_unknown.unwrap_or(0) > 0 {
        return None;
    }
    let model = fact.model.as_deref()?;
    let override_rates = override_rates(overrides, &fact.provider, model);
    let price = snapshot().and_then(|catalog| find_model(catalog, &fact.provider, model));
    if price.is_none() && override_rates.is_none() {
        return None;
    }
    let mut rates = price.map(|price| price.rates.clone()).unwrap_or_default();
    if let Some(price) = price {
        let prompt_tokens = prompt_tokens(fact);
        if !price.tiers.is_empty() && prompt_tokens.is_none() {
            return None;
        }
        if let Some(tier) = price
            .tiers
            .iter()
            .filter(|tier| prompt_tokens >= Some(tier.threshold))
            .max_by_key(|tier| tier.threshold)
        {
            rates = merge_rates(rates, &tier.rates);
        }
    }
    if let Some(override_rates) = override_rates {
        rates = merge_rates(rates, &override_rates);
    }
    estimate_with_rates(fact, &rates)
}

fn find_model<'a>(catalog: &'a Snapshot, provider: &str, model: &str) -> Option<&'a ModelPrice> {
    // A provider-qualified snapshot key can deliberately differ from a bare
    // spelling. Preserve it before normalization removes that qualification.
    let exact_key = model.trim().to_ascii_lowercase();
    if let Some(price) = catalog.models.get(&exact_key) {
        return Some(price);
    }
    let aliases = catalog.aliases.get_or_init(|| {
        let mut aliases = BTreeMap::new();
        for (name, price) in &catalog.models {
            for alias in
                std::iter::once(name.as_str()).chain(price.aliases.iter().map(String::as_str))
            {
                aliases
                    .entry(normalize_exact(alias))
                    .or_insert_with(|| name.clone());
            }
        }
        aliases
    });
    model_candidates(provider, model)
        .into_iter()
        .find_map(|candidate| {
            aliases
                .get(&candidate)
                .and_then(|name| catalog.models.get(name))
        })
}

/// Returns the bundled catalog key used for a model spelling, if any. This is
/// intentionally separate from estimation so content-free audits can identify
/// the exact snapshot equivalence without exposing prices or transcript data.
pub fn catalog_model_id(provider: &str, model: &str) -> Option<String> {
    let catalog = snapshot()?;
    let exact_key = model.trim().to_ascii_lowercase();
    if catalog.models.contains_key(&exact_key) {
        return Some(exact_key);
    }
    let aliases = catalog.aliases.get_or_init(|| {
        let mut aliases = BTreeMap::new();
        for (name, price) in &catalog.models {
            for alias in
                std::iter::once(name.as_str()).chain(price.aliases.iter().map(String::as_str))
            {
                aliases
                    .entry(normalize_exact(alias))
                    .or_insert_with(|| name.clone());
            }
        }
        aliases
    });
    model_candidates(provider, model)
        .into_iter()
        .find_map(|candidate| aliases.get(&candidate).cloned())
}

fn model_candidates(provider: &str, model: &str) -> Vec<String> {
    let exact = normalize_exact(model);
    let mut candidates = vec![exact.clone()];
    let no_prefix = exact
        .strip_prefix(&format!("{}/", provider.to_ascii_lowercase()))
        .unwrap_or(&exact)
        .to_owned();
    if no_prefix != exact {
        candidates.push(no_prefix.clone());
    }
    let canonical_prefix = normalize_exact(&no_prefix);
    if canonical_prefix != no_prefix {
        candidates.push(canonical_prefix.clone());
    }
    let no_date = strip_date_suffix(&canonical_prefix);
    if no_date != no_prefix {
        candidates.push(no_date.clone());
    }
    if let Some(kimi) = kimi_code_alias(model) {
        candidates.push(kimi);
    }
    // Do not drop `-fast` or service-tier suffixes. An unlisted variant can
    // carry a premium, so it is intentionally unpriced rather than mapped to
    // a possibly cheaper base model.
    candidates.dedup();
    candidates
}

fn normalize_exact(model: &str) -> String {
    let mut value = model.trim().to_ascii_lowercase();
    loop {
        let next = value.strip_prefix("models/").or_else(|| {
            [
                "openai/",
                "anthropic/",
                "google/",
                "gemini/",
                "xai/",
                "moonshot/",
                "codex/",
                "claude/",
                "opencode/",
                "pi/",
                "kimi/",
                "grok/",
            ]
            .into_iter()
            .find_map(|prefix| value.strip_prefix(prefix))
        });
        let Some(next) = next else { break };
        value = next.to_owned();
    }
    value
}

/// Kimi Code writes a client namespace around the published Moonshot model
/// name. Keep this list finite: service labels such as `highspeed` have no
/// price-equivalence proof and must remain unpriced until the snapshot names
/// them directly.
fn kimi_code_alias(model: &str) -> Option<String> {
    let model = model.trim().to_ascii_lowercase();
    let suffix = model.strip_prefix("kimi-code/")?;
    let suffix = suffix.strip_prefix("kimi-").unwrap_or(suffix);
    match suffix {
        "k2.5" => Some("kimi-k2.5".into()),
        "k2.6" => Some("kimi-k2.6".into()),
        "k2.7-code" => Some("kimi-k2.7-code".into()),
        "k3" => Some("kimi-k3".into()),
        _ => None,
    }
}

fn strip_date_suffix(model: &str) -> String {
    if !model.is_ascii() {
        return model.to_owned();
    }
    let compact_start = model.len().saturating_sub(8);
    let dashed_start = model.len().saturating_sub(10);
    let compact = &model[compact_start..];
    let dashed = &model[dashed_start..];
    let compact_date = model.len() > 8
        && model.as_bytes().get(compact_start.wrapping_sub(1)) == Some(&b'-')
        && compact.starts_with("20")
        && compact.bytes().all(|byte| byte.is_ascii_digit());
    let dashed_date = model.len() > 10
        && model.as_bytes().get(dashed_start.wrapping_sub(1)) == Some(&b'-')
        && dashed.as_bytes().get(4) == Some(&b'-')
        && dashed.as_bytes().get(7) == Some(&b'-')
        && dashed
            .replace('-', "")
            .bytes()
            .all(|byte| byte.is_ascii_digit())
        && dashed.starts_with("20");
    if compact_date {
        model[..compact_start - 1].to_owned()
    } else if dashed_date {
        model[..dashed_start - 1].to_owned()
    } else {
        model.to_owned()
    }
}

fn prompt_tokens(fact: &Fact) -> Option<i64> {
    [
        fact.buckets.input,
        fact.buckets.cache_read,
        fact.buckets.cache_write5m,
        fact.buckets.cache_write1h,
    ]
    .into_iter()
    .try_fold(0_i64, |sum, value| sum.checked_add(value.unwrap_or(0)))
}

fn merge_rates(mut base: Rates, overlay: &Rates) -> Rates {
    for (base_rate, override_rate) in [
        (&mut base.input, overlay.input),
        (&mut base.output, overlay.output),
        (&mut base.cache_read, overlay.cache_read),
        (&mut base.cache_write5m, overlay.cache_write5m),
        (&mut base.cache_write1h, overlay.cache_write1h),
    ] {
        if override_rate.is_some() {
            *base_rate = override_rate;
        }
    }
    base
}

fn override_rates(overrides: &Value, provider: &str, model: &str) -> Option<Rates> {
    let object = overrides.as_object()?;
    let keys = [
        format!("{provider}/{model}"),
        format!("{provider}/{}", normalize_exact(model)),
    ];
    let row = keys.iter().find_map(|key| object.get(key))?.as_object()?;
    let rate = |names: &[&str]| {
        names
            .iter()
            .find_map(|name| row.get(*name).and_then(Value::as_f64))
            .filter(|value| value.is_finite() && *value >= 0.0)
            .map(|value| value / 1_000_000.0)
    };
    Some(Rates {
        input: rate(&["input", "inputPerMillion"]),
        output: rate(&["output", "outputPerMillion"]),
        cache_read: rate(&["cacheRead", "cacheReadPerMillion"]),
        cache_write5m: rate(&["cacheWrite5m", "cacheWrite5mPerMillion"]),
        cache_write1h: rate(&["cacheWrite1h", "cacheWrite1hPerMillion"]),
    })
}

fn estimate_with_rates(fact: &Fact, rates: &Rates) -> Option<f64> {
    let dimensions = [
        (fact.buckets.input, rates.input),
        (fact.buckets.cache_read, rates.cache_read),
        (fact.buckets.cache_write5m, rates.cache_write5m),
        (fact.buckets.cache_write1h, rates.cache_write1h),
        (fact.buckets.output, rates.output),
    ];
    dimensions
        .into_iter()
        .try_fold(0.0, |total, (tokens, rate)| match tokens {
            Some(tokens) if tokens > 0 => rate
                .filter(|rate| rate.is_finite() && *rate >= 0.0)
                .map(|rate| total + tokens as f64 * rate),
            _ => Some(total),
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage_ledger::facts::Buckets;

    #[test]
    fn catalog_revision_is_stable_and_versions_alias_normalization() {
        let expected = catalog_revision_for(ALIAS_NORMALIZATION_VERSION, SNAPSHOT);
        assert_eq!(catalog_revision(), expected);
        assert_eq!(catalog_revision(), catalog_revision());
        assert_eq!(catalog_revision().len(), 64);
        assert_ne!(
            catalog_revision_for("alias-normalization-v2", SNAPSHOT),
            catalog_revision(),
            "a normalization change must schedule repricing of stored facts"
        );
    }

    #[test]
    fn aliases_dates_and_fast_variants_are_normalized_without_assuming_installed_models() {
        let mut models = BTreeMap::new();
        models.insert(
            "fixture-alpha".into(),
            ModelPrice {
                provider: "fixture".into(),
                aliases: vec![],
                rates: Rates {
                    input: Some(1.0),
                    ..Default::default()
                },
                tiers: vec![],
            },
        );
        models.insert(
            "fixture-alpha-fast".into(),
            ModelPrice {
                provider: "fixture".into(),
                aliases: vec![],
                rates: Rates {
                    input: Some(2.0),
                    ..Default::default()
                },
                tiers: vec![],
            },
        );
        let catalog = Snapshot {
            version: 1,
            models,
            aliases: OnceLock::new(),
        };
        assert_eq!(
            model_candidates("fixture", "fixture/fixture-alpha-2026-10-23"),
            vec![
                "fixture/fixture-alpha-2026-10-23",
                "fixture-alpha-2026-10-23",
                "fixture-alpha"
            ]
        );
        assert_eq!(
            find_model(&catalog, "fixture", "fixture/fixture-alpha-2026-10-23")
                .and_then(|price| price.rates.input),
            Some(1.0)
        );
        assert_eq!(
            find_model(&catalog, "fixture", "fixture-alpha-fast")
                .and_then(|price| price.rates.input),
            Some(2.0)
        );
        assert_eq!(
            model_candidates("fixture", "fixture-alpha-premium-fast"),
            vec!["fixture-alpha-premium-fast"]
        );
        assert_eq!(
            strip_date_suffix("fixture-模型-2026-10-23"),
            "fixture-模型-2026-10-23"
        );
    }

    #[test]
    fn qualified_catalog_key_precedes_a_lossy_normalized_alias() {
        let mut models = BTreeMap::new();
        models.insert(
            "gemini-exp-1206".into(),
            ModelPrice {
                provider: "gemini".into(),
                aliases: vec![],
                rates: Rates {
                    input: Some(1.0),
                    ..Default::default()
                },
                tiers: vec![],
            },
        );
        models.insert(
            "gemini/gemini-exp-1206".into(),
            ModelPrice {
                provider: "gemini".into(),
                aliases: vec![],
                rates: Rates {
                    input: Some(0.0),
                    ..Default::default()
                },
                tiers: vec![],
            },
        );
        let catalog = Snapshot {
            version: 1,
            models,
            aliases: OnceLock::new(),
        };
        assert_eq!(
            find_model(&catalog, "gemini", "gemini/gemini-exp-1206")
                .and_then(|price| price.rates.input),
            Some(0.0),
        );
    }

    #[test]
    fn source_and_host_prefixes_are_normalized_but_unknown_service_labels_are_not() {
        let mut nested = Fact::new("opencode", "s", "r", "2026-01-01T00:00:00Z");
        nested.model = Some("opencode/deepseek/deepseek-v4-pro".into());
        nested.buckets = Buckets {
            input: Some(10),
            output: Some(1),
            ..Default::default()
        };
        let mut direct = nested.clone();
        direct.model = Some("deepseek-v4-pro".into());
        assert_eq!(
            estimate(&nested, &Value::Null),
            estimate(&direct, &Value::Null),
            "nested source/host prefixes must retain the snapshot rate"
        );
        assert!(estimate(&nested, &Value::Null).is_some());
        assert_eq!(kimi_code_alias("kimi-code/k3"), Some("kimi-k3".to_owned()));
        assert_eq!(kimi_code_alias("kimi-code/kimi-for-coding-highspeed"), None);
        assert_eq!(
            catalog_model_id("kimi", "kimi-code/k3"),
            Some("moonshot/kimi-k3".to_owned())
        );
        assert_eq!(
            catalog_model_id("opencode", "deepseek/deepseek-v4.1-flash-fast"),
            None
        );
    }

    #[test]
    fn missing_nonzero_bucket_rate_is_unpriced() {
        let mut fact = Fact::new("fixture", "s", "r", "2026-01-01T00:00:00Z");
        fact.buckets = Buckets {
            input: Some(4),
            output: Some(3),
            ..Default::default()
        };
        assert_eq!(
            estimate_with_rates(
                &fact,
                &Rates {
                    input: Some(1.0),
                    ..Default::default()
                }
            ),
            None
        );
    }

    #[test]
    fn unknown_cache_write_ttl_is_unpriced_even_with_manual_rates() {
        let mut fact = Fact::new("fixture", "s", "r", "2026-01-01T00:00:00Z");
        fact.model = Some("fixture-manual-only".into());
        fact.buckets = Buckets {
            input: Some(1),
            cache_write_unknown: Some(2),
            output: Some(1),
            ..Default::default()
        };
        assert_eq!(
            estimate(
                &fact,
                &serde_json::json!({"fixture/fixture-manual-only":{"input":1.0,"output":2.0,"cacheWrite5m":3.0,"cacheWrite1h":4.0}})
            ),
            None
        );
    }

    #[test]
    fn cache_and_long_context_tier_rates_are_additive() {
        let fact = Fact {
            buckets: Buckets {
                input: Some(128_000),
                cache_read: Some(10),
                cache_write5m: Some(2),
                cache_write1h: Some(1),
                output: Some(3),
                ..Default::default()
            },
            ..Fact::new("fixture", "s", "r", "2026-01-01T00:00:00Z")
        };
        let rates = Rates {
            input: Some(1.0),
            cache_read: Some(2.0),
            cache_write5m: Some(3.0),
            cache_write1h: Some(4.0),
            output: Some(5.0),
        };
        assert_eq!(
            estimate_with_rates(&fact, &rates),
            Some(128_000.0 + 20.0 + 6.0 + 4.0 + 15.0)
        );
    }

    #[test]
    fn absent_optional_cache_ttl_does_not_block_long_context_pricing() {
        let fact = Fact {
            buckets: Buckets {
                input: Some(272_000),
                cache_read: Some(1),
                cache_write5m: Some(2),
                cache_write1h: None,
                ..Default::default()
            },
            ..Fact::new("fixture", "s", "r", "2026-01-01T00:00:00Z")
        };
        assert_eq!(prompt_tokens(&fact), Some(272_003));
    }

    #[test]
    fn manual_price_can_cover_a_catalog_unknown_fixture_model() {
        let mut fact = Fact::new("fixture", "s", "r", "2026-01-01T00:00:00Z");
        fact.model = Some("fixture-manual-only".into());
        fact.buckets = Buckets {
            input: Some(3),
            output: Some(4),
            ..Default::default()
        };
        assert_eq!(
            estimate(
                &fact,
                &serde_json::json!({"fixture/fixture-manual-only":{"input":1.0,"output":2.0}})
            ),
            Some(0.000011)
        );
    }
}
