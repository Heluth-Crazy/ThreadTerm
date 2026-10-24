use anyhow::{anyhow, Result};
use chrono::{Datelike, NaiveDate};
use rusqlite::{params, Connection, OptionalExtension};
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};

use super::store;

const STATE_KEY: &str = "session-sort-ranges-complete";
const DEFAULT_STATE_KEY: &str = "session-default-sort-ranges-packed-v1";
const REBUILD_BATCH_SIZE: usize = 32;
const DAY_BYTES: usize = std::mem::size_of::<i32>();
const VALUE_BYTES: usize = std::mem::size_of::<i64>();
// magic:i64, version:u8, width:u8, reserved:u16, len:u32, base:i64,
// followed by `len` unsigned little-endian offsets from `base`.
const PACKED_HEADER_BYTES: usize = 24;
const PACKED_VERSION: u8 = 1;
const DAY_MAGIC: i64 = i64::from_le_bytes([0, 0, 0, 128, b'R', b'N', b'G', 1]);
const VALUE_MAGIC: i64 = i64::from_le_bytes(*b"TTVAL\x01\0\x80");

/// Creates the additive compact range index. Each metric has a separate blob so
/// sort queries read only the cumulative values they need.
pub fn initialize(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS usage_session_sort_ranges (
            slice_id INTEGER PRIMARY KEY,
            days BLOB NOT NULL,
            tokens BLOB NOT NULL,
            costs BLOB NOT NULL,
            requests BLOB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS usage_session_default_sort_ranges_packed (
            slice_id INTEGER PRIMARY KEY,
            days BLOB NOT NULL,
            tokens BLOB NOT NULL,
            costs BLOB NOT NULL,
            requests BLOB NOT NULL
        );
        INSERT OR IGNORE INTO usage_ledger_state(key, value)
        SELECT 'session-sort-ranges-complete', '1'
        WHERE NOT EXISTS (SELECT 1 FROM usage_facts LIMIT 1);
        INSERT OR IGNORE INTO usage_ledger_state(key, value)
        SELECT 'session-default-sort-ranges-packed-v1', '1'
        WHERE NOT EXISTS (
            SELECT 1 FROM usage_session_slices WHERE model_mask = 0 LIMIT 1
        );",
    )?;
    Ok(())
}

/// Replaces one slice with compact, little-endian cumulative arrays derived
/// from the canonical day prefix. Empty slices still get a row so rebuilds do
/// not repeatedly discover them as missing.
pub fn refresh(conn: &Connection, slice_id: i64) -> Result<()> {
    if conn.is_autocommit() {
        let tx = super::write_priority::transaction(conn)?;
        refresh_inner(&tx, slice_id)?;
        tx.commit()?;
    } else {
        refresh_inner(conn, slice_id)?;
    }
    Ok(())
}

fn refresh_inner(conn: &Connection, slice_id: i64) -> Result<()> {
    let mut days = Vec::<i64>::new();
    let mut tokens = Vec::<i64>::new();
    let mut costs = Vec::new();
    let mut requests = Vec::<i64>::new();
    let mut previous_day = None;
    let mut previous_tokens = None;
    let mut previous_cost = None;
    let mut previous_requests = None;

    let mut statement = conn.prepare(
        "SELECT local_day, tokens, cost, requests
         FROM usage_session_prefix
         WHERE slice_id = ?1
         ORDER BY local_day",
    )?;
    let mut rows = statement.query([slice_id])?;
    while let Some(row) = rows.next()? {
        let day = day_ordinal(&row.get::<_, String>(0)?)?;
        let token_total = row.get::<_, i64>(1)?;
        let cost_total = row.get::<_, f64>(2)?;
        let request_total = row.get::<_, i64>(3)?;
        if previous_day.is_some_and(|previous| day <= previous)
            || previous_tokens.is_some_and(|previous| token_total < previous)
            || previous_cost.is_some_and(|previous| cost_total < previous)
            || previous_requests.is_some_and(|previous| request_total < previous)
            || !cost_total.is_finite()
        {
            return Err(anyhow!("invalid_usage_session_prefix"));
        }
        days.push(i64::from(day));
        tokens.push(token_total);
        costs.extend_from_slice(&cost_total.to_le_bytes());
        requests.push(request_total);
        previous_day = Some(day);
        previous_tokens = Some(token_total);
        previous_cost = Some(cost_total);
        previous_requests = Some(request_total);
    }
    drop(rows);
    drop(statement);

    let days = pack_integers(&days, DAY_MAGIC)?;
    let tokens = pack_integers(&tokens, VALUE_MAGIC)?;
    let requests = pack_integers(&requests, VALUE_MAGIC)?;

    conn.execute(
        "INSERT INTO usage_session_sort_ranges(slice_id, days, tokens, costs, requests)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(slice_id) DO UPDATE SET
            days = excluded.days,
            tokens = excluded.tokens,
            costs = excluded.costs,
            requests = excluded.requests",
        params![slice_id, &days, &tokens, &costs, &requests],
    )?;
    let model_mask = conn
        .query_row(
            "SELECT model_mask FROM usage_session_slices WHERE id = ?1",
            [slice_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    if model_mask == Some(0) {
        conn.execute(
            "INSERT INTO usage_session_default_sort_ranges_packed(
                slice_id, days, tokens, costs, requests
             ) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(slice_id) DO UPDATE SET
                days = excluded.days,
                tokens = excluded.tokens,
                costs = excluded.costs,
                requests = excluded.requests",
            params![slice_id, days, tokens, costs, requests],
        )?;
    } else {
        conn.execute(
            "DELETE FROM usage_session_default_sort_ranges_packed WHERE slice_id = ?1",
            [slice_id],
        )?;
    }
    Ok(())
}

/// Deletes compact rows before their owning slices are replaced.
pub fn remove_session(conn: &Connection, provider: &str, native_session_id: &str) -> Result<()> {
    if conn.is_autocommit() {
        let tx = super::write_priority::transaction(conn)?;
        remove_session_inner(&tx, provider, native_session_id)?;
        tx.commit()?;
    } else {
        remove_session_inner(conn, provider, native_session_id)?;
    }
    Ok(())
}

fn remove_session_inner(conn: &Connection, provider: &str, native_session_id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM usage_session_default_sort_ranges_packed
         WHERE slice_id IN (
            SELECT id FROM usage_session_slices
            WHERE provider = ?1 AND native_session_id = ?2
         )",
        params![provider, native_session_id],
    )?;
    conn.execute(
        "DELETE FROM usage_session_sort_ranges
         WHERE slice_id IN (
            SELECT id FROM usage_session_slices
            WHERE provider = ?1 AND native_session_id = ?2
         )",
        params![provider, native_session_id],
    )?;
    Ok(())
}

pub fn ready(conn: &Connection) -> bool {
    state_ready(conn, STATE_KEY) && default_ready(conn)
}

pub fn default_ready(conn: &Connection) -> bool {
    state_ready(conn, DEFAULT_STATE_KEY)
}

pub fn default_table_available(conn: &Connection) -> bool {
    conn.query_row(
        "SELECT 1 FROM sqlite_schema
         WHERE type = 'table' AND name = 'usage_session_default_sort_ranges_packed'",
        [],
        |_| Ok(()),
    )
    .optional()
    .ok()
    .flatten()
    .is_some()
}

fn state_ready(conn: &Connection, key: &str) -> bool {
    conn.query_row(
        "SELECT value FROM usage_ledger_state WHERE key = ?1",
        [key],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
    .as_deref()
        == Some("1")
}

/// Backfills absent rows in bounded transactions. Cancellation leaves the
/// readiness marker cleared until a later worker completes the remaining rows.
pub fn rebuild(conn: &Connection, cancelled: &AtomicBool) -> Result<bool> {
    if !rebuild_legacy(conn, cancelled)? {
        return Ok(false);
    }
    rebuild_default(conn, cancelled)
}

fn rebuild_legacy(conn: &Connection, cancelled: &AtomicBool) -> Result<bool> {
    let mut cursor = i64::MIN;
    let mut completion_cleared = false;
    loop {
        if cancelled.load(Ordering::Relaxed) {
            return Ok(false);
        }
        let slice_ids = missing_slice_page(conn, cursor)?;
        if slice_ids.is_empty() {
            if !state_ready(conn, STATE_KEY) {
                write_completion_state(conn, STATE_KEY, "1")?;
            }
            return Ok(true);
        }
        if !completion_cleared {
            write_completion_state(conn, STATE_KEY, "0")?;
            completion_cleared = true;
        }

        let write_started = Instant::now();
        let tx = super::write_priority::transaction(conn)?;
        for slice_id in &slice_ids {
            refresh(&tx, *slice_id)?;
        }
        tx.commit()?;
        store::record_write_duration(write_started);
        store::checkpoint_index_connection(conn)?;
        cursor = *slice_ids.last().expect("a non-empty rebuild page");
    }
}

fn rebuild_default(conn: &Connection, cancelled: &AtomicBool) -> Result<bool> {
    let mut cursor = i64::MIN;
    let mut completion_cleared = false;
    loop {
        if cancelled.load(Ordering::Relaxed) {
            return Ok(false);
        }
        let slice_ids = missing_default_slice_page(conn, cursor)?;
        if slice_ids.is_empty() {
            if !default_ready(conn) {
                write_completion_state(conn, DEFAULT_STATE_KEY, "1")?;
            }
            return Ok(true);
        }
        if !completion_cleared {
            write_completion_state(conn, DEFAULT_STATE_KEY, "0")?;
            completion_cleared = true;
        }

        let write_started = Instant::now();
        let tx = super::write_priority::transaction(conn)?;
        for slice_id in &slice_ids {
            let copied = repack_default_range(&tx, *slice_id)?;
            if copied == 0 {
                refresh_inner(&tx, *slice_id)?;
            }
        }
        tx.commit()?;
        store::record_write_duration(write_started);
        store::checkpoint_index_connection(conn)?;
        cursor = *slice_ids.last().expect("a non-empty rebuild page");
    }
}

/// Parsed half-open local-day bounds reusable across every candidate slice.
/// `None` means the beginning or end of the slice.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RangeBounds {
    from: Option<i32>,
    to: Option<i32>,
}

impl RangeBounds {
    pub fn parse(from: Option<&str>, to: Option<&str>) -> Result<Self> {
        let from = from.map(day_ordinal).transpose()?;
        let to = to.map(day_ordinal).transpose()?;
        if matches!((from, to), (Some(from), Some(to)) if from > to) {
            return Err(anyhow!("invalid_usage_session_range_bounds"));
        }
        Ok(Self { from, to })
    }

    pub fn tokens(&self, days: &[u8], values: &[u8]) -> Result<i64> {
        self.integer(days, values)
    }

    pub fn requests(&self, days: &[u8], values: &[u8]) -> Result<i64> {
        self.integer(days, values)
    }

    pub fn cost(&self, days: &[u8], values: &[u8]) -> Result<f64> {
        let days = IntegerArray::days(days)?;
        if values.len() % VALUE_BYTES != 0 || values.len() / VALUE_BYTES != days.len() {
            return Err(anyhow!("invalid_usage_session_range_blob"));
        }
        let (lower, upper) = self.indexes(&days)?;
        if lower == upper {
            return Ok(0.0);
        }
        let high = cumulative_f64(values, upper)?;
        let low = cumulative_f64(values, lower)?;
        let value = high - low;
        if !value.is_finite() {
            return Err(anyhow!("invalid_usage_session_range_value"));
        }
        Ok(value)
    }

    fn integer(&self, days: &[u8], values: &[u8]) -> Result<i64> {
        let days = IntegerArray::days(days)?;
        let values = IntegerArray::values(values)?;
        if values.len() != days.len() {
            return Err(anyhow!("invalid_usage_session_range_blob"));
        }
        let (lower, upper) = self.indexes(&days)?;
        let high = values.cumulative(upper)?;
        let low = values.cumulative(lower)?;
        high.checked_sub(low)
            .ok_or_else(|| anyhow!("invalid_usage_session_range_value"))
    }

    fn indexes(&self, days: &IntegerArray<'_>) -> Result<(usize, usize)> {
        let lower = match self.from {
            Some(day) => lower_bound(days, day)?,
            None => 0,
        };
        let upper = match self.to {
            Some(day) => lower_bound(days, day)?,
            None => days.len(),
        };
        Ok((lower, upper))
    }
}

/// Returns a half-open range total from a cumulative integer or cost array.
/// This compatibility helper parses bounds per call; hot loops should reuse
/// `RangeBounds` directly.
pub fn range_value(
    days: &[u8],
    values: &[u8],
    from: Option<&str>,
    to: Option<&str>,
    is_cost: bool,
) -> Result<f64> {
    let bounds = RangeBounds::parse(from, to)?;
    if is_cost {
        bounds.cost(days, values)
    } else {
        Ok(bounds.tokens(days, values)? as f64)
    }
}

/// Integer-preserving request total for a half-open local-day range.
pub fn range_requests(
    days: &[u8],
    requests: &[u8],
    from: Option<&str>,
    to: Option<&str>,
) -> Result<i64> {
    RangeBounds::parse(from, to)?.requests(days, requests)
}

/// Integer-preserving token total for sorting values beyond f64's exact range.
pub fn range_tokens(
    days: &[u8],
    tokens: &[u8],
    from: Option<&str>,
    to: Option<&str>,
) -> Result<i64> {
    RangeBounds::parse(from, to)?.tokens(days, tokens)
}

fn missing_slice_page(conn: &Connection, cursor: i64) -> Result<Vec<i64>> {
    let mut statement = conn.prepare(
        "SELECT s.id
         FROM usage_session_slices s
         LEFT JOIN usage_session_sort_ranges r ON r.slice_id = s.id
         WHERE s.id > ?1 AND r.slice_id IS NULL
         ORDER BY s.id
         LIMIT ?2",
    )?;
    let rows = statement.query_map(params![cursor, REBUILD_BATCH_SIZE as i64], |row| {
        row.get::<_, i64>(0)
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn missing_default_slice_page(conn: &Connection, cursor: i64) -> Result<Vec<i64>> {
    let mut statement = conn.prepare(
        "SELECT s.id
         FROM usage_session_slices s
         LEFT JOIN usage_session_default_sort_ranges_packed r ON r.slice_id = s.id
         WHERE s.id > ?1 AND s.model_mask = 0 AND (
            r.slice_id IS NULL
            OR length(r.days) < ?3 OR substr(r.days, 1, 8) <> ?4
            OR length(r.tokens) < ?3 OR substr(r.tokens, 1, 8) <> ?5
            OR length(r.requests) < ?3 OR substr(r.requests, 1, 8) <> ?5
         )
         ORDER BY s.id
         LIMIT ?2",
    )?;
    let rows = statement.query_map(
        params![
            cursor,
            REBUILD_BATCH_SIZE as i64,
            PACKED_HEADER_BYTES as i64,
            DAY_MAGIC.to_le_bytes().as_slice(),
            VALUE_MAGIC.to_le_bytes().as_slice()
        ],
        |row| row.get::<_, i64>(0),
    )?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn repack_default_range(conn: &Connection, slice_id: i64) -> Result<usize> {
    let source = conn
        .query_row(
            "SELECT r.days, r.tokens, r.costs, r.requests
             FROM usage_session_sort_ranges r
             JOIN usage_session_slices s ON s.id = r.slice_id
             WHERE r.slice_id = ?1 AND s.model_mask = 0",
            [slice_id],
            |row| {
                Ok((
                    row.get::<_, Vec<u8>>(0)?,
                    row.get::<_, Vec<u8>>(1)?,
                    row.get::<_, Vec<u8>>(2)?,
                    row.get::<_, Vec<u8>>(3)?,
                ))
            },
        )
        .optional()?;
    let Some((days, tokens, costs, requests)) = source else {
        return Ok(0);
    };

    let days = IntegerArray::days(&days)?;
    let tokens = IntegerArray::values(&tokens)?;
    let requests = IntegerArray::values(&requests)?;
    if tokens.len() != days.len()
        || requests.len() != days.len()
        || costs.len() % VALUE_BYTES != 0
        || costs.len() / VALUE_BYTES != days.len()
    {
        return Err(anyhow!("invalid_usage_session_range_blob"));
    }
    let packed_days = pack_integers(&days.collect()?, DAY_MAGIC)?;
    let packed_tokens = pack_integers(&tokens.collect()?, VALUE_MAGIC)?;
    let packed_requests = pack_integers(&requests.collect()?, VALUE_MAGIC)?;

    Ok(conn.execute(
        "INSERT INTO usage_session_default_sort_ranges_packed(
            slice_id, days, tokens, costs, requests
         ) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(slice_id) DO UPDATE SET
            days = excluded.days,
            tokens = excluded.tokens,
            costs = excluded.costs,
            requests = excluded.requests",
        params![slice_id, packed_days, packed_tokens, costs, packed_requests],
    )?)
}

fn write_completion_state(conn: &Connection, key: &str, value: &str) -> Result<()> {
    let write_started = Instant::now();
    let tx = super::write_priority::transaction(conn)?;
    tx.execute(
        "INSERT INTO usage_ledger_state(key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    tx.commit()?;
    store::record_write_duration(write_started);
    store::checkpoint_index_connection(conn)?;
    Ok(())
}

fn lower_bound(days: &IntegerArray<'_>, target: i32) -> Result<usize> {
    let mut low = 0;
    let mut high = days.len();
    while low < high {
        let middle = low + (high - low) / 2;
        if days.get(middle)? < i64::from(target) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    Ok(low)
}

#[derive(Clone, Copy)]
enum IntegerArray<'a> {
    LegacyDays(&'a [u8]),
    LegacyValues(&'a [u8]),
    Packed {
        payload: &'a [u8],
        len: usize,
        width: usize,
        base: i64,
    },
}

impl<'a> IntegerArray<'a> {
    fn days(bytes: &'a [u8]) -> Result<Self> {
        if bytes.len() >= DAY_BYTES
            && i32::from_le_bytes(bytes[..DAY_BYTES].try_into()?) == i32::MIN
        {
            return Self::packed(bytes, DAY_MAGIC);
        }
        if bytes.len() % DAY_BYTES != 0 {
            return Err(anyhow!("invalid_usage_session_range_blob"));
        }
        Ok(Self::LegacyDays(bytes))
    }

    fn values(bytes: &'a [u8]) -> Result<Self> {
        if bytes.len() >= VALUE_BYTES && i64::from_le_bytes(bytes[..VALUE_BYTES].try_into()?) < 0 {
            return Self::packed(bytes, VALUE_MAGIC);
        }
        if bytes.len() % VALUE_BYTES != 0 {
            return Err(anyhow!("invalid_usage_session_range_blob"));
        }
        Ok(Self::LegacyValues(bytes))
    }

    fn packed(bytes: &'a [u8], expected_magic: i64) -> Result<Self> {
        if bytes.len() < PACKED_HEADER_BYTES
            || i64::from_le_bytes(bytes[..8].try_into()?) != expected_magic
            || bytes[8] != PACKED_VERSION
            || !matches!(bytes[9], 1 | 2 | 4 | 8)
            || bytes[10..12] != [0, 0]
        {
            return Err(anyhow!("invalid_usage_session_range_blob"));
        }
        let width = usize::from(bytes[9]);
        let len = usize::try_from(u32::from_le_bytes(bytes[12..16].try_into()?))?;
        let payload_bytes = len
            .checked_mul(width)
            .ok_or_else(|| anyhow!("invalid_usage_session_range_blob"))?;
        let expected_bytes = PACKED_HEADER_BYTES
            .checked_add(payload_bytes)
            .ok_or_else(|| anyhow!("invalid_usage_session_range_blob"))?;
        if bytes.len() != expected_bytes {
            return Err(anyhow!("invalid_usage_session_range_blob"));
        }
        Ok(Self::Packed {
            payload: &bytes[PACKED_HEADER_BYTES..],
            len,
            width,
            base: i64::from_le_bytes(bytes[16..24].try_into()?),
        })
    }

    fn len(&self) -> usize {
        match self {
            Self::LegacyDays(bytes) => bytes.len() / DAY_BYTES,
            Self::LegacyValues(bytes) => bytes.len() / VALUE_BYTES,
            Self::Packed { len, .. } => *len,
        }
    }

    fn get(&self, index: usize) -> Result<i64> {
        if index >= self.len() {
            return Err(anyhow!("invalid_usage_session_range_blob"));
        }
        match self {
            Self::LegacyDays(bytes) => {
                let offset = index * DAY_BYTES;
                Ok(i64::from(i32::from_le_bytes(
                    bytes[offset..offset + DAY_BYTES].try_into()?,
                )))
            }
            Self::LegacyValues(bytes) => {
                let offset = index * VALUE_BYTES;
                Ok(i64::from_le_bytes(
                    bytes[offset..offset + VALUE_BYTES].try_into()?,
                ))
            }
            Self::Packed {
                payload,
                width,
                base,
                ..
            } => {
                let offset = index * width;
                let delta = match width {
                    1 => u64::from(payload[offset]),
                    2 => u64::from(u16::from_le_bytes(payload[offset..offset + 2].try_into()?)),
                    4 => u64::from(u32::from_le_bytes(payload[offset..offset + 4].try_into()?)),
                    8 => u64::from_le_bytes(payload[offset..offset + 8].try_into()?),
                    _ => unreachable!("packed widths are validated"),
                };
                i64::try_from(i128::from(*base) + i128::from(delta))
                    .map_err(|_| anyhow!("invalid_usage_session_range_value"))
            }
        }
    }

    fn cumulative(&self, count: usize) -> Result<i64> {
        if count == 0 {
            Ok(0)
        } else {
            self.get(count - 1)
        }
    }

    fn collect(&self) -> Result<Vec<i64>> {
        (0..self.len()).map(|index| self.get(index)).collect()
    }
}

fn pack_integers(values: &[i64], magic: i64) -> Result<Vec<u8>> {
    let base = values.iter().copied().min().unwrap_or(0);
    let max_delta = values.iter().try_fold(0_u64, |maximum, value| {
        let delta = u64::try_from(i128::from(*value) - i128::from(base))?;
        Ok::<u64, std::num::TryFromIntError>(maximum.max(delta))
    })?;
    let width = if max_delta <= u64::from(u8::MAX) {
        1
    } else if max_delta <= u64::from(u16::MAX) {
        2
    } else if max_delta <= u64::from(u32::MAX) {
        4
    } else {
        8
    };
    let len = u32::try_from(values.len())?;
    let payload_bytes = values
        .len()
        .checked_mul(width)
        .ok_or_else(|| anyhow!("invalid_usage_session_range_blob"))?;
    let capacity = PACKED_HEADER_BYTES
        .checked_add(payload_bytes)
        .ok_or_else(|| anyhow!("invalid_usage_session_range_blob"))?;
    let mut packed = Vec::with_capacity(capacity);
    packed.extend_from_slice(&magic.to_le_bytes());
    packed.push(PACKED_VERSION);
    packed.push(u8::try_from(width)?);
    packed.extend_from_slice(&[0, 0]);
    packed.extend_from_slice(&len.to_le_bytes());
    packed.extend_from_slice(&base.to_le_bytes());
    for value in values {
        let delta = u64::try_from(i128::from(*value) - i128::from(base))?;
        match width {
            1 => packed.push(u8::try_from(delta)?),
            2 => packed.extend_from_slice(&u16::try_from(delta)?.to_le_bytes()),
            4 => packed.extend_from_slice(&u32::try_from(delta)?.to_le_bytes()),
            8 => packed.extend_from_slice(&delta.to_le_bytes()),
            _ => unreachable!("width is selected above"),
        }
    }
    Ok(packed)
}

fn cumulative_f64(values: &[u8], count: usize) -> Result<f64> {
    if count == 0 {
        return Ok(0.0);
    }
    let offset = (count - 1) * VALUE_BYTES;
    let bytes = values
        .get(offset..offset + VALUE_BYTES)
        .ok_or_else(|| anyhow!("invalid_usage_session_range_blob"))?;
    let value = f64::from_le_bytes(bytes.try_into()?);
    if !value.is_finite() {
        return Err(anyhow!("invalid_usage_session_range_value"));
    }
    Ok(value)
}

fn day_ordinal(day: &str) -> Result<i32> {
    let date = NaiveDate::parse_from_str(day, "%Y-%m-%d")?;
    if !(0..=9999).contains(&date.year()) {
        return Err(anyhow!("usage_session_range_day_out_of_range"));
    }
    Ok(date.num_days_from_ce())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE usage_ledger_state(key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE usage_facts(fact_key TEXT PRIMARY KEY);
             CREATE TABLE usage_session_slices(
                id INTEGER PRIMARY KEY, provider TEXT NOT NULL,
                native_session_id TEXT NOT NULL, mode INTEGER NOT NULL,
                model_mask INTEGER NOT NULL
             );
             CREATE TABLE usage_session_prefix(
                slice_id INTEGER NOT NULL, local_day TEXT NOT NULL,
                tokens INTEGER NOT NULL, cost REAL NOT NULL,
                requests INTEGER NOT NULL,
                PRIMARY KEY(slice_id, local_day)
             ) WITHOUT ROWID;",
        )
        .unwrap();
        initialize(&conn).unwrap();
        conn
    }

    fn populated() -> (Connection, Vec<u8>, Vec<u8>, Vec<u8>, Vec<u8>) {
        let conn = db();
        conn.execute(
            "INSERT INTO usage_session_slices VALUES(1, 'fixture', 'native', 0, 0)",
            [],
        )
        .unwrap();
        for row in [
            ("2026-01-01", 10_i64, 0.25_f64, 1_i64),
            ("2026-01-03", 30, 0.75, 3),
            ("2026-01-05", 35, 1.0, 4),
        ] {
            conn.execute(
                "INSERT INTO usage_session_prefix VALUES(1, ?1, ?2, ?3, ?4)",
                params![row.0, row.1, row.2, row.3],
            )
            .unwrap();
        }
        refresh(&conn, 1).unwrap();
        let blobs = conn
            .query_row(
                "SELECT days, tokens, costs, requests
                 FROM usage_session_sort_ranges WHERE slice_id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        (conn, blobs.0, blobs.1, blobs.2, blobs.3)
    }

    fn add_slice(conn: &Connection, id: i64, native: &str, mode: i64, model_mask: i64) {
        conn.execute(
            "INSERT INTO usage_session_slices VALUES(?1, 'fixture', ?2, ?3, ?4)",
            params![id, native, mode, model_mask],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO usage_session_prefix VALUES(
                ?1, '2026-01-01', ?2, ?3, ?4
             )",
            params![id, id * 10, id as f64 / 10.0, id],
        )
        .unwrap();
        refresh(conn, id).unwrap();
    }

    fn legacy_days(values: &[i32]) -> Vec<u8> {
        values
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect()
    }

    fn legacy_values(values: &[i64]) -> Vec<u8> {
        values
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect()
    }

    fn has_magic(blob: &[u8], magic: i64) -> bool {
        blob.get(..VALUE_BYTES) == Some(magic.to_le_bytes().as_slice())
    }

    #[test]
    fn default_table_contains_all_default_model_modes_only() {
        let conn = db();
        add_slice(&conn, 1, "native", 0, 0);
        add_slice(&conn, 2, "native", 1, 0);
        add_slice(&conn, 3, "native", 0, 1);

        let mut statement = conn
            .prepare("SELECT slice_id FROM usage_session_sort_ranges ORDER BY slice_id")
            .unwrap();
        let legacy = statement
            .query_map([], |row| row.get::<_, i64>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        drop(statement);
        let mut statement = conn
            .prepare(
                "SELECT slice_id FROM usage_session_default_sort_ranges_packed ORDER BY slice_id",
            )
            .unwrap();
        let defaults = statement
            .query_map([], |row| row.get::<_, i64>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(legacy, vec![1, 2, 3]);
        assert_eq!(defaults, vec![1, 2]);
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM usage_session_default_sort_ranges_packed d
                 JOIN usage_session_sort_ranges r USING(slice_id)
                 WHERE d.days<>r.days OR d.tokens<>r.tokens OR d.costs<>r.costs
                    OR d.requests<>r.requests",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            0
        );
    }

    #[test]
    fn removal_clears_both_tables_for_the_exact_session() {
        let conn = db();
        add_slice(&conn, 1, "remove", 0, 0);
        add_slice(&conn, 2, "remove", 0, 1);
        add_slice(&conn, 3, "keep", 1, 0);
        remove_session(&conn, "fixture", "remove").unwrap();

        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM usage_session_sort_ranges r
                 JOIN usage_session_slices s ON s.id=r.slice_id
                 WHERE s.native_session_id='remove'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            0
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM usage_session_default_sort_ranges_packed d
                 JOIN usage_session_slices s ON s.id=d.slice_id
                 WHERE s.native_session_id='remove'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            0
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM usage_session_sort_ranges",
                [],
                |row| { row.get::<_, i64>(0) }
            )
            .unwrap(),
            1
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM usage_session_default_sort_ranges_packed",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            1
        );
    }

    #[test]
    fn rebuild_repacks_both_default_modes_from_legacy_blobs_before_becoming_ready() {
        let conn = db();
        add_slice(&conn, 1, "native", 0, 0);
        add_slice(&conn, 2, "native", 1, 0);
        add_slice(&conn, 3, "native", 0, 1);
        let day = day_ordinal("2026-01-01").unwrap();
        for id in 1_i64..=3 {
            let days = legacy_days(&[day]);
            let tokens = legacy_values(&[id * 10]);
            let requests = legacy_values(&[id]);
            conn.execute(
                "UPDATE usage_session_sort_ranges
                 SET days=?2, tokens=?3, requests=?4 WHERE slice_id=?1",
                params![id, days, tokens, requests],
            )
            .unwrap();
            if id <= 2 {
                conn.execute(
                    "UPDATE usage_session_default_sort_ranges_packed
                     SET days=?2, tokens=?3, requests=?4 WHERE slice_id=?1",
                    params![id, days, tokens, requests],
                )
                .unwrap();
            }
        }
        let mut statement = conn
            .prepare(
                "SELECT slice_id, costs
                 FROM usage_session_default_sort_ranges_packed ORDER BY slice_id",
            )
            .unwrap();
        let original_costs = statement
            .query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        drop(statement);
        conn.execute(
            "DELETE FROM usage_session_default_sort_ranges_packed WHERE slice_id=2",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO usage_ledger_state(key, value)
             VALUES('session-default-sort-ranges-complete-v2', '1')",
            [],
        )
        .unwrap();
        conn.execute(
            "DELETE FROM usage_ledger_state WHERE key=?1",
            [DEFAULT_STATE_KEY],
        )
        .unwrap();
        assert!(default_table_available(&conn));
        assert!(!ready(&conn));
        assert!(rebuild(&conn, &AtomicBool::new(false)).unwrap());
        assert!(ready(&conn));

        let mut statement = conn
            .prepare(
                "SELECT slice_id, days, tokens, costs, requests
                 FROM usage_session_default_sort_ranges_packed ORDER BY slice_id",
            )
            .unwrap();
        let rebuilt = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Vec<u8>>(1)?,
                    row.get::<_, Vec<u8>>(2)?,
                    row.get::<_, Vec<u8>>(3)?,
                    row.get::<_, Vec<u8>>(4)?,
                ))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        drop(statement);
        assert_eq!(rebuilt.len(), 2);
        for (index, (id, days, tokens, costs, requests)) in rebuilt.iter().enumerate() {
            assert_eq!(*id, i64::try_from(index + 1).unwrap());
            assert!(has_magic(days, DAY_MAGIC));
            assert!(has_magic(tokens, VALUE_MAGIC));
            assert!(has_magic(requests, VALUE_MAGIC));
            assert_eq!(costs, &original_costs[index].1);
            assert_eq!(range_tokens(days, tokens, None, None).unwrap(), *id * 10);
            assert_eq!(range_requests(days, requests, None, None).unwrap(), *id);
        }
        assert_eq!(
            conn.query_row(
                "SELECT length(days) FROM usage_session_sort_ranges WHERE slice_id=1",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
            DAY_BYTES as i64
        );
    }

    #[test]
    fn half_open_boundaries_use_the_previous_cumulative_value() {
        let (_conn, days, tokens, _costs, requests) = populated();
        assert_eq!(
            range_value(
                &days,
                &tokens,
                Some("2026-01-03"),
                Some("2026-01-05"),
                false
            )
            .unwrap(),
            20.0
        );
        assert_eq!(
            range_requests(&days, &requests, Some("2026-01-02"), Some("2026-01-06")).unwrap(),
            3
        );
        assert_eq!(
            range_value(
                &days,
                &tokens,
                Some("2026-01-03"),
                Some("2026-01-03"),
                false
            )
            .unwrap(),
            0.0
        );
    }

    #[test]
    fn legacy_fixed_width_blobs_keep_half_open_range_semantics() {
        let days = legacy_days(&[
            day_ordinal("2026-01-01").unwrap(),
            day_ordinal("2026-01-03").unwrap(),
            day_ordinal("2026-01-05").unwrap(),
        ]);
        let tokens = legacy_values(&[10, 30, 35]);
        let requests = legacy_values(&[1, 3, 4]);
        assert_eq!(
            range_tokens(&days, &tokens, Some("2026-01-03"), Some("2026-01-05")).unwrap(),
            20
        );
        assert_eq!(
            range_requests(&days, &requests, Some("2026-01-02"), None).unwrap(),
            3
        );
    }

    #[test]
    fn costs_and_unbounded_ranges_are_exact() {
        let (_conn, days, tokens, costs, requests) = populated();
        assert_eq!(
            range_value(&days, &tokens, None, None, false).unwrap(),
            35.0
        );
        assert_eq!(
            range_value(&days, &costs, Some("2026-01-02"), Some("2026-01-05"), true).unwrap(),
            0.5
        );
        assert_eq!(
            range_value(&days, &tokens, None, Some("2026-01-03"), false).unwrap(),
            10.0
        );
        assert_eq!(
            range_requests(&days, &requests, Some("2026-01-05"), None).unwrap(),
            1
        );

        let bounds = RangeBounds::parse(Some("2026-01-02"), Some("2026-01-05")).unwrap();
        assert_eq!(bounds.tokens(&days, &tokens).unwrap(), 20);
        assert_eq!(bounds.requests(&days, &requests).unwrap(), 2);
        assert_eq!(bounds.cost(&days, &costs).unwrap(), 0.5);
    }

    #[test]
    fn empty_slices_encode_and_query_as_zero() {
        let conn = db();
        conn.execute(
            "INSERT INTO usage_session_slices VALUES(1, 'fixture', 'empty', 0, 0)",
            [],
        )
        .unwrap();
        refresh(&conn, 1).unwrap();
        let blobs: (Vec<u8>, Vec<u8>) = conn
            .query_row(
                "SELECT days, tokens FROM usage_session_sort_ranges WHERE slice_id=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert!(has_magic(&blobs.0, DAY_MAGIC));
        assert!(has_magic(&blobs.1, VALUE_MAGIC));
        assert_eq!(
            range_value(&blobs.0, &blobs.1, None, None, false).unwrap(),
            0.0
        );
        assert_eq!(range_requests(&[], &[], None, None).unwrap(), 0);
    }

    #[test]
    fn malformed_blobs_and_bounds_are_rejected() {
        assert!(range_value(&[0], &[], None, None, false).is_err());
        assert!(range_requests(&0_i32.to_le_bytes(), &[], None, None).is_err());
        assert!(range_value(&[], &[], Some("not-a-day"), None, false).is_err());
        assert!(range_value(&[], &[], Some("2026-01-02"), Some("2026-01-01"), false).is_err());
    }

    #[test]
    fn token_ranges_preserve_integers_beyond_f64_precision() {
        let days = day_ordinal("2026-01-01").unwrap().to_le_bytes();
        let total = 9_007_199_254_740_993_i64;
        assert_eq!(
            range_tokens(&days, &total.to_le_bytes(), None, None).unwrap(),
            total
        );
    }

    #[test]
    fn packed_ranges_preserve_large_integers_and_eight_byte_offsets() {
        let first_day = day_ordinal("2026-01-01").unwrap();
        let days =
            pack_integers(&[i64::from(first_day), i64::from(first_day + 1)], DAY_MAGIC).unwrap();
        let first = 9_007_199_254_740_993_i64;
        let last = first + i64::from(u32::MAX) + 1;
        let tokens = pack_integers(&[first, last], VALUE_MAGIC).unwrap();
        assert_eq!(tokens[9], 8);
        assert_eq!(range_tokens(&days, &tokens, None, None).unwrap(), last);
        assert_eq!(
            range_tokens(&days, &tokens, Some("2026-01-02"), None).unwrap(),
            last - first
        );
    }

    #[test]
    fn packed_codec_uses_the_smallest_offset_width_including_huge_day_spans() {
        assert_eq!(
            i32::from_le_bytes(DAY_MAGIC.to_le_bytes()[..DAY_BYTES].try_into().unwrap()),
            i32::MIN
        );
        assert!(VALUE_MAGIC < 0);
        for (values, width) in [
            (vec![0, i64::from(u8::MAX)], 1_u8),
            (vec![0, i64::from(u8::MAX) + 1], 2),
            (vec![0, i64::from(u16::MAX) + 1], 4),
            (vec![0, i64::from(u32::MAX) + 1], 8),
        ] {
            let packed = pack_integers(&values, VALUE_MAGIC).unwrap();
            assert_eq!(packed[9], width);
            assert_eq!(
                IntegerArray::values(&packed).unwrap().collect().unwrap(),
                values
            );
        }

        let extremes = vec![i64::MIN, i64::MAX];
        let packed = pack_integers(&extremes, VALUE_MAGIC).unwrap();
        assert_eq!(packed[9], 8);
        assert_eq!(
            IntegerArray::values(&packed).unwrap().collect().unwrap(),
            extremes
        );

        let days = vec![i64::from(i32::MIN) + 1, i64::from(i32::MAX)];
        let packed = pack_integers(&days, DAY_MAGIC).unwrap();
        assert_eq!(packed[9], 4);
        assert_eq!(
            IntegerArray::days(&packed).unwrap().collect().unwrap(),
            days
        );
    }

    #[test]
    fn corrupt_packed_headers_lengths_and_overflows_are_rejected() {
        let day = i64::from(day_ordinal("2026-01-01").unwrap());
        let days = pack_integers(&[day], DAY_MAGIC).unwrap();
        let values = pack_integers(&[1], VALUE_MAGIC).unwrap();

        let mut bad_version = values.clone();
        bad_version[8] = PACKED_VERSION + 1;
        assert!(range_tokens(&days, &bad_version, None, None).is_err());

        let mut bad_width = values.clone();
        bad_width[9] = 3;
        assert!(range_tokens(&days, &bad_width, None, None).is_err());

        let mut bad_length = values.clone();
        bad_length[12..16].copy_from_slice(&2_u32.to_le_bytes());
        assert!(range_tokens(&days, &bad_length, None, None).is_err());

        let mut bad_magic = days.clone();
        bad_magic[7] ^= 1;
        assert!(range_tokens(&bad_magic, &values, None, None).is_err());

        let mut overflow = pack_integers(&[i64::MAX], VALUE_MAGIC).unwrap();
        *overflow.last_mut().unwrap() = 1;
        assert!(range_tokens(&days, &overflow, None, None).is_err());
    }
}
