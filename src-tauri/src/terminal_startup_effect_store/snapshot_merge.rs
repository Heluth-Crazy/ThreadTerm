use super::{StartupEffectKind, StartupEffectRecord};
use std::collections::BTreeMap;

fn retired(record: &StartupEffectRecord) -> bool {
    match record.kind {
        StartupEffectKind::RecordUserSubmit => {
            matches!(record.timeline, Some(super::StartupTimelineState::Retired))
        }
        StartupEffectKind::BindProviderSession | StartupEffectKind::DiscoverProviderSession => {
            matches!(record.binding, Some(super::StartupBindingState::Retired))
        }
    }
}

pub(super) fn set_retired(record: &mut StartupEffectRecord) {
    match record.kind {
        StartupEffectKind::RecordUserSubmit => {
            record.timeline = Some(super::StartupTimelineState::Retired);
            record.binding = None;
        }
        StartupEffectKind::BindProviderSession | StartupEffectKind::DiscoverProviderSession => {
            record.binding = Some(super::StartupBindingState::Retired);
            record.timeline = None;
        }
    }
}

fn index(
    records: &[StartupEffectRecord],
    side: &str,
) -> Result<BTreeMap<String, StartupEffectRecord>, String> {
    let mut indexed = BTreeMap::new();
    for record in records {
        if indexed
            .insert(record.token.clone(), record.clone())
            .is_some()
        {
            return Err(format!(
                "duplicate {side} startup effect token {}",
                record.token
            ));
        }
    }
    Ok(indexed)
}

/// Union startup records without making an epoch decision.
///
/// The current record is the immutable authority for kind and at. Retirement
/// is monotonic across either side. Sorted token order makes retries
/// deterministic and keeps this helper independent of card/epoch handling.
pub(super) fn merge_effect_records(
    current: &[StartupEffectRecord],
    incoming: &[StartupEffectRecord],
    incoming_message_count: u64,
) -> Result<(Vec<StartupEffectRecord>, u64), String> {
    let current = index(current, "current")?;
    let incoming = index(incoming, "incoming")?;
    let incoming_submit_count = u64::try_from(
        incoming
            .values()
            .filter(|record| record.kind == StartupEffectKind::RecordUserSubmit)
            .count(),
    )
    .map_err(|_| "incoming submit record count overflow".to_string())?;
    let mut merged = BTreeMap::new();

    for (token, current_record) in &current {
        let mut record = current_record.clone();
        if let Some(incoming_record) = incoming.get(token) {
            if current_record.kind == incoming_record.kind
                && (retired(current_record) || retired(incoming_record))
            {
                set_retired(&mut record);
            }
        }
        merged.insert(token.clone(), record);
    }
    for (token, incoming_record) in &incoming {
        if merged.contains_key(token) {
            continue;
        }
        merged.insert(token.clone(), incoming_record.clone());
    }

    let union_submit_count = u64::try_from(
        merged
            .values()
            .filter(|record| record.kind == StartupEffectKind::RecordUserSubmit)
            .count(),
    )
    .map_err(|_| "merged submit record count overflow".to_string())?;
    let manual_count = incoming_message_count.saturating_sub(incoming_submit_count);
    let message_count = manual_count
        .checked_add(union_submit_count)
        .ok_or_else(|| "merged message count overflow".to_string())?;
    Ok((merged.into_values().collect(), message_count))
}

#[cfg(test)]
mod tests {
    use super::super::parse_startup_side_effects;
    use super::*;
    use serde_json::{json, Value};

    fn token(number: u8) -> String {
        format!("{number:032x}")
    }

    fn records(value: Value) -> Vec<StartupEffectRecord> {
        parse_startup_side_effects(&json!({
            "schema": 1,
            "projectionEpoch": token(1),
            "applied": value,
        }))
        .expect("valid records")
        .applied
    }

    fn submit(number: u8, at: u64, status: &str) -> Value {
        json!({
            "token": token(number),
            "kind": "recordUserSubmit",
            "at": at,
            "timeline": status,
        })
    }

    fn binding(number: u8, at: u64, status: &str) -> Value {
        json!({
            "token": token(number),
            "kind": "bindProviderSession",
            "at": at,
            "binding": status,
        })
    }

    #[test]
    fn effect_first_and_stale_first_are_equivalent() {
        let fresh = records(json!([submit(2, 20, "present"), binding(3, 30, "active")]));
        let stale = records(json!([submit(2, 20, "present")]));
        let first = merge_effect_records(&fresh, &stale, 1).expect("fresh current");
        let stale_first = merge_effect_records(&stale, &fresh, 1).expect("stale current");
        assert_eq!(first, stale_first);
    }

    #[test]
    fn fresh_snapshot_does_not_double_count_and_retirement_cannot_resurrect() {
        let current = records(json!([submit(2, 20, "retired")]));
        let incoming = records(json!([submit(2, 999, "present")]));
        let (merged, count) = merge_effect_records(&current, &incoming, 1).expect("merge");
        assert_eq!(count, 1);
        assert_eq!(merged[0].at, 20);
        assert!(retired(&merged[0]));
    }

    #[test]
    fn current_kind_and_at_win_same_token_conflicts() {
        let current = records(json!([submit(2, 20, "present")]));
        let incoming = records(json!([binding(2, 99, "retired")]));
        let (merged, _) = merge_effect_records(&current, &incoming, 1).expect("merge");
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].kind, StartupEffectKind::RecordUserSubmit);
        assert_eq!(merged[0].at, 20);
        assert_eq!(
            merged[0].timeline,
            Some(super::super::StartupTimelineState::Present)
        );
    }

    #[test]
    fn manual_count_underflow_is_zero_and_overflow_is_reported() {
        let incoming = records(json!([submit(2, 20, "present")]));
        let (_, underflow) = merge_effect_records(&[], &incoming, 0).expect("underflow clamp");
        assert_eq!(underflow, 1);
        let current = records(json!([submit(3, 30, "present")]));
        assert!(merge_effect_records(&current, &[], u64::MAX).is_err());
    }

    #[test]
    fn order_is_sorted_and_merge_is_idempotent() {
        let incoming = records(json!([
            binding(9, 90, "active"),
            submit(3, 30, "present"),
            submit(2, 20, "present"),
        ]));
        let (once, count) = merge_effect_records(&[], &incoming, 3).expect("first merge");
        let (twice, count_again) = merge_effect_records(&once, &once, count).expect("retry merge");
        assert_eq!(once, twice);
        assert_eq!(count, count_again);
        assert_eq!(
            once.iter()
                .map(|record| record.token.as_str())
                .collect::<Vec<_>>(),
            vec![token(2), token(3), token(9)]
        );
    }
}
