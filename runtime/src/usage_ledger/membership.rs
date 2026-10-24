use anyhow::{anyhow, Result};
use chrono::{Datelike, NaiveDate};
use rusqlite::{params, params_from_iter, types::Value, Connection, OptionalExtension};
use std::{
    collections::BTreeMap,
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};

use super::store;

const STATE_KEY: &str = "day-membership-complete";
const REBUILD_BATCH_SIZE: usize = 32;

pub fn initialize(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS usage_session_day_sets (
            slice_id INTEGER PRIMARY KEY,
            base_day INTEGER NOT NULL,
            bits BLOB NOT NULL
        );
        INSERT OR IGNORE INTO usage_ledger_state(key, value)
        SELECT 'day-membership-complete', '1'
        WHERE NOT EXISTS (SELECT 1 FROM usage_facts LIMIT 1);",
    )?;
    Ok(())
}

pub fn write_slice(conn: &Connection, slice_id: i64, days: &[String]) -> Result<()> {
    let (base_day, bits) = encode_days(days)?;
    conn.execute(
        "INSERT INTO usage_session_day_sets(slice_id, base_day, bits)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(slice_id) DO UPDATE SET
            base_day = excluded.base_day,
            bits = excluded.bits",
        params![slice_id, base_day, bits],
    )?;
    Ok(())
}

pub fn remove_session(conn: &Connection, provider: &str, native_session_id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM usage_session_day_sets
         WHERE slice_id IN (
            SELECT id
            FROM usage_session_slices
            WHERE provider = ?1 AND native_session_id = ?2
         )",
        params![provider, native_session_id],
    )?;
    Ok(())
}

pub fn ready(conn: &Connection) -> bool {
    conn.query_row(
        "SELECT value FROM usage_ledger_state WHERE key = ?1",
        [STATE_KEY],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
    .as_deref()
        == Some("1")
}

pub fn rebuild(conn: &Connection, cancel: &AtomicBool) -> Result<bool> {
    let mut cursor = i64::MIN;
    let mut completion_cleared = false;

    loop {
        if cancel.load(Ordering::Relaxed) {
            return Ok(false);
        }

        let slice_ids = missing_slice_page(conn, cursor)?;
        if slice_ids.is_empty() {
            if !ready(conn) {
                write_completion_state(conn, "1")?;
            }
            return Ok(true);
        }

        if !completion_cleared {
            // Commit the invalidation before doing any backfill work so a failed or
            // cancelled batch can never leave a stale ready marker behind.
            write_completion_state(conn, "0")?;
            completion_cleared = true;
        }

        let write_started = Instant::now();
        let tx = super::write_priority::transaction(conn)?;
        let mut days_by_slice = slice_ids
            .iter()
            .copied()
            .map(|slice_id| (slice_id, Vec::<String>::new()))
            .collect::<BTreeMap<_, _>>();

        let placeholders = std::iter::repeat("?")
            .take(slice_ids.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT slice_id, local_day
             FROM usage_session_prefix
             WHERE has_requests = 1 AND slice_id IN ({placeholders})
             ORDER BY slice_id, local_day"
        );
        {
            let mut statement = tx.prepare(&sql)?;
            let mut rows = statement.query(params_from_iter(slice_ids.iter()))?;
            while let Some(row) = rows.next()? {
                let slice_id = row.get::<_, i64>(0)?;
                let local_day = row.get::<_, String>(1)?;
                if let Some(days) = days_by_slice.get_mut(&slice_id) {
                    days.push(local_day);
                }
            }
        }

        for (slice_id, days) in days_by_slice {
            write_slice(&tx, slice_id, &days)?;
        }
        tx.commit()?;
        store::record_write_duration(write_started);
        store::checkpoint_index_connection(conn)?;

        cursor = *slice_ids.last().expect("a non-empty rebuild page");
    }
}

pub fn count_periods(
    conn: &Connection,
    clause: &str,
    args: &[Value],
    periods: &[(String, i32, i32)],
) -> Result<BTreeMap<(String, String), i64>> {
    let mut counts = BTreeMap::new();
    if periods.is_empty() {
        return Ok(counts);
    }

    let sql = format!(
        "SELECT s.session_key, s.provider, b.base_day, b.bits
         FROM usage_session_slices s
         JOIN usage_session_day_sets b ON b.slice_id = s.id
         {clause}
         ORDER BY s.session_key, s.provider, s.id"
    );
    let mut statement = conn.prepare(&sql)?;
    let mut rows = statement.query(params_from_iter(args.iter()))?;
    let mut current: Option<(i64, String)> = None;
    let mut present = vec![false; periods.len()];

    while let Some(row) = rows.next()? {
        let session_key = row.get::<_, i64>(0)?;
        let provider = row.get::<_, String>(1)?;
        let identity_changed = matches!(
            current.as_ref(),
            Some((key, current_provider))
                if *key != session_key || current_provider != &provider
        );
        if identity_changed {
            flush_presence(&mut counts, current.as_ref(), periods, &present);
            present.fill(false);
        }
        if current.as_ref().map_or(true, |(key, current_provider)| {
            *key != session_key || current_provider != &provider
        }) {
            current = Some((session_key, provider));
        }

        let base_day = row.get::<_, i32>(2)?;
        let bits = row.get::<_, Vec<u8>>(3)?;
        for (index, (_, from_day, to_day)) in periods.iter().enumerate() {
            if !present[index] && bitmap_intersects(base_day, &bits, *from_day, *to_day) {
                present[index] = true;
            }
        }
    }

    flush_presence(&mut counts, current.as_ref(), periods, &present);
    Ok(counts)
}

fn missing_slice_page(conn: &Connection, cursor: i64) -> Result<Vec<i64>> {
    let mut statement = conn.prepare(
        "SELECT s.id
         FROM usage_session_slices s
         LEFT JOIN usage_session_day_sets b ON b.slice_id = s.id
         WHERE s.id > ?1 AND b.slice_id IS NULL
         ORDER BY s.id
         LIMIT ?2",
    )?;
    let rows = statement.query_map(params![cursor, REBUILD_BATCH_SIZE as i64], |row| {
        row.get::<_, i64>(0)
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn write_completion_state(conn: &Connection, value: &str) -> Result<()> {
    let write_started = Instant::now();
    let tx = super::write_priority::transaction(conn)?;
    tx.execute(
        "INSERT INTO usage_ledger_state(key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![STATE_KEY, value],
    )?;
    tx.commit()?;
    store::record_write_duration(write_started);
    store::checkpoint_index_connection(conn)?;
    Ok(())
}

fn encode_days(days: &[String]) -> Result<(i32, Vec<u8>)> {
    let mut ordinals = days
        .iter()
        .map(|day| {
            let date = NaiveDate::parse_from_str(day, "%Y-%m-%d")?;
            if !(0..=9999).contains(&date.year()) {
                return Err(anyhow!("usage_membership_day_out_of_range"));
            }
            Ok(date.num_days_from_ce())
        })
        .collect::<Result<Vec<_>>>()?;
    if ordinals.is_empty() {
        return Ok((0, Vec::new()));
    }

    ordinals.sort_unstable();
    ordinals.dedup();
    let base_day = ordinals[0];
    let last_day = *ordinals.last().expect("a non-empty ordinal list");
    let word_count = ((last_day - base_day) as usize / 64) + 1;
    let mut words = vec![0_u64; word_count];
    for ordinal in ordinals {
        let offset = (ordinal - base_day) as usize;
        words[offset / 64] |= 1_u64 << (offset % 64);
    }

    let mut bits = Vec::with_capacity(words.len() * 8);
    for word in words {
        bits.extend_from_slice(&word.to_le_bytes());
    }
    Ok((base_day, bits))
}

pub(super) fn bitmap_intersects(base_day: i32, bits: &[u8], from_day: i32, to_day: i32) -> bool {
    if bits.is_empty() || from_day >= to_day {
        return false;
    }

    let bitmap_start = i64::from(base_day);
    let bitmap_end = bitmap_start + (bits.len() as i64 * 8);
    let clipped_start = i64::from(from_day).max(bitmap_start);
    let clipped_end = i64::from(to_day).min(bitmap_end);
    if clipped_start >= clipped_end {
        return false;
    }

    let first_bit = (clipped_start - bitmap_start) as usize;
    let last_bit_exclusive = (clipped_end - bitmap_start) as usize;
    let first_word = first_bit / 64;
    let last_word = (last_bit_exclusive - 1) / 64;

    for word_index in first_word..=last_word {
        let byte_start = word_index * 8;
        let Some(bytes) = bits.get(byte_start..byte_start + 8) else {
            return false;
        };
        let word = u64::from_le_bytes(bytes.try_into().expect("an eight-byte word"));
        let low_bit = if word_index == first_word {
            first_bit % 64
        } else {
            0
        };
        let high_bit = if word_index == last_word {
            ((last_bit_exclusive - 1) % 64) + 1
        } else {
            64
        };
        let upper_mask = if high_bit == 64 {
            u64::MAX
        } else {
            (1_u64 << high_bit) - 1
        };
        let lower_mask = if low_bit == 0 {
            0
        } else {
            (1_u64 << low_bit) - 1
        };
        if word & (upper_mask & !lower_mask) != 0 {
            return true;
        }
    }
    false
}

fn flush_presence(
    counts: &mut BTreeMap<(String, String), i64>,
    current: Option<&(i64, String)>,
    periods: &[(String, i32, i32)],
    present: &[bool],
) {
    let Some((_, provider)) = current else {
        return;
    };
    for ((bucket, _, _), is_present) in periods.iter().zip(present) {
        if *is_present {
            *counts
                .entry((bucket.clone(), provider.clone()))
                .or_default() += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ordinal(day: &str) -> i32 {
        NaiveDate::parse_from_str(day, "%Y-%m-%d")
            .unwrap()
            .num_days_from_ce()
    }

    #[test]
    fn bitmap_handles_word_and_year_boundaries() {
        let base = ordinal("2025-12-31");
        let at_63 = NaiveDate::from_num_days_from_ce_opt(base + 63)
            .unwrap()
            .format("%Y-%m-%d")
            .to_string();
        let at_64 = NaiveDate::from_num_days_from_ce_opt(base + 64)
            .unwrap()
            .format("%Y-%m-%d")
            .to_string();
        let days = vec![
            "2025-12-31".to_owned(),
            "2026-01-01".to_owned(),
            at_63,
            at_64,
        ];
        let (encoded_base, bits) = encode_days(&days).unwrap();

        assert_eq!(encoded_base, base);
        assert_eq!(bits.len(), 16);
        assert!(bitmap_intersects(base, &bits, base, base + 1));
        assert!(bitmap_intersects(base, &bits, base + 1, base + 2));
        assert!(!bitmap_intersects(base, &bits, base + 2, base + 63));
        assert!(bitmap_intersects(base, &bits, base + 63, base + 64));
        assert!(bitmap_intersects(base, &bits, base + 64, base + 65));
        assert!(!bitmap_intersects(base, &bits, base + 65, base + 100));
    }

    #[test]
    fn period_counts_union_slices_for_one_native_session() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE usage_ledger_state(key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE usage_facts(fact_key TEXT PRIMARY KEY);
             CREATE TABLE usage_session_slices(
                id INTEGER PRIMARY KEY,
                session_key INTEGER NOT NULL,
                provider TEXT NOT NULL,
                native_session_id TEXT NOT NULL,
                mode INTEGER NOT NULL,
                model_mask INTEGER NOT NULL,
                model TEXT NOT NULL,
                project_id TEXT NOT NULL,
                scope TEXT NOT NULL
             );",
        )
        .unwrap();
        initialize(&conn).unwrap();
        for (id, session_key, provider) in [(1, 10, "a"), (2, 10, "a"), (3, 11, "a"), (4, 12, "b")]
        {
            conn.execute(
                "INSERT INTO usage_session_slices
                 (id, session_key, provider, native_session_id, mode, model_mask, model, project_id, scope)
                 VALUES (?1, ?2, ?3, ?4, 0, 0, '', '', '')",
                params![id, session_key, provider, format!("native-{session_key}")],
            )
            .unwrap();
        }
        write_slice(&conn, 1, &["2025-12-31".to_owned()]).unwrap();
        write_slice(&conn, 2, &["2026-01-02".to_owned()]).unwrap();
        write_slice(&conn, 3, &["2026-01-02".to_owned()]).unwrap();
        write_slice(&conn, 4, &["2026-01-02".to_owned()]).unwrap();

        let periods = vec![
            (
                "week".to_owned(),
                ordinal("2025-12-29"),
                ordinal("2026-01-05"),
            ),
            (
                "gap".to_owned(),
                ordinal("2026-01-01"),
                ordinal("2026-01-02"),
            ),
        ];
        let counts = count_periods(
            &conn,
            "WHERE s.mode = ? AND s.model_mask = ?",
            &[Value::Integer(0), Value::Integer(0)],
            &periods,
        )
        .unwrap();

        assert_eq!(counts.get(&("week".to_owned(), "a".to_owned())), Some(&2));
        assert_eq!(counts.get(&("week".to_owned(), "b".to_owned())), Some(&1));
        assert!(!counts.keys().any(|(bucket, _)| bucket == "gap"));
    }
}
