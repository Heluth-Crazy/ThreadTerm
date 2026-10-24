use anyhow::{anyhow, Result};
use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, TimeZone, Utc, Weekday};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Interval {
    pub start_ms: i64,
    pub end_ms: i64,
    pub estimated: bool,
}

/// Native point facts join their next point only while the idle gap is below
/// five minutes. Explicit live turn intervals are already authoritative.
pub fn union_intervals(mut intervals: Vec<Interval>) -> (i64, bool) {
    intervals.retain(|i| i.end_ms > i.start_ms);
    intervals.sort_by_key(|i| (i.start_ms, i.end_ms));
    let mut total = 0;
    let mut estimated = false;
    let mut current: Option<Interval> = None;
    for next in intervals {
        match current {
            None => current = Some(next),
            Some(mut active) if next.start_ms <= active.end_ms => {
                active.end_ms = active.end_ms.max(next.end_ms);
                active.estimated |= next.estimated;
                current = Some(active);
            }
            Some(active) => {
                total += active.end_ms - active.start_ms;
                estimated |= active.estimated;
                current = Some(next);
            }
        }
    }
    if let Some(active) = current {
        total += active.end_ms - active.start_ms;
        estimated |= active.estimated;
    }
    (total, estimated)
}

pub fn timestamp_millis(timestamp: &str) -> Result<i64> {
    Ok(DateTime::parse_from_rfc3339(timestamp)
        .map_err(|_| anyhow!("invalid usage timestamp"))?
        .timestamp_millis())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Granularity {
    Day,
    Week,
    Month,
}

pub fn local_day(timestamp: &str) -> Result<String> {
    Ok(DateTime::parse_from_rfc3339(timestamp)
        .map_err(|_| anyhow!("invalid usage timestamp"))?
        .with_timezone(&Local)
        .date_naive()
        .format("%F")
        .to_string())
}

pub fn bucket_start(day: &str, granularity: Granularity, week_start: Weekday) -> Result<String> {
    let date = NaiveDate::parse_from_str(day, "%Y-%m-%d")?;
    let start = match granularity {
        Granularity::Day => date,
        Granularity::Month => date.with_day(1).ok_or_else(|| anyhow!("invalid month"))?,
        Granularity::Week => {
            let distance = (7 + date.weekday().num_days_from_monday() as i64
                - week_start.num_days_from_monday() as i64)
                % 7;
            date - Duration::days(distance)
        }
    };
    Ok(start.format("%F").to_string())
}

/// Produces a UTC half-open range for the current machine's local calendar day.
pub fn local_day_range(day: &str) -> Result<(String, String)> {
    let date = NaiveDate::parse_from_str(day, "%Y-%m-%d")?;
    let start = Local
        .from_local_datetime(
            &date
                .and_hms_opt(0, 0, 0)
                .ok_or_else(|| anyhow!("invalid day"))?,
        )
        .single()
        .ok_or_else(|| anyhow!("ambiguous local midnight"))?
        .with_timezone(&Utc)
        .to_rfc3339();
    let next = date.succ_opt().ok_or_else(|| anyhow!("date overflow"))?;
    let end = Local
        .from_local_datetime(
            &next
                .and_hms_opt(0, 0, 0)
                .ok_or_else(|| anyhow!("invalid day"))?,
        )
        .single()
        .ok_or_else(|| anyhow!("ambiguous local midnight"))?
        .with_timezone(&Utc)
        .to_rfc3339();
    Ok((start, end))
}

pub fn parse_granularity(value: &str) -> Result<Granularity> {
    match value {
        "day" => Ok(Granularity::Day),
        "week" => Ok(Granularity::Week),
        "month" => Ok(Granularity::Month),
        _ => Err(anyhow!("invalid granularity")),
    }
}

pub fn parse_week_start(value: Option<&str>) -> Result<Weekday> {
    match value.unwrap_or("auto") {
        "auto" => Ok(locale_week_start()),
        "monday" => Ok(Weekday::Mon),
        "sunday" => Ok(Weekday::Sun),
        _ => Err(anyhow!("invalid weekStart")),
    }
}

fn locale_week_start() -> Weekday {
    #[cfg(windows)]
    {
        let mut buffer = [0_u16; 8];
        // LOCALE_IFIRSTDAYOFWEEK: Monday=0, Sunday=6, user default locale.
        let count = unsafe {
            windows_sys::Win32::Globalization::GetLocaleInfoEx(
                std::ptr::null(),
                0x100C,
                buffer.as_mut_ptr(),
                buffer.len() as i32,
            )
        };
        if count > 0 {
            return match buffer[0] {
                49 => Weekday::Tue,
                50 => Weekday::Wed,
                51 => Weekday::Thu,
                52 => Weekday::Fri,
                53 => Weekday::Sat,
                54 => Weekday::Sun,
                _ => Weekday::Mon,
            };
        }
    }
    let locale = ["LC_ALL", "LC_TIME", "LANG"]
        .iter()
        .find_map(|key| std::env::var(key).ok().filter(|s| !s.is_empty()))
        .unwrap_or_default()
        .replace('-', "_");
    let region = locale
        .split('_')
        .nth(1)
        .unwrap_or("")
        .split('.')
        .next()
        .unwrap_or("");
    match region {
        "US" | "CA" | "JP" | "PH" | "TW" | "HK" | "KR" | "IL" | "MX" | "BR" => Weekday::Sun,
        _ => Weekday::Mon,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn overlapping_sessions_are_a_union() {
        let (ms, estimated) = union_intervals(vec![
            Interval {
                start_ms: 0,
                end_ms: 10,
                estimated: true,
            },
            Interval {
                start_ms: 5,
                end_ms: 20,
                estimated: false,
            },
        ]);
        assert_eq!(ms, 20);
        assert!(estimated);
    }
    #[test]
    fn native_idle_gap_is_not_an_interval() {
        let (ms, _) = union_intervals(vec![
            Interval {
                start_ms: 0,
                end_ms: 1,
                estimated: true,
            },
            Interval {
                start_ms: 301_001,
                end_ms: 301_002,
                estimated: true,
            },
        ]);
        assert_eq!(ms, 2);
    }
}
