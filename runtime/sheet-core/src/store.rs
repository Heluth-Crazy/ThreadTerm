//! The compact cell store (spike A, `validation.md` S1).
//!
//! Structure of arrays, one entry per non-empty cell: 11 bytes per cell plus 8 bytes
//! per row before text, against `worksheet_range`'s ~80 bytes per cell that made a
//! 100 MiB numeric workbook peak at 1.2 GiB. Strings are interned once per cell
//! (calamine already deduplicates shared strings) and clipped at
//! [`SHEET_CELL_TEXT_LIMIT`] characters.

use crate::fmt::{format_serial, NumFmt};
use crate::SHEET_CELL_TEXT_LIMIT;
use serde_json::{json, Value};

pub(crate) const K_NUM: u8 = 0;
pub(crate) const K_STR: u8 = 1;
pub(crate) const K_DATE: u8 = 2;
pub(crate) const K_TIME: u8 = 3;
pub(crate) const K_BOOL: u8 = 4;
pub(crate) const K_ERR: u8 = 5;
pub(crate) const K_DTEXT: u8 = 6;
/// A string that lost characters to the text limit.
pub(crate) const K_STR_CLIPPED: u8 = 7;

/// One merged region, as the window reply reports it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Merge {
    pub row: u32,
    pub column: u32,
    pub rows: u32,
    pub columns: u32,
}

pub(crate) struct Store {
    /// Cell index where row `r` starts; `len == rows + 1`.
    pub(crate) row_start: Vec<u32>,
    pub(crate) col: Vec<u16>,
    pub(crate) kind: Vec<u8>,
    /// f64 bits, boolean, or `(offset << 32) | len` into `text`.
    pub(crate) value: Vec<u64>,
    /// Index into `formats`.
    pub(crate) fmt: Vec<u8>,
    pub(crate) text: Vec<u8>,
    pub(crate) formats: Vec<NumFmt>,
    pub(crate) max_col: u32,
    pub(crate) merges: Vec<Merge>,
}

impl Store {
    pub(crate) fn new(capacity_hint: usize) -> Store {
        Store {
            // `begin_row` appends one entry per row, so `row_start[r]` is where row `r`
            // begins and `row_start[r + 1]` where it ends.
            row_start: Vec::with_capacity(2),
            col: Vec::with_capacity(capacity_hint),
            kind: Vec::with_capacity(capacity_hint),
            value: Vec::with_capacity(capacity_hint),
            fmt: Vec::with_capacity(capacity_hint),
            text: Vec::new(),
            formats: vec![NumFmt::General],
            max_col: 0,
            merges: Vec::new(),
        }
    }

    /// Rows 0..rows are addressable; `totalRows` of the window reply.
    pub(crate) fn rows(&self) -> u32 {
        self.row_start.len().saturating_sub(1) as u32
    }

    pub(crate) fn total_columns(&self) -> u32 {
        self.max_col + 1
    }

    pub(crate) fn text_of(&self, packed: u64) -> &str {
        let offset = (packed >> 32) as usize;
        let length = (packed & 0xffff_ffff) as usize;
        self.text
            .get(offset..offset + length)
            .and_then(|bytes| std::str::from_utf8(bytes).ok())
            .unwrap_or("")
    }

    /// Intern one string, clipped to [`SHEET_CELL_TEXT_LIMIT`] characters. Returns the
    /// packed reference and whether characters were dropped.
    pub(crate) fn intern(&mut self, text: &str) -> (u64, bool) {
        let mut end = text.len();
        let mut clipped = false;
        if text.chars().count() > SHEET_CELL_TEXT_LIMIT {
            end = text
                .char_indices()
                .nth(SHEET_CELL_TEXT_LIMIT)
                .map(|(index, _)| index)
                .unwrap_or(text.len());
            clipped = true;
        }
        let offset = self.text.len();
        self.text.extend_from_slice(&text.as_bytes()[..end]);
        (((offset as u64) << 32) | end as u64, clipped)
    }

    fn format_index(&mut self, format: NumFmt) -> u8 {
        if let Some(index) = self.formats.iter().position(|value| *value == format) {
            return index as u8;
        }
        if self.formats.len() >= u8::MAX as usize {
            return 0;
        }
        self.formats.push(format);
        (self.formats.len() - 1) as u8
    }

    pub(crate) fn push(&mut self, col: u32, kind: u8, value: u64, format: NumFmt) {
        let index = self.format_index(format);
        self.col.push(col as u16);
        self.kind.push(kind);
        self.value.push(value);
        self.fmt.push(index);
        if col > self.max_col {
            self.max_col = col;
        }
    }

    pub(crate) fn push_interned(&mut self, col: u32, text: &str, format: NumFmt) {
        let (packed, clipped) = self.intern(text);
        self.push(
            col,
            if clipped { K_STR_CLIPPED } else { K_STR },
            packed,
            format,
        );
    }

    pub(crate) fn push_error(&mut self, col: u32, text: &str) {
        let (packed, _) = self.intern(text);
        self.push(col, K_ERR, packed, NumFmt::General);
    }

    pub(crate) fn push_date_text(&mut self, col: u32, text: &str) {
        let (packed, _) = self.intern(text);
        self.push(col, K_DTEXT, packed, NumFmt::General);
    }

    /// Grow the row index so that `row_start[row]` exists: where the row begins.
    pub(crate) fn begin_row(&mut self, row: u32) {
        while (self.row_start.len() as u32) <= row {
            self.row_start.push(self.value.len() as u32);
        }
    }

    /// Close the index: `row_start[rows]` is the end of the last row.
    pub(crate) fn finish_rows(&mut self) {
        self.row_start.push(self.value.len() as u32);
    }

    /// One row of the window, trailing empty cells trimmed. Cells are text only (R13);
    /// nothing here follows a formula, a link or a data connection.
    pub(crate) fn row_json(
        &self,
        row: u32,
        column_start: u32,
        column_count: u32,
        date1904: bool,
        clipped: &mut bool,
    ) -> Value {
        let (row, column_start, column_count) = (row as usize, column_start, column_count);
        if row + 1 >= self.row_start.len() {
            return Value::Array(Vec::new());
        }
        let from = self.row_start[row] as usize;
        let to = self.row_start[row + 1] as usize;
        let columns = column_count as usize;
        let mut cells: Vec<Value> = vec![Value::Null; columns];
        let mut any = false;
        for i in from..to {
            let column = self.col[i] as u32;
            if column < column_start || column >= column_start + column_count {
                continue;
            }
            any = true;
            let index = (column - column_start) as usize;
            let value = self.value[i];
            cells[index] = match self.kind[i] {
                K_NUM => {
                    let number = f64::from_bits(value);
                    let format = self.formats[self.fmt[i] as usize];
                    json!([format.text(number), "n"])
                }
                K_BOOL => json!([if value != 0 { "TRUE" } else { "FALSE" }, "b"]),
                K_DATE | K_TIME => json!([format_serial(f64::from_bits(value), date1904), "d"]),
                K_ERR => json!([self.text_of(value), "e"]),
                K_DTEXT => json!([self.text_of(value), "d"]),
                K_STR_CLIPPED => {
                    *clipped = true;
                    json!(self.text_of(value))
                }
                // R13: text is a bare string, not a tagged pair.
                _ => json!(self.text_of(value)),
            };
        }
        if !any {
            return Value::Array(Vec::new());
        }
        while matches!(cells.last(), Some(Value::Null)) {
            cells.pop();
        }
        Value::Array(cells)
    }

    /// Merges whose region touches rows `start..end`.
    pub(crate) fn merges_touching(&self, start: u32, end: u32) -> Vec<Value> {
        self.merges
            .iter()
            .filter(|merge| merge.row < end && merge.row + merge.rows > start)
            .map(|merge| json!([merge.row, merge.column, merge.rows, merge.columns]))
            .collect()
    }
}

/// Number of non-empty cells, for the cell cap and the merge-cost gate.
pub(crate) fn declared_cells(start: (u32, u32), end: (u32, u32)) -> u64 {
    let rows = end.0.saturating_sub(start.0) as u64 + 1;
    let columns = end.1.saturating_sub(start.1) as u64 + 1;
    rows.saturating_mul(columns)
}
