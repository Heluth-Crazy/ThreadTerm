//! Plan-usage enrichment for Kimi's `/usage` chat reply.
//!
//! Kimi's ACP builtin `/usage` answers with only the context/session token
//! lines, while the TUI panel also renders plan limits ("Weekly limit",
//! "5h limit", reset hints) fetched from the managed usage API. This module
//! repeats that fetch so structured chat surfaces the same plan data. Every
//! failure path returns `None` and leaves the builtin reply untouched.

use reqwest::blocking::Client;
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, OnceLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const OAUTH_CLIENT_ID: &str = "17e5f671-d194-4dfb-9706-5516cb48c098";
const CN_OAUTH_HOST: &str = "https://auth.kimi.com";
const GLOBAL_OAUTH_HOST: &str = "https://auth.kimi.ai";
const CN_BASE_URL: &str = "https://api.kimi.com/coding/v1";
const GLOBAL_BASE_URL: &str = "https://api.kimi.ai/coding/v1";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(6);
const TOKEN_EXPIRY_LEEWAY_SECS: u64 = 60;

/// Rendered plan usage: the TUI-style text block for transcripts plus the
/// structured rows the chat UI draws as an aligned card.
#[derive(Clone)]
pub struct PlanUsage {
    pub text: String,
    pub data: Value,
}

/// Plan limits shift on the scale of minutes; a short cache keeps repeated
/// `/usage` calls instant without going meaningfully stale.
const CACHE_TTL: Duration = Duration::from_secs(30);
const FAILURE_CACHE_TTL: Duration = Duration::from_secs(2);
struct CachedPlanUsage {
    at: Instant,
    home: PathBuf,
    access_token: String,
    endpoints: (String, Option<String>),
    usage: Option<PlanUsage>,
}
impl CachedPlanUsage {
    fn valid_for(
        &self,
        home: &Path,
        access_token: &str,
        endpoints: &(String, Option<String>),
    ) -> bool {
        self.at.elapsed()
            < if self.usage.is_some() {
                CACHE_TTL
            } else {
                FAILURE_CACHE_TTL
            }
            && self.home == home
            && self.access_token == access_token
            && &self.endpoints == endpoints
    }
}
// Hold the cache lock through a refresh: simultaneous sessions and prefetches
// must share one HTTP request, not race refresh-token rotation or duplicate it.
static CACHE: Mutex<Option<CachedPlanUsage>> = Mutex::new(None);
static PREFETCHING: AtomicBool = AtomicBool::new(false);
/// The runtime is long-lived, so one shared client keeps TLS connections
/// warm across `/usage` calls.
static CLIENT: OnceLock<Client> = OnceLock::new();

fn shared_client() -> Option<&'static Client> {
    if let Some(client) = CLIENT.get() {
        return Some(client);
    }
    let built = Client::builder().timeout(REQUEST_TIMEOUT).build().ok()?;
    // A racing thread may have installed its own client; either works.
    let _ = CLIENT.set(built);
    CLIENT.get()
}

/// Fetch the managed plan usage and render the "Plan usage" (and, when
/// present, "Extra Usage") block shown after Kimi's builtin `/usage` reply.
pub fn plan_usage() -> Option<PlanUsage> {
    fetch_plan_usage(true)
}

/// Overlap the independent account query with ACP startup. Never rotate OAuth
/// credentials speculatively while the CLI may also be refreshing on startup.
pub fn prefetch() {
    if PREFETCHING.swap(true, Ordering::AcqRel) {
        return;
    }
    std::thread::spawn(|| {
        let _ = fetch_plan_usage(false);
        PREFETCHING.store(false, Ordering::Release);
    });
}

fn fetch_plan_usage(allow_refresh: bool) -> Option<PlanUsage> {
    let mut cache = CACHE.lock().ok()?;
    let home = kimi_home()?;
    let mut credentials = Credentials::load(&home)?;
    let endpoints = base_urls(&home);
    if let Some(cached) = cache.as_ref() {
        if cached.valid_for(&home, &credentials.access_token, &endpoints) {
            return cached.usage.clone();
        }
    }
    let client = shared_client()?;
    if credentials.expiring_soon() {
        if !allow_refresh {
            return None;
        }
        credentials =
            refresh(client, &home, &credentials).or_else(|| Credentials::reload_fresh(&home))?;
    }
    // Share an actual network failure briefly as well: a foreground caller
    // waiting on prefetch must not pay a second timeout immediately afterward.
    // The expired-token prefetch early-return above is deliberately not cached.
    let usage = fetch_usages(client, &home, &credentials.access_token)
        .and_then(|payload| format_block(&payload, now_secs()));
    *cache = Some(CachedPlanUsage {
        at: Instant::now(),
        home,
        access_token: credentials.access_token,
        endpoints,
        usage: usage.clone(),
    });
    usage
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

fn env_value(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().trim_end_matches('/').to_owned())
        .filter(|value| !value.is_empty())
}

fn kimi_home() -> Option<PathBuf> {
    if let Some(dir) = env_value("KIMI_CODE_HOME") {
        return Some(PathBuf::from(dir));
    }
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .map(|home| home.join(".kimi-code"))
}

fn region_marker(home: &Path) -> Option<String> {
    fs::read_to_string(home.join("region"))
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| value == "mainland-cn" || value == "global")
}

fn oauth_host(home: &Path) -> String {
    if let Some(host) = env_value("KIMI_CODE_OAUTH_HOST").or_else(|| env_value("KIMI_OAUTH_HOST")) {
        return host;
    }
    match region_marker(home).as_deref() {
        Some("global") => GLOBAL_OAUTH_HOST.to_owned(),
        _ => CN_OAUTH_HOST.to_owned(),
    }
}

/// Primary managed base URL plus an optional fallback to the other official
/// deployment, mirroring how the CLI treats both as managed endpoints.
fn base_urls(home: &Path) -> (String, Option<String>) {
    if let Some(base) = env_value("KIMI_CODE_BASE_URL") {
        return (base, None);
    }
    match region_marker(home).as_deref() {
        Some("global") => (GLOBAL_BASE_URL.to_owned(), Some(CN_BASE_URL.to_owned())),
        _ => (CN_BASE_URL.to_owned(), Some(GLOBAL_BASE_URL.to_owned())),
    }
}

struct Credentials {
    access_token: String,
    refresh_token: String,
    expires_at: u64,
    raw: Value,
}

impl Credentials {
    fn path(home: &Path) -> PathBuf {
        home.join("credentials").join("kimi-code.json")
    }

    fn load(home: &Path) -> Option<Self> {
        let raw: Value = serde_json::from_str(&fs::read_to_string(Self::path(home)).ok()?).ok()?;
        Some(Self {
            access_token: raw.get("access_token").and_then(Value::as_str)?.to_owned(),
            refresh_token: raw.get("refresh_token").and_then(Value::as_str)?.to_owned(),
            expires_at: raw.get("expires_at").and_then(Value::as_u64).unwrap_or(0),
            raw,
        })
    }

    fn expiring_soon(&self) -> bool {
        now_secs() + TOKEN_EXPIRY_LEEWAY_SECS >= self.expires_at
    }

    /// Another kimi process may have rotated the refresh token already; a
    /// reloaded, still-fresh credential set is good enough to use.
    fn reload_fresh(home: &Path) -> Option<Self> {
        Self::load(home).filter(|credentials| !credentials.expiring_soon())
    }
}

fn refresh(client: &Client, home: &Path, credentials: &Credentials) -> Option<Credentials> {
    let response = client
        .post(format!("{}/api/oauth/token", oauth_host(home)))
        .form(&[
            ("client_id", OAUTH_CLIENT_ID),
            ("grant_type", "refresh_token"),
            ("refresh_token", credentials.refresh_token.as_str()),
        ])
        .send()
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let data: Value = response.json().ok()?;
    let access_token = data.get("access_token").and_then(Value::as_str)?.to_owned();
    let refresh_token = data
        .get("refresh_token")
        .and_then(Value::as_str)
        .unwrap_or(credentials.refresh_token.as_str())
        .to_owned();
    let expires_in = data
        .get("expires_in")
        .and_then(Value::as_u64)
        .unwrap_or(900);
    let expires_at = now_secs() + expires_in;
    let mut raw = credentials.raw.clone();
    raw["access_token"] = json!(access_token);
    raw["refresh_token"] = json!(refresh_token);
    raw["expires_in"] = json!(expires_in);
    raw["expires_at"] = json!(expires_at);
    if let Ok(text) = serde_json::to_string_pretty(&raw) {
        let _ = fs::write(Credentials::path(home), text);
    }
    Some(Credentials {
        access_token,
        refresh_token,
        expires_at,
        raw,
    })
}

fn fetch_usages(client: &Client, home: &Path, access_token: &str) -> Option<Value> {
    let (primary, fallback) = base_urls(home);
    let mut candidates = vec![primary];
    if let Some(fallback) = fallback {
        candidates.push(fallback);
    }
    let last = candidates.len() - 1;
    for (index, base) in candidates.into_iter().enumerate() {
        let response = client
            .get(format!("{base}/usages"))
            .header("Authorization", format!("Bearer {access_token}"))
            .header("Accept", "application/json")
            .send();
        let response = match response {
            Ok(response) => response,
            Err(_) if index < last => continue,
            Err(_) => return None,
        };
        if response.status().as_u16() == 404 && index < last {
            continue;
        }
        if !response.status().is_success() {
            return None;
        }
        return response.json().ok();
    }
    None
}

/// Numeric fields arrive as JSON strings ("100") on the managed API.
fn as_int(value: Option<&Value>) -> Option<u64> {
    value.and_then(|value| value.as_u64().or_else(|| value.as_str()?.parse().ok()))
}

struct UsageRow {
    label: String,
    used: u64,
    limit: u64,
    reset_at: Option<String>,
}

fn normalize_window(raw: &Value) -> Option<(u64, &'static str)> {
    let duration = as_int(raw.get("duration"))?;
    let unit = match raw.get("timeUnit").and_then(Value::as_str)? {
        "TIME_UNIT_MINUTE" => "minute",
        "TIME_UNIT_HOUR" => "hour",
        "TIME_UNIT_DAY" => "day",
        "TIME_UNIT_WEEK" => "week",
        _ => return None,
    };
    if unit == "minute" && duration >= 60 && duration % 60 == 0 {
        return Some((duration / 60, "hour"));
    }
    Some((duration, unit))
}

fn row_label(name: Option<&str>, window: Option<(u64, &str)>) -> String {
    if let Some((duration, unit)) = window {
        if unit == "week" {
            return "Weekly limit".to_owned();
        }
        let short = unit.chars().next().unwrap_or('?');
        return format!("{duration}{short} limit");
    }
    name.unwrap_or("Limit").to_owned()
}

fn usage_row(
    raw: &Value,
    name: Option<&str>,
    window: Option<(u64, &'static str)>,
) -> Option<UsageRow> {
    let used = as_int(raw.get("used"));
    let limit = as_int(raw.get("limit"));
    if used.is_none() && limit.is_none() {
        return None;
    }
    let label = row_label(
        name.or_else(|| raw.get("name").and_then(Value::as_str)),
        window,
    );
    Some(UsageRow {
        label,
        used: used.unwrap_or(0),
        limit: limit.unwrap_or(0),
        reset_at: raw
            .get("resetTime")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned),
    })
}

fn used_ratio(row: &UsageRow) -> f64 {
    if row.limit == 0 {
        return 0.0;
    }
    (row.used as f64 / row.limit as f64).clamp(0.0, 1.0)
}

/// Ceiled so any non-zero usage shows at least 1%, matching the TUI panel.
fn usage_percent(row: &UsageRow) -> u64 {
    if row.limit == 0 {
        return 0;
    }
    ((row.used as f64 / row.limit as f64) * 100.0)
        .ceil()
        .clamp(0.0, 100.0) as u64
}

fn progress_bar(ratio: f64, width: usize) -> String {
    let filled = (ratio.clamp(0.0, 1.0) * width as f64).round() as usize;
    "█".repeat(filled) + &"░".repeat(width.saturating_sub(filled))
}

fn reset_hint(reset_at: &str, now: u64) -> Option<String> {
    let parsed = chrono::DateTime::parse_from_rfc3339(reset_at).ok()?;
    let target = parsed.timestamp().max(0) as u64;
    let diff = target.checked_sub(now)?;
    if diff == 0 {
        return Some("reset".to_owned());
    }
    Some(format!("resets in {}", format_duration(diff)))
}

fn format_duration(total_seconds: u64) -> String {
    let days = total_seconds / 86400;
    let hours = total_seconds % 86400 / 3600;
    let minutes = total_seconds % 3600 / 60;
    let seconds = total_seconds % 60;
    let mut parts = Vec::new();
    if days > 0 {
        parts.push(format!("{days}d"));
    }
    if hours > 0 {
        parts.push(format!("{hours}h"));
    }
    if minutes > 0 {
        parts.push(format!("{minutes}m"));
    }
    if seconds > 0 && parts.is_empty() {
        parts.push(format!("{seconds}s"));
    }
    if parts.is_empty() {
        "0s".to_owned()
    } else {
        parts.join(" ")
    }
}

struct ExtraUsage {
    balance_cents: u64,
    monthly_limit_enabled: bool,
    monthly_limit_cents: u64,
    monthly_used_cents: u64,
    currency: String,
}

fn fixed_point_to_cents(value: u64) -> u64 {
    let cents = value as f64 / 1e6;
    if cents > 0.0 && cents < 1.0 {
        return 1;
    }
    cents.round() as u64
}

fn extra_usage(payload: &Value) -> Option<ExtraUsage> {
    let raw = payload.get("boosterWallet")?;
    let balance = raw.get("balance")?;
    if balance.get("type").and_then(Value::as_str) != Some("BOOSTER") {
        return None;
    }
    let amount = as_int(balance.get("amount"))?;
    if amount == 0 {
        return None;
    }
    let balance_cents = as_int(balance.get("amountLeft"))
        .map(fixed_point_to_cents)
        .unwrap_or(0);
    let monthly_limit = raw.get("monthlyChargeLimit");
    let monthly_used = raw.get("monthlyUsed");
    let currency = monthly_limit
        .and_then(|money| money.get("currency"))
        .or_else(|| monthly_used.and_then(|money| money.get("currency")))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or("USD")
        .to_owned();
    Some(ExtraUsage {
        balance_cents,
        monthly_limit_enabled: raw
            .get("monthlyChargeLimitEnabled")
            .and_then(Value::as_bool)
            == Some(true),
        monthly_limit_cents: as_int(monthly_limit.and_then(|money| money.get("priceInCents")))
            .unwrap_or(0),
        monthly_used_cents: as_int(monthly_used.and_then(|money| money.get("priceInCents")))
            .unwrap_or(0),
        currency,
    })
}

fn currency_symbol(currency: &str) -> &'static str {
    match currency.to_ascii_uppercase().as_str() {
        "CNY" => "¥",
        "USD" => "$",
        _ => "",
    }
}

fn format_money(cents: u64, currency: &str) -> String {
    let formatted = format!("{:.2}", cents as f64 / 100.0);
    let symbol = currency_symbol(currency);
    if symbol.is_empty() {
        format!("{formatted} {currency}")
    } else {
        format!("{symbol}{formatted}")
    }
}

fn format_block(payload: &Value, now: u64) -> Option<PlanUsage> {
    let mut rows = Vec::new();
    // The top-level `usage` entry carries no window; the TUI treats it as
    // the weekly allowance.
    if let Some(row) = payload
        .get("usage")
        .and_then(|usage| usage_row(usage, None, Some((1, "week"))))
    {
        rows.push(row);
    }
    if let Some(limits) = payload.get("limits").and_then(Value::as_array) {
        for item in limits {
            let window = item.get("window").and_then(normalize_window);
            let name = item.get("name").and_then(Value::as_str);
            if let Some(detail) = item.get("detail") {
                if let Some(row) = usage_row(detail, name, window) {
                    rows.push(row);
                }
            }
        }
    }
    let extra = extra_usage(payload);
    if rows.is_empty() && extra.is_none() {
        return None;
    }
    let hints: Vec<Option<String>> = rows
        .iter()
        .map(|row| {
            row.reset_at
                .as_deref()
                .and_then(|reset_at| reset_hint(reset_at, now))
        })
        .collect();
    let extra_detail = extra.as_ref().map(|extra| {
        let ratio = (extra.monthly_limit_enabled && extra.monthly_limit_cents > 0).then(|| {
            (extra.monthly_used_cents as f64 / extra.monthly_limit_cents as f64).clamp(0.0, 1.0)
        });
        let monthly_limit = if extra.monthly_limit_enabled && extra.monthly_limit_cents > 0 {
            format_money(extra.monthly_limit_cents, &extra.currency)
        } else {
            "Unlimited".to_owned()
        };
        let lines = [
            (
                "Used this month",
                format_money(extra.monthly_used_cents, &extra.currency),
            ),
            ("Monthly limit", monthly_limit),
            (
                "Balance",
                format_money(extra.balance_cents, &extra.currency),
            ),
        ];
        (ratio, lines)
    });
    let mut out = String::from("\n\nPlan usage");
    if rows.is_empty() {
        out.push_str("\n  No usage data available.");
    } else {
        let label_width = rows
            .iter()
            .map(|row| row.label.len())
            .max()
            .unwrap_or(0)
            .max(10);
        let percents: Vec<String> = rows
            .iter()
            .map(|row| format!("{}% used", usage_percent(row)))
            .collect();
        let pct_width = percents.iter().map(String::len).max().unwrap_or(0);
        for ((row, pct), hint) in rows.iter().zip(percents).zip(&hints) {
            out.push_str(&format!(
                "\n  {:<label_width$}  {}  {:<pct_width$}",
                row.label,
                progress_bar(used_ratio(row), 20),
                pct,
                label_width = label_width,
                pct_width = pct_width
            ));
            if let Some(hint) = hint {
                out.push_str(&format!("  {hint}"));
            }
        }
    }
    if let Some((ratio, lines)) = &extra_detail {
        out.push_str("\n\nExtra Usage");
        if let Some(ratio) = ratio {
            out.push_str(&format!("\n  {}", progress_bar(*ratio, 20)));
        }
        let label_width = lines
            .iter()
            .map(|(label, _)| label.len())
            .max()
            .unwrap_or(0);
        for (label, value) in lines {
            out.push_str(&format!(
                "\n  {:<label_width$}  {}",
                label,
                value,
                label_width = label_width
            ));
        }
    }
    let data = json!({
        "kind": "plan",
        "rows": rows
            .iter()
            .zip(&hints)
            .map(|(row, hint)| json!({
                "label": row.label,
                "percent": usage_percent(row),
                "ratio": used_ratio(row),
                "reset": hint,
            }))
            .collect::<Vec<_>>(),
        "extra": extra_detail
            .as_ref()
            .map(|(ratio, lines)| json!({
                "ratio": ratio,
                "lines": lines
                    .iter()
                    .map(|(label, value)| json!({"label": label, "value": value}))
                    .collect::<Vec<_>>(),
            })),
    });
    Some(PlanUsage { text: out, data })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cached_usage_and_failures_are_account_scoped_and_expire() {
        let home = PathBuf::from("fixture-kimi-home");
        let endpoints = ("http://fixture.invalid".into(), None);
        let mut cached = CachedPlanUsage {
            at: Instant::now(),
            home: home.clone(),
            access_token: "fixture-token".into(),
            endpoints: endpoints.clone(),
            usage: None,
        };
        assert!(cached.valid_for(&home, "fixture-token", &endpoints));
        assert!(!cached.valid_for(&home, "another-account", &endpoints));
        assert!(!cached.valid_for(Path::new("another-home"), "fixture-token", &endpoints));
        assert!(!cached.valid_for(
            &home,
            "fixture-token",
            &("http://another.invalid".into(), None)
        ));
        cached.at = Instant::now() - Duration::from_secs(3);
        assert!(
            !cached.valid_for(&home, "fixture-token", &endpoints),
            "failure permits prompt retry after its short TTL"
        );
        cached.usage = Some(PlanUsage {
            text: "fixture".into(),
            data: json!({}),
        });
        assert!(cached.valid_for(&home, "fixture-token", &endpoints));
        cached.at = Instant::now() - Duration::from_secs(31);
        assert!(!cached.valid_for(&home, "fixture-token", &endpoints));
    }

    #[test]
    #[ignore = "hits the real managed API with local credentials; prints timings only"]
    fn plan_usage_network_timing_probe() {
        let started = Instant::now();
        let home = kimi_home().unwrap();
        let credentials = Credentials::load(&home).unwrap();
        eprintln!(
            "credentials: {:?}, needs_refresh={}",
            started.elapsed(),
            credentials.expiring_soon()
        );
        let started = Instant::now();
        let client = shared_client().unwrap();
        eprintln!("client: {:?}", started.elapsed());
        for sample in 0..3 {
            let started = Instant::now();
            let result = fetch_usages(client, &home, &credentials.access_token);
            eprintln!(
                "network sample {sample}: {:?}, ok={}",
                started.elapsed(),
                result.is_some()
            );
        }
    }

    #[test]
    #[ignore = "hits the real managed API with the local credentials"]
    fn plan_usage_timing_probe() {
        let start = std::time::Instant::now();
        let first = plan_usage();
        let t_first = start.elapsed();
        let start = std::time::Instant::now();
        let second = plan_usage();
        let t_second = start.elapsed();
        eprintln!(
            "first: {:?} (ok={}), second: {:?} (ok={})",
            t_first,
            first.is_some(),
            t_second,
            second.is_some()
        );
    }

    fn sample_payload() -> Value {
        json!({
            "usage": {"limit": "100", "used": "1", "remaining": "99", "resetTime": "2026-09-15T12:59:52.319120Z"},
            "limits": [{
                "window": {"duration": 300, "timeUnit": "TIME_UNIT_MINUTE"},
                "detail": {"limit": "100", "used": "6", "remaining": "94", "resetTime": "2026-09-12T15:59:52.319120Z"}
            }]
        })
    }

    #[test]
    fn formats_plan_usage_like_the_tui_panel() {
        // 2026-09-12T15:23:16Z — matches the sample reset hints.
        let usage = format_block(&sample_payload(), 1789226596).unwrap();
        assert_eq!(
            usage.text,
            "\n\nPlan usage\n  Weekly limit  ░░░░░░░░░░░░░░░░░░░░  1% used  resets in 2d 21h 36m\n  5h limit      █░░░░░░░░░░░░░░░░░░░  6% used  resets in 36m"
        );
        assert_eq!(usage.data["kind"], "plan");
        assert_eq!(usage.data["rows"][0]["label"], "Weekly limit");
        assert_eq!(usage.data["rows"][1]["percent"], 6);
        assert_eq!(usage.data["rows"][1]["reset"], "resets in 36m");
    }

    #[test]
    fn payload_without_plan_rows_yields_no_block() {
        assert!(format_block(&json!({"totalQuota": {}}), 0).is_none());
    }

    #[test]
    fn expired_windows_report_reset() {
        let usage = format_block(
            &json!({"usage": {"limit": "100", "used": "100", "resetTime": "2026-09-12T15:23:16Z"}}),
            1789226596,
        )
        .unwrap();
        assert!(usage.text.contains("100% used  reset"));
    }

    #[test]
    fn window_normalization_only_collapses_whole_hours() {
        assert_eq!(
            normalize_window(&json!({"duration": 300, "timeUnit": "TIME_UNIT_MINUTE"})),
            Some((5, "hour"))
        );
        assert_eq!(
            normalize_window(&json!({"duration": 90, "timeUnit": "TIME_UNIT_MINUTE"})),
            Some((90, "minute"))
        );
        assert_eq!(
            normalize_window(&json!({"duration": 7, "timeUnit": "TIME_UNIT_DAY"})),
            Some((7, "day"))
        );
        assert_eq!(
            normalize_window(&json!({"duration": 1, "timeUnit": "TIME_UNIT_UNKNOWN"})),
            None
        );
    }

    #[test]
    fn labels_follow_the_tui_rules() {
        assert_eq!(row_label(None, Some((1, "week"))), "Weekly limit");
        assert_eq!(row_label(None, Some((5, "hour"))), "5h limit");
        assert_eq!(row_label(None, Some((90, "minute"))), "90m limit");
        assert_eq!(row_label(Some("Burst"), None), "Burst");
        assert_eq!(row_label(None, None), "Limit");
    }

    #[test]
    fn percent_ceils_and_clamps() {
        let row = |used, limit| UsageRow {
            label: String::new(),
            used,
            limit,
            reset_at: None,
        };
        assert_eq!(usage_percent(&row(1, 100)), 1);
        assert_eq!(usage_percent(&row(0, 100)), 0);
        assert_eq!(usage_percent(&row(150, 100)), 100);
        assert_eq!(usage_percent(&row(5, 0)), 0);
    }

    #[test]
    fn duration_format_matches_tui() {
        assert_eq!(
            format_duration(2 * 86400 + 21 * 3600 + 36 * 60),
            "2d 21h 36m"
        );
        assert_eq!(format_duration(36 * 60), "36m");
        assert_eq!(format_duration(45), "45s");
        assert_eq!(format_duration(0), "0s");
    }

    #[test]
    fn booster_wallet_renders_extra_usage() {
        let payload = json!({
            "boosterWallet": {
                "balance": {"type": "BOOSTER", "amount": "10000000000", "amountLeft": "8540000000"},
                "monthlyChargeLimitEnabled": true,
                "monthlyChargeLimit": {"priceInCents": "5000", "currency": "CNY"},
                "monthlyUsed": {"priceInCents": "1200", "currency": "CNY"}
            }
        });
        let usage = format_block(&payload, 0).unwrap();
        assert!(usage.text.contains("\n\nExtra Usage"));
        assert!(usage.text.contains("Used this month  ¥12.00"));
        assert!(usage.text.contains("Monthly limit    ¥50.00"));
        assert!(usage.text.contains("Balance          ¥85.40"));
        assert_eq!(usage.data["extra"]["lines"][2]["value"], "¥85.40");
        assert_eq!(usage.data["extra"]["ratio"].as_f64().unwrap(), 0.24);
    }

    #[test]
    fn non_booster_wallet_is_ignored() {
        let payload = json!({"boosterWallet": {"balance": {"type": "CASH", "amount": "1000000"}}});
        assert!(format_block(&payload, 0).is_none());
    }
}
