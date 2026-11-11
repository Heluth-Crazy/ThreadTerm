//! Sheet-core tests (`design.md` §8): signatures, caps, window bounds and trimming,
//! value formatting, dates and the 1904 system, number formats, a used range that does
//! not start at `A1`, protected and truncated files.

use super::*;
use serde_json::Value;
use std::path::PathBuf;
use std::time::Instant;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join(name)
}

fn bytes(name: &str) -> Vec<u8> {
    std::fs::read(fixture(name)).unwrap_or_else(|error| panic!("{name}: {error}"))
}

fn open(name: &str, format: SheetFormat) -> Engine {
    let mut engine = Engine::default();
    engine.open_bytes(bytes(name), format).expect("open");
    engine
}

fn window(engine: &Engine, request: RowsRequest) -> Value {
    engine.rows(&request).expect("rows")
}

fn full(sheet: u32, start: u32, count: u32) -> RowsRequest {
    RowsRequest {
        sheet,
        start,
        count,
        column_start: 0,
        column_count: SHEET_MAX_COLS_REQUEST,
    }
}

fn cells(window: &Value, row: usize) -> Vec<Value> {
    window["rows"][row].as_array().cloned().unwrap_or_default()
}

// --- signature and container checks (design.md §2) -------------------------

#[test]
fn random_bytes_are_not_a_workbook() {
    let mut engine = Engine::default();
    let error = engine
        .open_bytes(b"just some text".to_vec(), SheetFormat::Xlsx)
        .unwrap_err();
    assert_eq!(error.code, CODE_UNSUPPORTED);
}

#[test]
fn an_ole2_container_under_a_zip_name_is_protected() {
    let mut engine = Engine::default();
    let error = engine
        .open_bytes(bytes("features-encrypted.xlsx"), SheetFormat::Xlsx)
        .unwrap_err();
    assert_eq!(error.code, CODE_PROTECTED);
}

#[test]
fn a_zip_container_under_an_xls_name_is_unsupported() {
    let mut engine = Engine::default();
    let error = engine
        .open_bytes(bytes("features.xlsx"), SheetFormat::Xls)
        .unwrap_err();
    assert_eq!(error.code, CODE_UNSUPPORTED);
}

#[test]
fn a_truncated_workbook_is_unsupported_not_a_panic() {
    let mut engine = Engine::default();
    let error = engine
        .open_bytes(bytes("truncated.xlsx"), SheetFormat::Xlsx)
        .unwrap_err();
    // The spike's truncated fixture keeps enough of its central directory to open, but
    // its sheet XML is cut. Either way the answer is a code, never a crash.
    if error.code != CODE_UNSUPPORTED {
        assert_eq!(error.code, CODE_TOO_COMPLEX, "{error:?}");
    }
}

#[test]
fn the_empty_file_is_unsupported() {
    let mut engine = Engine::default();
    assert_eq!(
        engine.open_bytes(Vec::new(), SheetFormat::Xlsx).unwrap_err().code,
        CODE_UNSUPPORTED
    );
}

#[test]
fn the_extension_chooses_the_format() {
    for name in ["a.xlsx", "a.XLSX", "a.xlsm", "C:\\dir.x\\b.xlsx", "a/b/c.xlsb"] {
        assert!(SheetFormat::from_path(name).is_some(), "{name}");
    }
    assert_eq!(SheetFormat::from_path("a.xls"), Some(SheetFormat::Xls));
    assert_eq!(SheetFormat::from_path("a.ods"), Some(SheetFormat::Ods));
    for name in ["a.docx", "a.csv", "xlsx", ".xlsx", "a.", ""] {
        assert_eq!(SheetFormat::from_path(name), None, "{name}");
    }
}

// --- caps (validation.md S3) ----------------------------------------------

/// A store-method zip built by hand: the central directory can declare whatever
/// decompressed size the test wants without writing that many bytes.
fn crafted_zip(entries: &[(&str, u32)]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut central = Vec::new();
    for (name, size) in entries {
        let offset = out.len() as u32;
        let push16 = |buffer: &mut Vec<u8>, value: u16| buffer.extend_from_slice(&value.to_le_bytes());
        let push32 = |buffer: &mut Vec<u8>, value: u32| buffer.extend_from_slice(&value.to_le_bytes());
        out.extend_from_slice(b"PK\x03\x04");
        push16(&mut out, 20);
        push16(&mut out, 0);
        push16(&mut out, 0);
        push16(&mut out, 0);
        push16(&mut out, 0);
        push32(&mut out, 0);
        push32(&mut out, 0);
        push32(&mut out, *size);
        push16(&mut out, name.len() as u16);
        push16(&mut out, 0);
        out.extend_from_slice(name.as_bytes());

        central.extend_from_slice(b"PK\x01\x02");
        push16(&mut central, 20);
        push16(&mut central, 20);
        push16(&mut central, 0);
        push16(&mut central, 0);
        push16(&mut central, 0);
        push16(&mut central, 0);
        push32(&mut central, 0);
        push32(&mut central, 0);
        push32(&mut central, *size);
        push16(&mut central, name.len() as u16);
        push16(&mut central, 0);
        push16(&mut central, 0);
        push16(&mut central, 0);
        push16(&mut central, 0);
        push32(&mut central, 0);
        push32(&mut central, offset);
        central.extend_from_slice(name.as_bytes());
    }
    let central_offset = out.len() as u32;
    let central_length = central.len() as u32;
    out.extend_from_slice(&central);
    out.extend_from_slice(b"PK\x05\x06");
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&central_length.to_le_bytes());
    out.extend_from_slice(&central_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

#[test]
fn a_zip_declaring_more_than_the_cap_is_refused_before_parsing() {
    // 2 GiB + 1 byte in the central directory, with no data behind it.
    let zip = crafted_zip(&[("xl/worksheets/sheet1.xml", u32::MAX), ("other", 1)]);
    let mut engine = Engine::default();
    let error = engine.open_bytes(zip, SheetFormat::Xlsx).unwrap_err();
    assert_eq!(error.code, CODE_TOO_COMPLEX);
    assert!(error.detail.contains("decompressed"), "{error:?}");
}

#[test]
fn a_zip_under_the_cap_is_allowed_through_to_the_parser() {
    let zip = crafted_zip(&[("xl/workbook.xml", 1024)]);
    let mut engine = Engine::default();
    // Past the zip gate, calamine rejects the (fake) container.
    let error = engine.open_bytes(zip, SheetFormat::Xlsx).unwrap_err();
    assert_eq!(error.code, CODE_UNSUPPORTED);
}

#[test]
fn the_cell_cap_stops_a_load() {
    let caps = Caps {
        max_cells: 4,
        ..Caps::default()
    };
    let mut engine = Engine::new(caps);
    engine
        .open_bytes(bytes("features.xlsx"), SheetFormat::Xlsx)
        .expect("open");
    // The declared range alone is over four cells, so the load refuses immediately.
    assert_eq!(engine.load(0).unwrap_err().code, CODE_TOO_COMPLEX);
}

#[test]
fn the_interned_text_cap_stops_a_load() {
    let caps = Caps {
        max_interned_text_bytes: 8,
        ..Caps::default()
    };
    let mut engine = Engine::new(caps);
    engine
        .open_bytes(bytes("features.xlsx"), SheetFormat::Xlsx)
        .expect("open");
    assert_eq!(engine.load(0).unwrap_err().code, CODE_TOO_COMPLEX);
}

// --- values, dates and number formats (R13, S4) ---------------------------

#[test]
fn the_sheet_list_reports_hidden_sheets() {
    let engine = open("features.xlsx", SheetFormat::Xlsx);
    assert_eq!(engine.sheets().len(), 2);
    assert_eq!(engine.sheets()[0].name, "Features");
    assert!(engine.sheets()[0].visible);
    assert_eq!(engine.sheets()[1].name, "hidden-Rates");
    assert!(!engine.sheets()[1].visible);
    assert!(!engine.date1904());
}

#[test]
fn a_used_range_that_starts_at_c5_keeps_its_real_coordinates() {
    let mut engine = open("features.xlsx", SheetFormat::Xlsx);
    assert!(!engine.is_loaded(0));
    engine.load(0).expect("load");
    let window = window(&engine, full(0, 0, 20));
    assert_eq!(window["state"], "ready");
    assert_eq!(window["totalRows"], 13);
    assert_eq!(window["totalColumns"], 6);
    // Rows 0..3 are empty, and row 4 starts at column C.
    for row in 0..4 {
        assert_eq!(cells(&window, row), Vec::<Value>::new(), "row {row}");
    }
    let row5 = cells(&window, 4);
    assert_eq!(row5[0], Value::Null);
    assert_eq!(row5[1], Value::Null);
    assert_eq!(row5[2], json!(["42", "n"]));
    assert_eq!(row5[3], json!("Used range starts here"));
}

#[test]
fn values_dates_and_number_formats_match_r13_and_s4() {
    let mut engine = open("features.xlsx", SheetFormat::Xlsx);
    engine.load(0).expect("load");
    let window = window(&engine, full(0, 4, 9));
    // Row 5 (C6/D6): a decimal and a whole number stay General.
    assert_eq!(cells(&window, 1), vec![Value::Null, Value::Null, json!(["1.5", "n"]), json!(["6", "n"])]);
    // Row 6 (C7/D7/E7): serial dates, one with a time, one on the 167 style.
    assert_eq!(
        cells(&window, 2),
        vec![
            Value::Null,
            Value::Null,
            json!(["2023-03-15", "d"]),
            json!(["2023-03-15 12:30:00", "d"]),
            json!(["2023-03-15 18:00:00", "d"]),
        ]
    );
    // Row 7 (C8/D8/E8): percent, thousands separators, negative thousands.
    assert_eq!(
        cells(&window, 3),
        vec![
            Value::Null,
            Value::Null,
            json!(["18.75%", "n"]),
            json!(["1,234,567.89", "n"]),
            json!(["-987.50", "n"]),
        ]
    );
    // Row 8 (C9/D9/E9): formulas report their cached value, nothing is recalculated.
    assert_eq!(
        cells(&window, 4),
        vec![Value::Null, Value::Null, json!(["7.5", "n"]), json!(["7.5", "n"]), json!("ab")]
    );
    // Row 11 (C12..F12): boolean, error, 2000-character text, 15 digits.
    let row12 = cells(&window, 7);
    assert_eq!(row12[2], json!(["TRUE", "b"]));
    assert_eq!(row12[3], json!(["#DIV/0!", "e"]));
    assert_eq!(row12[4].as_str().unwrap().len() >= 1999, true);
    // The fixture cell is 2000 characters, so nothing is clipped.
    assert_eq!(row12[5], json!(["123456789012345", "n"]));
    assert_eq!(window["clipped"], false);
    // Row 12 (C13..E13): an error, a fraction and a small General number.
    assert_eq!(
        cells(&window, 8),
        vec![Value::Null, Value::Null, json!(["#N/A", "e"]), json!(["0.1", "n"]), json!(["0.0000001", "n"])]
    );
}

#[test]
fn a_hidden_sheet_is_still_readable() {
    let mut engine = open("features.xlsx", SheetFormat::Xlsx);
    engine.load(1).expect("load");
    let window = window(&engine, full(1, 0, 5));
    assert_eq!(
        cells(&window, 0),
        vec![json!(["1", "n"]), json!(["25.00%", "n"])]
    );
}

#[test]
fn merges_of_a_small_sheet_reach_the_window_reply() {
    // The merge pass is off by default (SHEET_MERGE_PARSE_MAX_CELLS is 0); a host that
    // wants spans lowers the gate, and this is the reply it then gets.
    let caps = Caps {
        merge_parse_max_cells: u64::MAX,
        ..Caps::default()
    };
    let mut engine = Engine::new(caps);
    engine
        .open_bytes(bytes("features.xlsx"), SheetFormat::Xlsx)
        .expect("open");
    engine.load(0).expect("load");
    let nearby = window(&engine, full(0, 4, 3));
    let merges = nearby["merges"].as_array().cloned().unwrap_or_default();
    assert!(merges.contains(&json!([4, 2, 1, 2])), "{merges:?}");
    assert!(merges.contains(&json!([5, 2, 3, 1])), "{merges:?}");
    // A window far below the merges reports none.
    let far = window(&engine, full(0, 11, 2));
    assert!(far.get("merges").is_none());
}

#[test]
fn merges_stay_out_of_the_reply_by_default() {
    // Measured cost of the second XML pass: +73.5 % on numbers-100, +32.4 % on
    // strings-100, +64.5 % on sheets-10x10. Over design.md §3.1's 10 % gate.
    let mut engine = open("features.xlsx", SheetFormat::Xlsx);
    engine.load(0).expect("load");
    let nearby = window(&engine, full(0, 4, 3));
    assert!(nearby.get("merges").is_none());
}

#[test]
fn the_1904_system_shifts_every_date() {
    let mut engine = open("features-1904.xlsx", SheetFormat::Xlsx);
    assert!(engine.date1904());
    engine.load(0).expect("load");
    let window = window(&engine, full(0, 6, 1));
    // Serial 45000 in the 1904 system is four years and a day after the 1900 reading.
    assert_eq!(cells(&window, 0)[2], json!(["2027-03-16", "d"]));
}

#[test]
fn general_numbers_keep_fifteen_significant_digits() {
    assert_eq!(format_number(42.0), "42");
    assert_eq!(format_number(-987.5), "-987.5");
    assert_eq!(format_number(1234567.891), "1234567.891");
    assert_eq!(format_number(1e-7), "0.0000001");
    assert_eq!(format_number(123456789012345.0), "123456789012345");
    assert_eq!(format_number(0.0), "0");
    assert_eq!(format_number(f64::NAN), "");
}

#[test]
fn number_format_codes_map_to_the_small_set_r16_asks_for() {
    use NumFmt::*;
    assert_eq!(NumFmt::parse("General"), General);
    assert_eq!(NumFmt::parse("0"), General);
    assert_eq!(NumFmt::parse("0.00%"), Percent(2));
    assert_eq!(NumFmt::parse("0%"), Percent(0));
    assert_eq!(NumFmt::parse("#,##0.00"), Thousands(2));
    assert_eq!(NumFmt::parse("#,##0"), Thousands(0));
    assert_eq!(NumFmt::parse("\"$\"#,##0.00"), Thousands(2));
    assert_eq!(NumFmt::parse("0.000"), Fixed(3));
    assert_eq!(NumFmt::parse("yyyy-mm-dd"), General);
    assert_eq!(NumFmt::parse("[Red]0.0"), Fixed(1));
    assert_eq!(NumFmt::parse("0.00;(-0.00)"), Fixed(2));
    assert_eq!(Percent(2).text(0.1875), "18.75%");
    assert_eq!(Thousands(2).text(1234567.891), "1,234,567.89");
    assert_eq!(Thousands(2).text(-987.5), "-987.50");
    assert_eq!(Fixed(0).text(-0.4), "-0");
}

#[test]
fn serial_dates_cover_both_epochs_and_the_leap_year_bug() {
    assert_eq!(format_serial(45000.0, false), "2023-03-15");
    assert_eq!(format_serial(45000.0 + 0.75, false), "2023-03-15 18:00:00");
    assert_eq!(format_serial(0.0, false), "1899-12-31");
    assert_eq!(format_serial(60.0, false), "1900-02-28");
    assert_eq!(format_serial(0.0, true), "1904-01-01");
    assert_eq!(format_serial(45000.0, true), "2027-03-16");
}

// --- window bounds and trimming ------------------------------------------

#[test]
fn window_bounds_are_clamped_and_trimmed() {
    let mut engine = open("features.xlsx", SheetFormat::Xlsx);
    engine.load(0).expect("load");
    // Past the last row: a truthful, empty answer.
    let past = window(&engine, full(0, 500, 10));
    assert_eq!(past["state"], "ready");
    assert_eq!(past["rows"], json!([]));
    assert_eq!(past["totalRows"], 13);
    // A row request over the limit is clamped to 500.
    let request = RowsRequest::from_json(&json!({"sheet": 0, "start": 0, "count": 10_000, "columnCount": 10_000})).unwrap();
    assert_eq!(request.count, SHEET_MAX_ROWS_REQUEST);
    assert_eq!(request.column_count, SHEET_MAX_COLS_REQUEST);
    // A column window that skips the data still names the right coordinates.
    let shifted = window(
        &engine,
        RowsRequest {
            sheet: 0,
            start: 4,
            count: 1,
            column_start: 2,
            column_count: 2,
        },
    );
    assert_eq!(shifted["columnStart"], 2);
    assert_eq!(cells(&shifted, 0), vec![json!(["42", "n"]), json!("Used range starts here")]);
    // Trimming: trailing empty cells are dropped, so a wide window stays small.
    let wide = window(&engine, full(0, 4, 1));
    assert!(wide["rows"][0].as_array().unwrap().len() < SHEET_MAX_COLS_REQUEST as usize);
}

#[test]
fn a_bad_window_request_is_invalid() {
    assert_eq!(
        RowsRequest::from_json(&json!({"sheet": 0})).unwrap_err().code,
        CODE_INVALID
    );
    assert_eq!(
        RowsRequest::from_json(&json!({"sheet": 0, "start": 0, "count": 0})).unwrap_err().code,
        CODE_INVALID
    );
    assert_eq!(
        RowsRequest::from_json(&json!({"sheet": 0, "start": -1, "count": 1})).unwrap_err().code,
        CODE_INVALID
    );
}

#[test]
fn rows_answers_loading_before_the_sheet_is_loaded() {
    let engine = open("features.xlsx", SheetFormat::Xlsx);
    assert!(!engine.is_loaded(0));
    let window = window(&engine, full(0, 0, 10));
    assert_eq!(window["state"], "loading");
    assert_eq!(window["totalRows"], 0);
    assert_eq!(window["rows"], json!([]));
    // An unknown sheet is an error, not a load.
    assert_eq!(
        engine.rows(&full(9, 0, 10)).unwrap_err().code,
        CODE_NOT_FOUND
    );
}

#[test]
fn a_reply_stays_inside_one_megabyte() {
    // Eight rows of 2000-character cells are four megabytes; only a trimmed window
    // fits in the 1 MiB reply cap.
    let mut store = store::Store::new(0);
    for row in 0..8 {
        store.begin_row(row);
        for column in 0..SHEET_MAX_COLS_REQUEST {
            store.push_interned(column, &"x".repeat(SHEET_CELL_TEXT_LIMIT), NumFmt::General);
        }
    }
    store.finish_rows();
    let mut clipped = false;
    let mut rows = Vec::new();
    for row in 0..8 {
        rows.push(store.row_json(row, 0, SHEET_MAX_COLS_REQUEST, false, &mut clipped));
    }
    let mut reply = json!({"state": "ready", "rows": rows});
    assert!(serde_json::to_string(&reply).unwrap().len() > SHEET_MAX_RESPONSE_BYTES);
    trim_to_response_cap(&mut reply);
    assert!(serde_json::to_string(&reply).unwrap().len() <= SHEET_MAX_RESPONSE_BYTES);
    assert!(reply["rows"].as_array().unwrap().len() >= 1);
}

// --- other containers -----------------------------------------------------

#[test]
fn xls_xlsb_and_ods_open_and_page() {
    for (name, format) in [
        ("date.xls", SheetFormat::Xls),
        ("date.xlsb", SheetFormat::Xlsb),
        ("any_sheets.xlsb", SheetFormat::Xlsb),
        ("any_sheets.ods", SheetFormat::Ods),
        ("special_cells.ods", SheetFormat::Ods),
    ] {
        let mut engine = open(name, format);
        assert!(!engine.sheets().is_empty(), "{name}");
        engine.load(0).unwrap_or_else(|error| panic!("{name}: {error:?}"));
        let window = window(&engine, full(0, 0, 20));
        assert_eq!(window["state"], "ready", "{name}");
        assert!(
            window["totalRows"].as_u64().unwrap_or(0) > 0,
            "{name} has rows"
        );
        assert!(
            window["rows"].as_array().map(Vec::len).unwrap_or(0) > 0,
            "{name} returned rows"
        );
    }
}

#[test]
fn a_password_protected_xls_is_refused() {
    // An OLE2 `.xls` opens as an OLE2 container; calamine reports the encryption.
    let mut engine = Engine::default();
    match engine.open_bytes(bytes("password_protected.xls"), SheetFormat::Xls) {
        Ok(_) => {
            // Opening the container can succeed; reading a sheet must not.
            let error = engine.load(0).unwrap_err();
            assert!(
                matches!(error.code, CODE_PROTECTED | CODE_UNSUPPORTED),
                "{error:?}"
            );
        }
        Err(error) => assert!(
            matches!(error.code, CODE_PROTECTED | CODE_UNSUPPORTED),
            "{error:?}"
        ),
    }
}

// --- the JSON envelope the hosts share ------------------------------------

#[test]
fn the_json_envelope_answers_every_method() {
    let mut engine = Engine::default();
    for chunk in bytes("features.xlsx").chunks(1024) {
        engine.feed(chunk);
    }
    let opened = engine.request(r#"{"method":"open","format":"xlsx"}"#);
    assert!(opened.starts_with(r#"{"ok":true"#), "{opened}");
    assert!(opened.contains("hidden-Rates"), "{opened}");
    let loading = engine.request(r#"{"method":"rows","sheet":0,"start":0,"count":5}"#);
    assert!(loading.contains(r#""state":"loading""#), "{loading}");
    let loaded = engine.request(r#"{"method":"load","sheet":0}"#);
    assert!(loaded.contains(r#""state":"ready""#), "{loaded}");
    let ready = engine.request(r#"{"method":"rows","sheet":0,"start":6,"count":1}"#);
    assert!(ready.contains(r#""state":"ready""#), "{ready}");
    assert!(ready.contains("2023-03-15"), "{ready}");
    let closed = engine.request(r#"{"method":"close"}"#);
    assert_eq!(closed, r#"{"ok":true,"result":null}"#);
    let unknown = engine.request(r#"{"method":"nope"}"#);
    assert!(unknown.contains(CODE_INVALID), "{unknown}");
    let broken = engine.request("not json");
    assert!(broken.contains(CODE_INVALID), "{broken}");
}

// --- merge cost (design.md §3.1: include only under 10 % extra) ----------

/// Times a load with and without the merge pass. The committed fixture always runs;
/// the three 100 MiB fixtures run when `TT_SHEET_FIXTURES` names their folder.
#[test]
fn merge_loading_cost() {
    let folder = std::env::var_os("TT_SHEET_FIXTURES").map(PathBuf::from);
    let mut cases: Vec<(String, SheetFormat)> = vec![(
        fixture("features.xlsx").to_string_lossy().into_owned(),
        SheetFormat::Xlsx,
    )];
    if let Some(folder) = &folder {
        for name in ["numbers-100.xlsx", "strings-100.xlsx", "sheets-10x10.xlsx"] {
            let path = folder.join(name);
            if path.is_file() {
                cases.push((path.to_string_lossy().into_owned(), SheetFormat::Xlsx));
            }
        }
    }
    for (path, format) in cases {
        let data = std::fs::read(&path).unwrap();
        let timing = |merges: bool| {
            let caps = Caps {
                merge_parse_max_cells: if merges { u64::MAX } else { 0 },
                ..Caps::default()
            };
            let mut engine = Engine::new(caps);
            engine
                .open_bytes(data.clone(), format)
                .expect("open the merge fixture");
            let started = Instant::now();
            engine.load(0).expect("load the merge fixture");
            let elapsed = started.elapsed().as_secs_f64();
            let loaded_merges = match engine.loaded.get(&0) {
                Some(Loaded::Store(store)) => store.merges.len(),
                _ => 0,
            };
            (elapsed, loaded_merges)
        };
        let (without, _) = timing(false);
        let (with, merges) = timing(true);
        let extra = if without > 0.0 {
            (with - without) / without * 100.0
        } else {
            0.0
        };
        println!(
            "merge cost {}: without {:.3}s, with {:.3}s, +{:.1}%, {} merges",
            path, without, with, extra, merges
        );
    }
}
