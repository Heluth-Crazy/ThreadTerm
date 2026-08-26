use std::{io, sync::Arc};

use wezterm_term::{
    color::ColorPalette, CellAttributes, Terminal, TerminalConfiguration, TerminalSize,
};

#[derive(Debug)]
struct EmulatorConfig {
    scrollback_lines: usize,
}

impl TerminalConfiguration for EmulatorConfig {
    fn scrollback_size(&self) -> usize {
        self.scrollback_lines
    }

    fn color_palette(&self) -> ColorPalette {
        ColorPalette::default()
    }
}

pub(crate) struct CanonicalEmulator {
    terminal: Terminal,
    rows: u16,
    cols: u16,
}

pub(crate) struct CanonicalSnapshot {
    pub(crate) content: Vec<u8>,
    pub(crate) cursor_row: u16,
    pub(crate) cursor_col: u16,
}

impl CanonicalEmulator {
    pub(crate) fn new(rows: u16, cols: u16, scrollback_lines: usize) -> Self {
        let terminal = Terminal::new(
            terminal_size(rows, cols),
            Arc::new(EmulatorConfig { scrollback_lines }),
            "threadterm-daemon",
            env!("CARGO_PKG_VERSION"),
            Box::new(io::sink()),
        );
        Self {
            terminal,
            rows,
            cols,
        }
    }

    pub(crate) fn advance(&mut self, bytes: &[u8]) {
        self.terminal.advance_bytes(bytes);
    }

    pub(crate) fn resize(&mut self, rows: u16, cols: u16) {
        self.rows = rows;
        self.cols = cols;
        self.terminal.resize(terminal_size(rows, cols));
    }

    /// Produces a renderer-ready canonical view, not a transcript.  In
    /// particular, wezterm has already applied erases, cursor movement and
    /// alternate-screen transitions before this method observes the cells.
    pub(crate) fn snapshot(&self) -> CanonicalSnapshot {
        let screen = self.terminal.screen();
        let row_count = screen.scrollback_rows();
        let lines = screen.lines_in_phys_range(0..row_count);
        let blank = CellAttributes::blank();
        let mut bytes = Vec::with_capacity(row_count.saturating_mul(self.cols as usize + 2));
        bytes.extend_from_slice(b"\x1b[2J\x1b[H");
        for (row, line) in lines.iter().enumerate() {
            let cells: Vec<_> = line.visible_cells().collect();
            let end = cells
                .iter()
                .rposition(|cell| cell.str() != " " || cell.attrs() != &blank)
                .map(|index| index + 1)
                .unwrap_or(0);
            for cell in cells.into_iter().take(end) {
                bytes.extend_from_slice(cell.str().as_bytes());
            }
            if row + 1 < lines.len() {
                bytes.extend_from_slice(b"\r\n");
            }
        }
        let cursor = self.terminal.cursor_pos();
        let row = cursor.y.max(0).saturating_add(1);
        let col = cursor.x.saturating_add(1);
        bytes.extend_from_slice(format!("\x1b[{row};{col}H").as_bytes());
        CanonicalSnapshot {
            content: bytes,
            cursor_row: u16::try_from(row).unwrap_or(u16::MAX),
            cursor_col: u16::try_from(col).unwrap_or(u16::MAX),
        }
    }
}

fn terminal_size(rows: u16, cols: u16) -> TerminalSize {
    TerminalSize {
        rows: rows as usize,
        cols: cols as usize,
        pixel_width: 0,
        pixel_height: 0,
        dpi: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::CanonicalEmulator;

    #[test]
    fn snapshot_reflects_ansi_and_alternate_screen_state() {
        let mut emulator = CanonicalEmulator::new(4, 20, 3_000);
        emulator.advance(b"old\r\n\x1b[31mred\x1b[0m");
        assert!(String::from_utf8_lossy(&emulator.snapshot().content).contains("red"));
        emulator.advance(b"\x1b[?1049hALT\x1b[?1049l");
        let snapshot = String::from_utf8_lossy(&emulator.snapshot().content).into_owned();
        assert!(snapshot.contains("old"));
        assert!(!snapshot.contains("ALT"));
    }

    #[test]
    fn snapshot_retains_three_thousand_lines() {
        let mut emulator = CanonicalEmulator::new(10, 32, 3_000);
        for line in 0..3_000 {
            emulator.advance(format!("line-{line:04}\r\n").as_bytes());
        }
        let snapshot = String::from_utf8_lossy(&emulator.snapshot().content).into_owned();
        assert!(snapshot.contains("line-0001"));
        assert!(snapshot.contains("line-2999"));
    }
}
