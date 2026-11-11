//! ThreadTerm V3's sheet core: one parser for every Excel host.
//!
//! Bytes (or any `Read + Seek`) in, JSON out. No threads, no clocks, no file system,
//! no environment, no `std::time` (it panics on `wasm32-unknown-unknown`). The host
//! reads the file, times the calls and measures its own memory; this crate only turns
//! a workbook into windows of cell text (`design.md` §3.1, §3.2).
//!
//! The same crate is the runtime helper's parser and the WebAssembly module the main
//! process runs (step 3). Requests and replies are the JSON of `design.md` §3.1 with
//! the handle and change-token fields left to the host, so the two cannot drift.

mod fmt;
mod store;

pub use fmt::{error_text, format_number, format_serial, NumFmt};
pub use store::Merge;

use calamine::{Data, DataRef, Ods, Range, Reader, Xls, Xlsb, Xlsx};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};

/// R3 / `design.md` §2: the preview limit, one definition per language.
pub const OFFICE_PREVIEW_MAX_BYTES: u64 = 100 * 1024 * 1024;
/// Characters of one cell's text in a window; the rest is reported as `clipped`.
pub const SHEET_CELL_TEXT_LIMIT: usize = 2000;
/// Rows a client may ask for in one request.
pub const SHEET_MAX_ROWS_REQUEST: u32 = 500;
/// Columns a client may ask for in one request.
pub const SHEET_MAX_COLS_REQUEST: u32 = 200;
/// One window reply stays inside this, whatever the cells hold. The client asks again
/// from the last row it received.
pub const SHEET_MAX_RESPONSE_BYTES: usize = 1024 * 1024;
/// Zip-bomb caps (`validation.md` S3): the largest fixture is 14.5M cells and 787.7 MB
/// decompressed, so both caps sit well above a real workbook.
pub const SHEET_MAX_CELLS: u64 = 60_000_000;
pub const SHEET_MAX_DECOMPRESSED_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Interned text this store keeps, on top of calamine's own shared-string table.
pub const SHEET_MAX_INTERNED_TEXT_BYTES: u64 = 512 * 1024 * 1024;
/// A streaming load reports progress this often, in cells; a sheet declaring fewer
/// cells than this loads too fast for a number to matter and reports none.
pub const SHEET_PROGRESS_EVERY_CELLS: u64 = 1 << 16;
/// A sheet at or below this declared size also loads its merged regions.
///
/// `merge_cells_by_sheet_name` re-walks the worksheet XML up to `<mergeCells>`, which is
/// a second full parse. Measured 2026-11-11 with the shipped profile (`merge_loading_cost`,
/// `TT_SHEET_FIXTURES` set): **+67.6 %** on numbers-100 (5.48 s → 9.19 s), **+45.5 %** on
/// strings-100 (5.40 s → 7.85 s), **+64.3 %** on sheets-10x10 (0.55 s → 0.90 s) and +3.4 %
/// on the small features.xlsx. `design.md` §3.1 allows the merge pass only under 10 % extra,
/// so it is off by default and `SheetRows.merges` stays absent; R16's merged-cell spans wait
/// for a cheaper source than a second parse.
pub const SHEET_MERGE_PARSE_MAX_CELLS: u64 = 0;

/// The `design.md` §6 error codes this crate can produce.
pub const CODE_UNSUPPORTED: &str = "unsupported_document";
pub const CODE_PROTECTED: &str = "document_protected";
pub const CODE_TOO_COMPLEX: &str = "sheet_too_complex";
pub const CODE_NOT_FOUND: &str = "sheet_not_found";
pub const CODE_INVALID: &str = "invalid_request";

pub type SheetResult<T> = Result<T, SheetError>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SheetError {
    pub code: &'static str,
    /// Host-facing detail; never shown to the user.
    pub detail: String,
}

impl SheetError {
    pub fn new(code: &'static str, detail: impl Into<String>) -> SheetError {
        SheetError {
            code,
            detail: detail.into(),
        }
    }
}

fn unsupported(detail: impl Into<String>) -> SheetError {
    SheetError::new(CODE_UNSUPPORTED, detail)
}

fn too_complex(detail: impl Into<String>) -> SheetError {
    SheetError::new(CODE_TOO_COMPLEX, detail)
}

fn invalid(detail: impl Into<String>) -> SheetError {
    SheetError::new(CODE_INVALID, detail)
}

/// `Read + Seek` as a trait object, so one `Engine` holds any source: a file the
/// runtime helper opened, the bytes the WebAssembly host fed in, or a test fixture.
pub trait ReadSeek: Read + Seek + Send {}
impl<T: Read + Seek + Send> ReadSeek for T {}
pub type Source = Box<dyn ReadSeek>;

/// The formats R2 allows (D6). Chosen by extension, then confirmed by signature.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SheetFormat {
    Xlsx,
    Xlsb,
    Xls,
    Ods,
}

impl SheetFormat {
    /// Extension only: case-insensitive, five allowed names, nothing else.
    pub fn from_extension(extension: &str) -> Option<SheetFormat> {
        match extension.trim_start_matches('.').to_ascii_lowercase().as_str() {
            "xlsx" | "xlsm" => Some(SheetFormat::Xlsx),
            "xlsb" => Some(SheetFormat::Xlsb),
            "xls" => Some(SheetFormat::Xls),
            "ods" => Some(SheetFormat::Ods),
            _ => None,
        }
    }

    pub fn from_path(path: &str) -> Option<SheetFormat> {
        let name = path
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(path);
        let (stem, extension) = name.rsplit_once('.')?;
        if stem.is_empty() {
            return None;
        }
        SheetFormat::from_extension(extension)
    }

    /// `design.md` §2: these carry a zip container; an OLE2 file under one of these
    /// names is an encrypted workbook.
    pub fn is_zip(self) -> bool {
        !matches!(self, SheetFormat::Xls)
    }

    fn name(self) -> &'static str {
        match self {
            SheetFormat::Xlsx => "xlsx",
            SheetFormat::Xlsb => "xlsb",
            SheetFormat::Xls => "xls",
            SheetFormat::Ods => "ods",
        }
    }
}

/// Zip archives start with a local file header; OLE2 (a legacy `.xls`, or an encrypted
/// OOXML file) starts with its own 8-byte signature.
const ZIP_SIGNATURE: [u8; 4] = [0x50, 0x4B, 0x03, 0x04];
const OLE2_SIGNATURE: [u8; 8] = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];

/// Caps, kept in one struct so tests can lower them.
#[derive(Clone, Copy, Debug)]
pub struct Caps {
    pub max_cells: u64,
    pub max_decompressed_bytes: u64,
    pub max_interned_text_bytes: u64,
    /// Declared cells at or below which merged regions are loaded.
    pub merge_parse_max_cells: u64,
}

impl Default for Caps {
    fn default() -> Caps {
        Caps {
            max_cells: SHEET_MAX_CELLS,
            max_decompressed_bytes: SHEET_MAX_DECOMPRESSED_BYTES,
            max_interned_text_bytes: SHEET_MAX_INTERNED_TEXT_BYTES,
            merge_parse_max_cells: SHEET_MERGE_PARSE_MAX_CELLS,
        }
    }
}

/// One sheet in `SheetWorkbook.sheets`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SheetInfo {
    pub name: String,
    pub visible: bool,
}

#[derive(Clone, Debug)]
pub struct WorkbookInfo {
    pub sheets: Vec<SheetInfo>,
    pub date1904: bool,
}

impl WorkbookInfo {
    fn to_json(&self) -> Value {
        json!({
            "state": "ready",
            "date1904": self.date1904,
            "sheets": self
                .sheets
                .iter()
                .map(|sheet| json!({"name": sheet.name, "visible": sheet.visible}))
                .collect::<Vec<_>>(),
        })
    }
}

/// One `filesystem.sheet.rows` request (`design.md` §3.1), absolute 0-based coordinates.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RowsRequest {
    pub sheet: u32,
    pub start: u32,
    pub count: u32,
    pub column_start: u32,
    pub column_count: u32,
}

impl RowsRequest {
    pub fn from_json(value: &Value) -> SheetResult<RowsRequest> {
        let number = |key: &str, default: Option<u64>| -> SheetResult<u64> {
            match value.get(key) {
                None => default.ok_or_else(|| invalid(format!("missing {key}"))),
                Some(v) => v
                    .as_u64()
                    .ok_or_else(|| invalid(format!("{key} is not a count"))),
            }
        };
        let request = RowsRequest {
            sheet: number("sheet", None)? as u32,
            start: number("start", None)? as u32,
            count: number("count", Some(50))?.min(SHEET_MAX_ROWS_REQUEST as u64) as u32,
            column_start: number("columnStart", Some(0))? as u32,
            column_count: number("columnCount", Some(SHEET_MAX_COLS_REQUEST as u64))?
                .min(SHEET_MAX_COLS_REQUEST as u64) as u32,
        };
        if request.count == 0 || request.column_count == 0 {
            return Err(invalid("empty window"));
        }
        Ok(request)
    }
}

enum Book {
    Xlsx(Xlsx<Source>),
    Xlsb(Xlsb<Source>),
    Xls(Xls<Source>),
    Ods(Ods<Source>),
}

struct RangeSheet {
    range: Range<Data>,
    total_rows: u32,
    total_columns: u32,
    merges: Vec<Merge>,
}

enum Loaded {
    Store(store::Store),
    Range(RangeSheet),
}

/// The parser and store for one open workbook. One instance per host handle.
pub struct Engine {
    caps: Caps,
    book: Option<Book>,
    sheets: Vec<SheetInfo>,
    date1904: bool,
    loaded: HashMap<u32, Loaded>,
    /// Bytes fed for a later `open` (the WebAssembly host's shape).
    fed: Vec<u8>,
}

impl Default for Engine {
    fn default() -> Self {
        Engine::new(Caps::default())
    }
}

impl Engine {
    pub fn new(caps: Caps) -> Engine {
        Engine {
            caps,
            book: None,
            sheets: Vec::new(),
            date1904: false,
            loaded: HashMap::new(),
            fed: Vec::new(),
        }
    }

    pub fn caps(&self) -> Caps {
        self.caps
    }

    pub fn sheets(&self) -> &[SheetInfo] {
        &self.sheets
    }

    pub fn date1904(&self) -> bool {
        self.date1904
    }

    /// True once a sheet's cells are in the store.
    pub fn is_loaded(&self, sheet: u32) -> bool {
        self.loaded.contains_key(&sheet)
    }

    pub fn open_bytes(&mut self, bytes: Vec<u8>, format: SheetFormat) -> SheetResult<WorkbookInfo> {
        self.open_source(Box::new(std::io::Cursor::new(bytes)), format)
    }

    /// Signature check, zip caps, then the workbook's sheet list. No sheet cells are
    /// read here: `open` must answer while a 100 MiB workbook is still unparsed.
    pub fn open_source(
        &mut self,
        mut source: Source,
        format: SheetFormat,
    ) -> SheetResult<WorkbookInfo> {
        let mut head = [0u8; 8];
        let head_len = read_head(&mut source, &mut head)?;
        let signature = &head[..head_len];
        let zip = signature.starts_with(&ZIP_SIGNATURE);
        let ole2 = signature.starts_with(&OLE2_SIGNATURE);
        if format.is_zip() && ole2 {
            // `design.md` §2: a zip-family name over an OLE2 container is an encrypted
            // (password-protected) Office file, decided from the signature alone.
            return Err(SheetError::new(
                CODE_PROTECTED,
                format!("{} container named {}", "OLE2", format.name()),
            ));
        }
        if format.is_zip() && !zip {
            return Err(unsupported(format!(
                "{} without a zip signature",
                format.name()
            )));
        }
        if !format.is_zip() && !ole2 {
            return Err(unsupported(format!(
                "{} without an OLE2 signature",
                format.name()
            )));
        }
        if format.is_zip() {
            let declared = declared_decompressed_bytes(&mut source)?;
            if declared > self.caps.max_decompressed_bytes {
                return Err(too_complex(format!(
                    "zip declares {declared} bytes decompressed"
                )));
            }
        }
        source.seek(SeekFrom::Start(0)).map_err(io_error)?;
        let book = match format {
            SheetFormat::Xlsx => Book::Xlsx(open_with(Xlsx::new(source))?),
            SheetFormat::Xlsb => Book::Xlsb(open_with(Xlsb::new(source))?),
            SheetFormat::Xls => Book::Xls(open_with(Xls::new(source))?),
            SheetFormat::Ods => Book::Ods(open_with(Ods::new(source))?),
        };
        let (sheets, date1904) = match &book {
            Book::Xlsx(workbook) => (sheet_list(workbook.sheets_metadata()), workbook.has_1904_epoch()),
            Book::Xlsb(workbook) => (sheet_list(workbook.sheets_metadata()), workbook.has_1904_epoch()),
            Book::Xls(workbook) => (sheet_list(workbook.sheets_metadata()), workbook.has_1904_epoch()),
            // ODS has no 1904 epoch in calamine's API and none in the format.
            Book::Ods(workbook) => (sheet_list(workbook.sheets_metadata()), false),
        };
        self.book = Some(book);
        self.sheets = sheets;
        self.date1904 = date1904;
        self.loaded.clear();
        Ok(WorkbookInfo {
            sheets: self.sheets.clone(),
            date1904,
        })
    }

    /// Load one sheet's cells. The host runs this on a background thread: it is the
    /// multi-second step, and `rows` must never wait for it.
    pub fn load(&mut self, sheet: u32) -> SheetResult<()> {
        self.load_with_progress(sheet, &mut |_| {})
    }

    /// [`Engine::load`] that reports the loaded share (0..1) of the sheet's declared
    /// size every [`SHEET_PROGRESS_EVERY_CELLS`] cells (`design.md` §3.2: progress
    /// through a callback). `.xls`/`.ods` and sheets without a usable declared size
    /// report nothing; their hosts answer `loading` without a number.
    pub fn load_with_progress(
        &mut self,
        sheet: u32,
        progress: &mut dyn FnMut(f64),
    ) -> SheetResult<()> {
        if self.loaded.contains_key(&sheet) {
            return Ok(());
        }
        let name = self
            .sheets
            .get(sheet as usize)
            .map(|info| info.name.clone())
            .ok_or_else(|| SheetError::new(CODE_NOT_FOUND, format!("sheet {sheet}")))?;
        let caps = self.caps;
        let date1904 = self.date1904;
        let loaded = match self.book.as_mut() {
            Some(Book::Xlsx(workbook)) => load_xlsx(workbook, &name, caps, date1904, progress)?,
            Some(Book::Xlsb(workbook)) => load_xlsb(workbook, &name, caps, date1904, progress)?,
            Some(Book::Xls(workbook)) => load_xls(workbook, &name, caps)?,
            Some(Book::Ods(workbook)) => load_ods(workbook, &name, caps)?,
            None => return Err(SheetError::new(CODE_NOT_FOUND, "no workbook")),
        };
        self.loaded.insert(sheet, loaded);
        Ok(())
    }

    /// One window. Answers `state: "loading"` while the sheet is not loaded: this
    /// never waits for `load`.
    pub fn rows(&self, request: &RowsRequest) -> SheetResult<Value> {
        if self.sheets.get(request.sheet as usize).is_none() {
            return Err(SheetError::new(
                CODE_NOT_FOUND,
                format!("sheet {}", request.sheet),
            ));
        }
        let Some(loaded) = self.loaded.get(&request.sheet) else {
            return Ok(json!({
                "state": "loading",
                "progress": 0,
                "totalRows": 0,
                "totalColumns": 0,
                "start": request.start,
                "columnStart": request.column_start,
                "rows": [],
            }));
        };
        let mut clipped = false;
        let mut merges: Vec<Value> = Vec::new();
        let (total_rows, total_columns, rows) = match loaded {
            Loaded::Store(store) => {
                let total_rows = store.rows();
                let end = request.start.saturating_add(request.count).min(total_rows);
                let rows = window(request, end, |row| {
                    store.row_json(
                        row,
                        request.column_start,
                        request.column_count,
                        self.date1904,
                        &mut clipped,
                    )
                });
                if end > request.start {
                    merges = store.merges_touching(request.start, end);
                }
                (total_rows, store.total_columns(), rows)
            }
            Loaded::Range(sheet) => {
                let end = request.start.saturating_add(request.count).min(sheet.total_rows);
                let rows = window(request, end, |row| {
                    range_row_json(&sheet.range, row, request, self.date1904, &mut clipped)
                });
                if end > request.start {
                    merges = range_merges_touching(sheet, request.start, end);
                }
                (sheet.total_rows, sheet.total_columns, rows)
            }
        };
        let mut reply = json!({
            "state": "ready",
            "totalRows": total_rows,
            "totalColumns": total_columns,
            "start": request.start,
            "columnStart": request.column_start,
            "rows": rows,
            "clipped": clipped,
            "truncated": false,
        });
        if !merges.is_empty() {
            reply["merges"] = Value::Array(merges);
        }
        trim_to_response_cap(&mut reply);
        Ok(reply)
    }

    /// One JSON request in, one JSON reply out; the same text on both hosts.
    ///
    /// Methods: `open` (`format`), `load` (`sheet`), `rows` (a [`RowsRequest`]),
    /// `info`, `close`. `open` reads the bytes already fed to this engine; a host that
    /// opens a file itself calls [`Engine::open_source`] directly.
    pub fn request(&mut self, request: &str) -> String {
        let request: Value = match serde_json::from_str(request) {
            Ok(value) => value,
            Err(error) => return error_reply(&invalid(format!("bad json: {error}"))),
        };
        let method = request.get("method").and_then(Value::as_str).unwrap_or("");
        let result: SheetResult<Value> = match method {
            "open" => {
                let format = request
                    .get("format")
                    .and_then(Value::as_str)
                    .and_then(|name| match name {
                        "xlsx" => Some(SheetFormat::Xlsx),
                        "xlsb" => Some(SheetFormat::Xlsb),
                        "xls" => Some(SheetFormat::Xls),
                        "ods" => Some(SheetFormat::Ods),
                        _ => None,
                    });
                match format {
                    Some(format) => {
                        let bytes = self.take_fed_bytes();
                        self.open_bytes(bytes, format).map(|info| info.to_json())
                    }
                    None => Err(invalid("open needs a format")),
                }
            }
            "load" => {
                let sheet = request.get("sheet").and_then(Value::as_u64).unwrap_or(0);
                self.load(sheet as u32).map(|_| json!({"state": "ready"}))
            }
            "rows" => RowsRequest::from_json(&request).and_then(|request| self.rows(&request)),
            "info" => Ok(json!({
                "sheets": self.sheets.iter().map(|sheet| json!({"name": sheet.name, "visible": sheet.visible})).collect::<Vec<_>>(),
                "date1904": self.date1904,
            })),
            "close" => {
                self.loaded.clear();
                self.book = None;
                self.sheets.clear();
                Ok(Value::Null)
            }
            other => Err(invalid(format!("unknown method {other}"))),
        };
        match result {
            Ok(value) => format!("{{\"ok\":true,\"result\":{value}}}"),
            Err(error) => error_reply(&error),
        }
    }

    /// Bytes fed for a later `open`, when the host uses [`Engine::feed`].
    fn take_fed_bytes(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.fed)
    }

    /// Feed file bytes for a later `open` (the WebAssembly host's shape).
    pub fn feed(&mut self, chunk: &[u8]) {
        self.fed.extend_from_slice(chunk);
    }

    pub fn fed_bytes(&self) -> usize {
        self.fed.len()
    }
}

fn error_reply(error: &SheetError) -> String {
    json!({"ok": false, "error": error.code, "message": error.detail}).to_string()
}

fn read_head(source: &mut Source, buffer: &mut [u8]) -> SheetResult<usize> {
    source.seek(SeekFrom::Start(0)).map_err(io_error)?;
    let mut filled = 0;
    while filled < buffer.len() {
        match source.read(&mut buffer[filled..]) {
            Ok(0) => break,
            Ok(read) => filled += read,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error) => return Err(io_error(error)),
        }
    }
    Ok(filled)
}

fn io_error(error: std::io::Error) -> SheetError {
    unsupported(format!("read: {error}"))
}

fn open_with<T, E: std::fmt::Debug>(result: Result<T, E>) -> SheetResult<T> {
    result.map_err(|error| unsupported(format!("container: {error:?}")))
}

fn sheet_list(sheets: &[calamine::Sheet]) -> Vec<SheetInfo> {
    sheets
        .iter()
        .map(|sheet| SheetInfo {
            name: sheet.name.clone(),
            visible: matches!(sheet.visible, calamine::SheetVisible::Visible),
        })
        .collect()
}

/// `design.md` §2 / S3: sum the central directory's declared sizes before calamine
/// opens the archive, so a zip bomb is refused without decompressing anything.
fn declared_decompressed_bytes(source: &mut Source) -> SheetResult<u64> {
    use zip::ZipArchive;
    let archive = ZipArchive::new(&mut *source)
        .map_err(|error| unsupported(format!("zip: {error}")))?;
    let mut total: u64 = 0;
    for index in 0..archive.len() {
        // Metadata only: no decompressor runs, no local data is read.
        let entry = archive
            .by_index_data(index)
            .map_err(|error| unsupported(format!("zip entry: {error}")))?;
        let size = entry.size();
        total = total.saturating_add(size);
    }
    Ok(total)
}

/// A window's rows, stopping when the accumulated serialized size passes the reply cap
/// so a pathological row cannot blow past 1 MiB.
fn window<F>(request: &RowsRequest, end: u32, mut row: F) -> Vec<Value>
where
    F: FnMut(u32) -> Value,
{
    let mut rows = Vec::new();
    let mut size = 0usize;
    let mut row_index = request.start;
    while row_index < end {
        let value = row(row_index);
        let length = serde_json::to_string(&value)
            .map(|text| text.len())
            .unwrap_or(0);
        if !rows.is_empty() && size + length > SHEET_MAX_RESPONSE_BYTES {
            break;
        }
        size += length + 1;
        rows.push(value);
        row_index += 1;
    }
    rows
}

/// Return fewer rows rather than a reply over 1 MiB (`design.md` §3.1).
fn trim_to_response_cap(reply: &mut Value) {
    for _ in 0..12 {
        let length = serde_json::to_string(reply)
            .map(|text| text.len())
            .unwrap_or(usize::MAX);
        if length <= SHEET_MAX_RESPONSE_BYTES {
            return;
        }
        let rows = reply["rows"].as_array().map(Vec::len).unwrap_or(0);
        if rows <= 1 {
            return;
        }
        if let Some(array) = reply["rows"].as_array_mut() {
            array.truncate(rows / 2);
        }
    }
}

fn load_xlsx(
    workbook: &mut Xlsx<Source>,
    name: &str,
    caps: Caps,
    date1904: bool,
    progress: &mut dyn FnMut(f64),
) -> SheetResult<Loaded> {
    let mut reader = workbook
        .worksheet_cells_reader(name)
        .map_err(|error| unsupported(format!("worksheet: {error:?}")))?;
    let dimensions = reader.dimensions();
    check_declared(dimensions.start, dimensions.end, caps)?;
    let declared = store::declared_cells(dimensions.start, dimensions.end);
    // Number formats come from the same pass (`next_cell_with_style_id`), so this is
    // one read of the sheet, not two (spike A, S4).
    let styles: Vec<NumFmt> = reader
        .styles()
        .iter()
        .map(|style| {
            NumFmt::parse(
                style
                    .number_format
                    .as_ref()
                    .map(|format| format.format_code.as_str())
                    .unwrap_or("General"),
            )
        })
        .collect();
    let hint = capacity_hint(dimensions);
    let mut store = store::Store::new(hint);
    let mut cells: u64 = 0;
    loop {
        let next = reader
            .next_cell_with_style_id()
            .map_err(|error| unsupported(format!("cell: {error:?}")))?;
        let Some((cell, style_id)) = next else {
            break;
        };
        cells += 1;
        if cells > caps.max_cells {
            return Err(too_complex("cells"));
        }
        if declared >= SHEET_PROGRESS_EVERY_CELLS && cells % SHEET_PROGRESS_EVERY_CELLS == 0 {
            progress((cells as f64 / declared as f64).min(1.0));
        }
        let (row, column) = cell.get_position();
        store.begin_row(row);
        let format = styles.get(style_id).copied().unwrap_or(NumFmt::General);
        push_data_ref(&mut store, column, cell.get_value(), format);
        if store.text.len() as u64 > caps.max_interned_text_bytes {
            return Err(too_complex("interned text"));
        }
    }
    drop(reader);
    store.finish_rows();
    if store::declared_cells(dimensions.start, dimensions.end) <= caps.merge_parse_max_cells {
        store.merges = workbook
            .merge_cells_by_sheet_name(name)
            .map(|merges| merge_list(&merges))
            .unwrap_or_default();
    }
    let _ = date1904;
    Ok(Loaded::Store(store))
}

fn load_xlsb(
    workbook: &mut Xlsb<Source>,
    name: &str,
    caps: Caps,
    date1904: bool,
    progress: &mut dyn FnMut(f64),
) -> SheetResult<Loaded> {
    // The `.xlsb` streaming reader has no style ids: number formats stay `General`
    // (recorded in the handoff).
    let mut reader = workbook
        .worksheet_cells_reader(name)
        .map_err(|error| unsupported(format!("worksheet: {error:?}")))?;
    let dimensions = reader.dimensions();
    check_declared(dimensions.start, dimensions.end, caps)?;
    let declared = store::declared_cells(dimensions.start, dimensions.end);
    let mut store = store::Store::new(capacity_hint(dimensions));
    let mut cells: u64 = 0;
    loop {
        let next = reader
            .next_cell()
            .map_err(|error| unsupported(format!("cell: {error:?}")))?;
        let Some(cell) = next else { break };
        cells += 1;
        if cells > caps.max_cells {
            return Err(too_complex("cells"));
        }
        if declared >= SHEET_PROGRESS_EVERY_CELLS && cells % SHEET_PROGRESS_EVERY_CELLS == 0 {
            progress((cells as f64 / declared as f64).min(1.0));
        }
        let (row, column) = cell.get_position();
        store.begin_row(row);
        push_data_ref(&mut store, column, cell.get_value(), NumFmt::General);
        if store.text.len() as u64 > caps.max_interned_text_bytes {
            return Err(too_complex("interned text"));
        }
    }
    store.finish_rows();
    let _ = date1904;
    Ok(Loaded::Store(store))
}

fn load_xls(workbook: &mut Xls<Source>, name: &str, caps: Caps) -> SheetResult<Loaded> {
    // `.xls` has no streaming reader in calamine, so the range is the only shape
    // (validation.md S1).
    let range = workbook
        .worksheet_range(name)
        .map_err(|error| unsupported(format!("worksheet: {error:?}")))?;
    let merges = workbook
        .merge_cells_by_sheet_name(name)
        .map(|merges| merge_list(&merges))
        .unwrap_or_default();
    Ok(range_sheet(range, merges, caps))
}

fn load_ods(workbook: &mut Ods<Source>, name: &str, caps: Caps) -> SheetResult<Loaded> {
    let range = workbook
        .worksheet_range(name)
        .map_err(|error| unsupported(format!("worksheet: {error:?}")))?;
    Ok(range_sheet(range, Vec::new(), caps))
}

fn range_sheet(range: Range<Data>, merges: Vec<Merge>, caps: Caps) -> Loaded {
    let (total_rows, total_columns) = match (range.start(), range.end()) {
        (Some(_), Some(end)) => (end.0 + 1, end.1 + 1),
        _ => (0, 0),
    };
    let _ = caps;
    Loaded::Range(RangeSheet {
        range,
        total_rows,
        total_columns,
        merges,
    })
}

fn check_declared(start: (u32, u32), end: (u32, u32), caps: Caps) -> SheetResult<()> {
    let cells = store::declared_cells(start, end);
    if cells > caps.max_cells {
        return Err(too_complex(format!("{cells} declared cells")));
    }
    Ok(())
}

fn capacity_hint(dimensions: calamine::Dimensions) -> usize {
    store::declared_cells(dimensions.start, dimensions.end).min(4_000_000) as usize
}

fn merge_list(dimensions: &[calamine::Dimensions]) -> Vec<Merge> {
    dimensions
        .iter()
        .map(|merge| Merge {
            row: merge.start.0,
            column: merge.start.1,
            rows: merge.end.0.saturating_sub(merge.start.0) + 1,
            columns: merge.end.1.saturating_sub(merge.start.1) + 1,
        })
        .collect()
}

fn push_data_ref(
    store: &mut store::Store,
    column: u32,
    value: &DataRef<'_>,
    format: NumFmt,
) {
    match value {
        DataRef::Empty => {}
        DataRef::Int(number) => store.push(column, store::K_NUM, (*number as f64).to_bits(), format),
        DataRef::Float(number) => store.push(column, store::K_NUM, number.to_bits(), format),
        DataRef::String(text) => store.push_interned(column, text, format),
        DataRef::SharedString(text) => store.push_interned(column, text, format),
        DataRef::Bool(value) => store.push(column, store::K_BOOL, *value as u64, format),
        DataRef::DateTime(date) => store.push(
            column,
            if date.is_datetime() {
                store::K_DATE
            } else {
                store::K_TIME
            },
            date.as_f64().to_bits(),
            format,
        ),
        DataRef::DateTimeIso(text) | DataRef::DurationIso(text) => {
            store.push_date_text(column, text)
        }
        DataRef::Error(error) => store.push_error(column, error_text(error)),
    }
}

fn data_json(value: &Data, date1904: bool) -> Value {
    match value {
        Data::Empty => Value::Null,
        Data::String(text) => json!(clip(text)),
        Data::Int(number) => json!([format_number(*number as f64), "n"]),
        Data::Float(number) => json!([format_number(*number), "n"]),
        Data::Bool(value) => json!([if *value { "TRUE" } else { "FALSE" }, "b"]),
        Data::DateTime(date) => json!([format_serial(date.as_f64(), date1904), "d"]),
        Data::DateTimeIso(text) | Data::DurationIso(text) => json!([text, "d"]),
        Data::Error(error) => json!([error_text(error), "e"]),
    }
}

fn clip(text: &str) -> String {
    if text.chars().count() <= SHEET_CELL_TEXT_LIMIT {
        return text.to_string();
    }
    text.chars().take(SHEET_CELL_TEXT_LIMIT).collect()
}

fn range_row_json(
    range: &Range<Data>,
    row: u32,
    request: &RowsRequest,
    date1904: bool,
    clipped: &mut bool,
) -> Value {
    let mut cells: Vec<Value> = Vec::new();
    let mut last_non_empty: i64 = -1;
    for column in
        request.column_start..request.column_start.saturating_add(request.column_count)
    {
        let value = range.get_value((row, column));
        let json = match value {
            Some(value) => {
                if matches!(value, Data::String(text) if text.chars().count() > SHEET_CELL_TEXT_LIMIT)
                {
                    *clipped = true;
                }
                data_json(value, date1904)
            }
            None => Value::Null,
        };
        if !json.is_null() {
            last_non_empty = cells.len() as i64;
        }
        cells.push(json);
    }
    cells.truncate((last_non_empty + 1) as usize);
    Value::Array(cells)
}

fn range_merges_touching(sheet: &RangeSheet, start: u32, end: u32) -> Vec<Value> {
    sheet
        .merges
        .iter()
        .filter(|merge| merge.row < end && merge.row + merge.rows > start)
        .map(|merge| json!([merge.row, merge.column, merge.rows, merge.columns]))
        .collect()
}

// ---------------------------------------------------------------------------
// WebAssembly C ABI (step 3's host): allocate, feed, request, free.
// No binding generator, no `wasm-bindgen`.
// ---------------------------------------------------------------------------
#[cfg(target_arch = "wasm32")]
mod abi {
    use super::*;
    use std::ptr;

    static mut ENGINE: Option<Engine> = None;
    static mut REPLY: Vec<u8> = Vec::new();

    fn engine() -> &'static mut Engine {
        unsafe {
            (*ptr::addr_of_mut!(ENGINE))
                .as_mut()
                .expect("engine_new first")
        }
    }

    #[no_mangle]
    pub extern "C" fn engine_new() -> u32 {
        unsafe {
            *ptr::addr_of_mut!(ENGINE) = Some(Engine::new(Caps::default()));
        }
        1
    }

    /// Allocate `len` writable bytes in linear memory; the host copies a chunk in.
    #[no_mangle]
    pub extern "C" fn alloc(len: usize) -> *mut u8 {
        let mut buffer = Vec::<u8>::with_capacity(len);
        let pointer = buffer.as_mut_ptr();
        std::mem::forget(buffer);
        pointer
    }

    #[no_mangle]
    pub extern "C" fn dealloc(pointer: *mut u8, len: usize) {
        unsafe { drop(Vec::from_raw_parts(pointer, 0, len)) }
    }

    /// Feed one chunk; returns the total bytes held so far.
    #[no_mangle]
    pub extern "C" fn feed(pointer: *const u8, len: usize) -> usize {
        let chunk = unsafe { std::slice::from_raw_parts(pointer, len) };
        let engine = engine();
        engine.feed(chunk);
        engine.fed_bytes()
    }

    /// Run one JSON request; the reply is readable with `reply_ptr`/`reply_len`.
    #[no_mangle]
    pub extern "C" fn request(pointer: *const u8, len: usize) -> usize {
        let bytes = unsafe { std::slice::from_raw_parts(pointer, len) };
        let request = String::from_utf8_lossy(bytes).into_owned();
        let reply = engine().request(&request);
        unsafe {
            let buffer = &mut *ptr::addr_of_mut!(REPLY);
            buffer.clear();
            buffer.extend_from_slice(reply.as_bytes());
            buffer.len()
        }
    }

    #[no_mangle]
    pub extern "C" fn reply_ptr() -> *const u8 {
        unsafe { (*ptr::addr_of!(REPLY)).as_ptr() }
    }

    #[no_mangle]
    pub extern "C" fn reply_len() -> usize {
        unsafe { (*ptr::addr_of!(REPLY)).len() }
    }

    #[no_mangle]
    pub extern "C" fn close() {
        unsafe {
            *ptr::addr_of_mut!(ENGINE) = None;
        }
    }
}

#[cfg(test)]
mod tests;
