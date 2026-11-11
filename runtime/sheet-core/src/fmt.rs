//! Value text: dates (R13), General numbers (R13) and the number formats of
//! `design.md` §3.2 / spike A "Number formats" (percent, fixed decimals, thousands).
//!
//! Everything here is pure arithmetic on values the store already holds, so it runs
//! unchanged in the native helper and in the WebAssembly reader.

/// How a numeric cell is drawn. Derived from the cell's style number format code in
/// the same streaming pass that reads the value (spike A, `next_cell_with_style_id`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum NumFmt {
    /// `General`: up to 15 significant digits, no trailing zeros (R13).
    General,
    /// `0.00%` and friends: the fraction is multiplied by 100 and suffixed with `%`.
    Percent(u8),
    /// `0.00`: a fixed number of decimals.
    Fixed(u8),
    /// `#,##0.00`: fixed decimals with thousands separators.
    Thousands(u8),
}

impl NumFmt {
    /// Map a style's number format code to the small set R16 asks for. Anything else
    /// (currency, accounting, scientific, text) falls back to `General`, which still
    /// shows the value: a wrong-looking number is better than a blank cell.
    pub fn parse(code: &str) -> NumFmt {
        // Only the positive section matters; `;;;`-style sections and the negative
        // section are drawn the same way.
        let section = split_sections(code).next().unwrap_or("");
        let mut decimals = 0u8;
        let mut seen_dot = false;
        let mut thousands = false;
        let mut percent = false;
        let mut digit_after_dot = false;
        let mut chars = section.chars().peekable();
        while let Some(c) = chars.next() {
            match c {
                '"' => {
                    // Quoted literal: `"$"#,##0.00`.
                    for q in chars.by_ref() {
                        if q == '"' {
                            break;
                        }
                    }
                }
                '\\' => {
                    chars.next();
                }
                '[' => {
                    // Colour, locale and condition codes: `[Red]`, `[$-409]`.
                    for q in chars.by_ref() {
                        if q == ']' {
                            break;
                        }
                    }
                }
                '_' | '*' => {
                    // Padding placeholder consumes the next character.
                    chars.next();
                }
                '.' => {
                    seen_dot = true;
                    digit_after_dot = false;
                }
                '0' | '#' | '?' => {
                    if seen_dot {
                        digit_after_dot = true;
                        decimals = decimals.saturating_add(1);
                    }
                }
                ',' => {
                    // A comma between digit placeholders is a thousands separator; a
                    // trailing one scales by 1000, which we do not implement.
                    if !seen_dot {
                        thousands = true;
                    }
                }
                '%' => percent = true,
                _ => {}
            }
        }
        if !digit_after_dot {
            decimals = 0;
        }
        if percent {
            NumFmt::Percent(decimals)
        } else if thousands {
            NumFmt::Thousands(decimals)
        } else if seen_dot {
            NumFmt::Fixed(decimals)
        } else {
            NumFmt::General
        }
    }

    /// One numeric cell's text. Dates and booleans never reach this: they carry their
    /// own kind.
    pub fn text(&self, value: f64) -> String {
        match *self {
            NumFmt::General => format_number(value),
            NumFmt::Percent(decimals) => {
                let text = match decimals {
                    0 => format!("{:.0}", value * 100.0),
                    n => format!("{:.*}", n as usize, value * 100.0),
                };
                format!("{text}%")
            }
            NumFmt::Fixed(decimals) => format!("{:.*}", decimals as usize, value),
            NumFmt::Thousands(decimals) => group(&format!("{:.*}", decimals as usize, value)),
        }
    }
}

fn split_sections(code: &str) -> impl Iterator<Item = &str> {
    code.split(';')
}

/// Insert `,` every three digits of the integer part. `-1234567.89` -> `-1,234,567.89`.
fn group(text: &str) -> String {
    let (sign, rest) = match text.strip_prefix('-') {
        Some(rest) => ("-", rest),
        None => ("", text),
    };
    let (integer, fraction) = match rest.split_once('.') {
        Some((integer, fraction)) => (integer, Some(fraction)),
        None => (rest, None),
    };
    let mut out = String::with_capacity(text.len() + text.len() / 3 + 1);
    out.push_str(sign);
    for (index, ch) in integer.chars().enumerate() {
        if index > 0 && (integer.len() - index) % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    if let Some(fraction) = fraction {
        out.push('.');
        out.push_str(fraction);
    }
    out
}

/// Excel serial date to `YYYY-MM-DD[ HH:MM:SS]`, 1900 or 1904 system (R13).
pub fn format_serial(serial: f64, date1904: bool) -> String {
    if !serial.is_finite() {
        return String::new();
    }
    let serial = if date1904 { serial + 1462.0 } else { serial };
    let mut days = serial.floor() as i64;
    let frac = serial - days as f64;
    // 1900 system: serial 60 is the non-existent 1900-02-29, so dates before
    // 1900-03-01 are one day later than plain epoch arithmetic says.
    if !date1904 && days < 60 {
        days += 1;
    }
    let (y, m, d) = civil_from_days(days - 25569);
    let mut secs = (frac * 86400.0).round() as i64;
    if secs >= 86400 {
        secs = 86399;
    }
    let (hh, mm, ss) = (secs / 3600, (secs / 60) % 60, secs % 60);
    if hh == 0 && mm == 0 && ss == 0 {
        format!("{y:04}-{m:02}-{d:02}")
    } else {
        format!("{y:04}-{m:02}-{d:02} {hh:02}:{mm:02}:{ss:02}")
    }
}

/// Howard Hinnant's civil-from-days: days since 1970-01-01 to (y, m, d).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// General-style number text: 15 significant digits, no trailing zeros (R13).
pub fn format_number(v: f64) -> String {
    if !v.is_finite() {
        return String::new();
    }
    if v == 0.0 {
        return "0".to_string();
    }
    if v.fract() == 0.0 && v.abs() < 1e15 {
        return format!("{}", v as i64);
    }
    let mut s = format!("{v:.14e}");
    let Some(epos) = s.find('e') else {
        return s;
    };
    let exp: i32 = s[epos + 1..].parse().unwrap_or(0);
    let mantissa: String = s[..epos].chars().filter(|c| *c != '.').collect();
    let neg = mantissa.starts_with('-');
    let digits = mantissa.trim_start_matches('-').trim_end_matches('0');
    let digits = if digits.is_empty() { "0" } else { digits };
    if exp >= 0 {
        let e = exp as usize;
        let mut out = String::new();
        if neg {
            out.push('-');
        }
        if digits.len() <= e + 1 {
            out.push_str(digits);
            for _ in 0..(e + 1 - digits.len()) {
                out.push('0');
            }
        } else {
            out.push_str(&digits[..e + 1]);
            out.push('.');
            out.push_str(&digits[e + 1..]);
        }
        s = out;
    } else {
        let e = (-exp) as usize;
        let mut out = String::new();
        if neg {
            out.push('-');
        }
        out.push_str("0.");
        for _ in 1..e {
            out.push('0');
        }
        out.push_str(digits);
        s = out;
    }
    s
}

/// calamine's error value as Excel spells it.
pub fn error_text(e: &calamine::CellErrorType) -> &'static str {
    use calamine::CellErrorType::*;
    match e {
        Div0 => "#DIV/0!",
        NA => "#N/A",
        Name => "#NAME?",
        Null => "#NULL!",
        Num => "#NUM!",
        Ref => "#REF!",
        Value => "#VALUE!",
        GettingData => "#GETTING_DATA",
    }
}
