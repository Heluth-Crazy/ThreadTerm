use std::io;
use std::sync::Arc;

use wezterm_term::color::{ColorAttribute, ColorPalette};
use wezterm_term::{
    Blink, CellAttributes, Intensity, Terminal, TerminalConfiguration, TerminalSize, Underline,
};

#[derive(Clone, Debug)]
pub(super) struct TerminalSnapshotPayload {
    pub(super) data: String,
    pub(super) rows: u16,
    pub(super) cols: u16,
    pub(super) cursor_row: u16,
    pub(super) cursor_col: u16,
    pub(super) history: Option<String>,
}

/// Returns true when the wezterm-serialized payload would render as an empty
/// screen — no scrollback history and `data` is nothing but cursor positioning
/// escapes (and optional whitespace). This happens when wezterm's current
/// screen has no visible cells (e.g. immediately after construction, or while
/// a CLI is in a long-running quiet phase such as an upgrade install). Callers
/// can fall back to a raw byte buffer in that case so the freshly-attached
/// xterm does not render a black screen.
pub(super) fn is_visually_empty_payload(payload: &TerminalSnapshotPayload) -> bool {
    if payload
        .history
        .as_deref()
        .map(|history| !history.trim().is_empty())
        .unwrap_or(false)
    {
        return false;
    }

    let stripped = strip_cursor_position_escapes(&payload.data);
    stripped.trim().is_empty()
}

/// Removes `\x1b[H`, `\x1b[<row>;<col>H`, and `\x1b[<row>;<col>f` cursor
/// positioning sequences from `data`. Anything else (text, SGR attributes,
/// other CSI sequences) is preserved so the visually-empty check stays
/// conservative.
fn strip_cursor_position_escapes(data: &str) -> String {
    let bytes = data.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == 0x1b && i + 1 < bytes.len() && bytes[i + 1] == b'[' {
            let mut j = i + 2;
            let params_start = j;
            while j < bytes.len() {
                let c = bytes[j];
                if c.is_ascii_digit() || c == b';' {
                    j += 1;
                } else {
                    break;
                }
            }
            if j < bytes.len() && (bytes[j] == b'H' || bytes[j] == b'f') {
                let params = &bytes[params_start..j];
                if params.is_empty() || params.iter().all(|c| c.is_ascii_digit() || *c == b';') {
                    i = j + 1;
                    continue;
                }
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[derive(Debug)]
struct WeztermConfig {
    scrollback_limit: usize,
}

impl TerminalConfiguration for WeztermConfig {
    fn scrollback_size(&self) -> usize {
        self.scrollback_limit
    }

    fn color_palette(&self) -> ColorPalette {
        ColorPalette::default()
    }
}

pub(super) struct TerminalSnapshot {
    terminal: Terminal,
    rows: u16,
    cols: u16,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct AttrState {
    intensity: Intensity,
    underline: Underline,
    blink: Blink,
    italic: bool,
    reverse: bool,
    strikethrough: bool,
    invisible: bool,
    overline: bool,
    fg: ColorAttribute,
    bg: ColorAttribute,
}

impl Default for AttrState {
    fn default() -> Self {
        Self {
            intensity: Intensity::Normal,
            underline: Underline::None,
            blink: Blink::None,
            italic: false,
            reverse: false,
            strikethrough: false,
            invisible: false,
            overline: false,
            fg: ColorAttribute::Default,
            bg: ColorAttribute::Default,
        }
    }
}

impl AttrState {
    fn from_attrs(attrs: &CellAttributes) -> Self {
        Self {
            intensity: attrs.intensity(),
            underline: attrs.underline(),
            blink: attrs.blink(),
            italic: attrs.italic(),
            reverse: attrs.reverse(),
            strikethrough: attrs.strikethrough(),
            invisible: attrs.invisible(),
            overline: attrs.overline(),
            fg: attrs.foreground(),
            bg: attrs.background(),
        }
    }
}

impl TerminalSnapshot {
    pub(super) fn new(rows: u16, cols: u16, scrollback_limit: usize) -> Self {
        let size = TerminalSize {
            rows: rows as usize,
            cols: cols as usize,
            pixel_width: 0,
            pixel_height: 0,
            dpi: 0,
        };
        let config = Arc::new(WeztermConfig { scrollback_limit });
        let terminal = Terminal::new(size, config, "threadterm", "1.0", Box::new(io::sink()));
        Self {
            terminal,
            rows,
            cols,
        }
    }

    pub(super) fn apply_output(&mut self, bytes: &[u8]) {
        self.terminal.advance_bytes(bytes);
    }

    pub(super) fn resize(&mut self, rows: u16, cols: u16) {
        self.rows = rows;
        self.cols = cols;
        self.terminal.resize(TerminalSize {
            rows: rows as usize,
            cols: cols as usize,
            pixel_width: 0,
            pixel_height: 0,
            dpi: 0,
        });
    }

    pub(super) fn snapshot_ansi(&self) -> TerminalSnapshotPayload {
        let pos = self.terminal.cursor_pos();
        let cursor_row = if pos.y <= 0 {
            1
        } else {
            (pos.y as u64).saturating_add(1).min(u16::MAX as u64) as u16
        };
        let cursor_col = (pos.x as u64).saturating_add(1).min(u16::MAX as u64) as u16;
        let segments =
            serialize_screen_to_ansi_segments(self.terminal.screen(), cursor_row, cursor_col);

        TerminalSnapshotPayload {
            data: String::from_utf8_lossy(&segments.data).to_string(),
            rows: self.rows,
            cols: self.cols,
            cursor_row,
            cursor_col,
            history: segments
                .history
                .map(|history| String::from_utf8_lossy(&history).to_string()),
        }
    }
}

struct SnapshotSegments {
    history: Option<Vec<u8>>,
    data: Vec<u8>,
}

fn emit_sgr(output: &mut String, params: &[String]) {
    if params.is_empty() {
        return;
    }
    output.push_str("\x1b[");
    output.push_str(&params.join(";"));
    output.push('m');
}

fn push_color_params(params: &mut Vec<String>, color: ColorAttribute, is_fg: bool) {
    match color {
        ColorAttribute::Default => {
            params.push((if is_fg { 39 } else { 49 }).to_string());
        }
        ColorAttribute::PaletteIndex(idx) => {
            let idx = idx as u16;
            if idx < 8 {
                let base = if is_fg { 30 } else { 40 };
                params.push((base + idx).to_string());
            } else if idx < 16 {
                let base = if is_fg { 90 } else { 100 };
                params.push((base + (idx - 8)).to_string());
            } else {
                let base = if is_fg { 38 } else { 48 };
                params.push(format!("{base};5;{idx}"));
            }
        }
        ColorAttribute::TrueColorWithPaletteFallback(color, _)
        | ColorAttribute::TrueColorWithDefaultFallback(color) => {
            let (r, g, b, _) = color.as_rgba_u8();
            let base = if is_fg { 38 } else { 48 };
            params.push(format!("{base};2;{r};{g};{b}"));
        }
    }
}

fn emit_attr_delta(output: &mut String, current: &mut AttrState, next: AttrState) {
    if *current == next {
        return;
    }

    let mut params = Vec::new();
    if current.intensity != next.intensity {
        let code = match next.intensity {
            Intensity::Normal => 22,
            Intensity::Bold => 1,
            Intensity::Half => 2,
        };
        params.push(code.to_string());
    }
    if current.italic != next.italic {
        params.push(if next.italic { "3" } else { "23" }.to_string());
    }
    if current.underline != next.underline {
        let code = match next.underline {
            Underline::None => "24".to_string(),
            Underline::Single => "4".to_string(),
            Underline::Double => "4:2".to_string(),
            Underline::Curly => "4:3".to_string(),
            Underline::Dotted => "4:4".to_string(),
            Underline::Dashed => "4:5".to_string(),
        };
        params.push(code);
    }
    if current.blink != next.blink {
        let code = match next.blink {
            Blink::None => 25,
            Blink::Slow => 5,
            Blink::Rapid => 6,
        };
        params.push(code.to_string());
    }
    if current.reverse != next.reverse {
        params.push(if next.reverse { "7" } else { "27" }.to_string());
    }
    if current.strikethrough != next.strikethrough {
        params.push(if next.strikethrough { "9" } else { "29" }.to_string());
    }
    if current.invisible != next.invisible {
        params.push(if next.invisible { "8" } else { "28" }.to_string());
    }
    if current.overline != next.overline {
        params.push(if next.overline { "53" } else { "55" }.to_string());
    }
    if current.fg != next.fg {
        push_color_params(&mut params, next.fg, true);
    }
    if current.bg != next.bg {
        push_color_params(&mut params, next.bg, false);
    }
    emit_sgr(output, &params);
    *current = next;
}

fn serialize_line_to_ansi(
    line: &wezterm_term::Line,
    output: &mut String,
    state: &mut AttrState,
    blank_attrs: &CellAttributes,
) {
    let cells: Vec<_> = line.visible_cells().collect();
    let mut last_col = 0usize;
    for cell in &cells {
        let is_blank = cell.str() == " " && cell.attrs() == blank_attrs;
        if !is_blank {
            last_col = cell.cell_index() + cell.width();
        }
    }

    let mut col = 0usize;
    for cell in cells {
        if cell.cell_index() >= last_col {
            break;
        }
        let target = cell.cell_index();
        if target > col {
            let gap_state = AttrState::from_attrs(blank_attrs);
            emit_attr_delta(output, state, gap_state);
            for _ in 0..target.saturating_sub(col) {
                output.push(' ');
            }
        }
        let next_state = AttrState::from_attrs(cell.attrs());
        emit_attr_delta(output, state, next_state);
        output.push_str(cell.str());
        col = target.saturating_add(cell.width());
    }

    if *state != AttrState::default() {
        output.push_str("\x1b[0m");
        *state = AttrState::default();
    }
}

fn serialize_lines_to_ansi(
    lines: &[wezterm_term::Line],
    state: &mut AttrState,
    blank_attrs: &CellAttributes,
    trailing_newline: bool,
) -> String {
    let mut output = String::new();
    for (index, line) in lines.iter().enumerate() {
        if index > 0 {
            output.push_str("\r\n");
        }
        serialize_line_to_ansi(line, &mut output, state, blank_attrs);
    }
    if trailing_newline && !lines.is_empty() {
        output.push_str("\r\n");
    }
    output
}

fn line_has_content(line: &wezterm_term::Line, blank_attrs: &CellAttributes) -> bool {
    line.visible_cells()
        .any(|cell| cell.str() != " " || cell.attrs() != blank_attrs)
}

fn serialize_screen_to_ansi_segments(
    screen: &wezterm_term::Screen,
    cursor_row: u16,
    cursor_col: u16,
) -> SnapshotSegments {
    let total_rows = screen.scrollback_rows();
    if total_rows == 0 {
        return SnapshotSegments {
            history: None,
            data: format!("\x1b[{cursor_row};{cursor_col}H").into_bytes(),
        };
    }

    let visible_rows = screen.physical_rows.max(1);
    let history_rows = total_rows.saturating_sub(visible_rows);
    let blank_attrs = CellAttributes::blank();
    let mut state = AttrState::default();

    let history = if history_rows > 0 {
        let lines = screen.lines_in_phys_range(0..history_rows);
        let output = serialize_lines_to_ansi(&lines, &mut state, &blank_attrs, true);
        if output.is_empty() {
            None
        } else {
            Some(output.into_bytes())
        }
    } else {
        None
    };

    let lines = screen.lines_in_phys_range(history_rows..total_rows);
    let mut last_content = None;
    for (index, line) in lines.iter().enumerate() {
        if line_has_content(line, &blank_attrs) {
            last_content = Some(index);
        }
    }

    let mut output = String::new();
    let end = last_content.map(|index| index + 1).unwrap_or(0);
    if end > 0 {
        let padded_end = end.max(lines.len());
        output.push_str(&serialize_lines_to_ansi(
            &lines[..padded_end],
            &mut state,
            &blank_attrs,
            false,
        ));
    }
    if state != AttrState::default() {
        output.push_str("\x1b[0m");
    }
    output.push_str(&format!("\x1b[{cursor_row};{cursor_col}H"));

    SnapshotSegments {
        history,
        data: output.into_bytes(),
    }
}

#[cfg(test)]
mod tests {
    use super::{is_visually_empty_payload, TerminalSnapshot, TerminalSnapshotPayload};

    #[test]
    fn payload_visually_empty_when_only_cursor_positioning() {
        let snapshot = TerminalSnapshot::new(24, 80, 2000);
        let payload = snapshot.snapshot_ansi();

        assert!(is_visually_empty_payload(&payload));
    }

    #[test]
    fn payload_visually_empty_when_only_control_bytes_applied() {
        // Control sequences that toggle cursor visibility leave no visible
        // cells; the payload should still be classified as empty.
        let mut snapshot = TerminalSnapshot::new(24, 80, 2000);
        snapshot.apply_output(b"\x1b[?25l\x1b[?25h");

        let payload = snapshot.snapshot_ansi();

        assert!(is_visually_empty_payload(&payload));
    }

    #[test]
    fn payload_not_visually_empty_when_data_has_text() {
        let mut snapshot = TerminalSnapshot::new(24, 80, 2000);
        snapshot.apply_output(b"hello");

        let payload = snapshot.snapshot_ansi();

        assert!(!is_visually_empty_payload(&payload));
    }

    #[test]
    fn payload_not_visually_empty_when_history_has_text() {
        let payload = TerminalSnapshotPayload {
            data: "\x1b[1;1H".to_string(),
            rows: 24,
            cols: 80,
            cursor_row: 1,
            cursor_col: 1,
            history: Some("scrollback line\r\n".to_string()),
        };

        assert!(!is_visually_empty_payload(&payload));
    }

    #[test]
    fn snapshot_contains_visible_output_and_cursor_position() {
        let mut snapshot = TerminalSnapshot::new(24, 80, 2000);
        snapshot.apply_output(b"hello\r\nworld");

        let payload = snapshot.snapshot_ansi();

        assert!(payload.data.contains("hello"));
        assert!(payload.data.contains("world"));
        assert_eq!(payload.rows, 24);
        assert_eq!(payload.cols, 80);
        assert!(payload.cursor_row >= 1);
        assert!(payload.cursor_col >= 1);
    }

    #[test]
    fn resize_updates_snapshot_dimensions() {
        let mut snapshot = TerminalSnapshot::new(24, 80, 2000);
        snapshot.resize(40, 120);

        let payload = snapshot.snapshot_ansi();

        assert_eq!(payload.rows, 40);
        assert_eq!(payload.cols, 120);
    }

    #[test]
    fn clear_screen_snapshot_drops_old_visible_cells() {
        let mut snapshot = TerminalSnapshot::new(24, 80, 2000);
        snapshot.apply_output(b"old text\r\n\x1b[2J\x1b[Hnew text");

        let payload = snapshot.snapshot_ansi();

        assert!(!payload.data.contains("old text"));
        assert!(payload.data.contains("new text"));
    }

    #[test]
    fn carriage_return_redraw_snapshot_keeps_current_terminal_view() {
        let mut snapshot = TerminalSnapshot::new(24, 80, 2000);
        snapshot.apply_output(b"loading\r\x1b[Kloaded");

        let payload = snapshot.snapshot_ansi();

        assert!(!payload.data.contains("loading"));
        assert!(payload.data.contains("loaded"));
    }
}
