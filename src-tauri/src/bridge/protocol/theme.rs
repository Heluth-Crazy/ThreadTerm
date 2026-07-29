use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppThemeTokens {
    pub background: String,
    pub foreground: String,
    pub card: String,
    pub card_foreground: String,
    pub popover: String,
    pub popover_foreground: String,
    pub primary: String,
    pub primary_foreground: String,
    pub secondary: String,
    pub secondary_foreground: String,
    pub muted: String,
    pub muted_foreground: String,
    pub accent: String,
    pub accent_foreground: String,
    pub destructive: String,
    pub destructive_foreground: String,
    pub border: String,
    pub input: String,
    pub ring: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalThemeTokens {
    pub background: String,
    pub foreground: String,
    pub cursor: String,
    pub cursor_accent: String,
    pub selection: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection_foreground: Option<String>,
    pub black: String,
    pub red: String,
    pub green: String,
    pub yellow: String,
    pub blue: String,
    pub magenta: String,
    pub cyan: String,
    pub white: String,
    pub bright_black: String,
    pub bright_red: String,
    pub bright_green: String,
    pub bright_yellow: String,
    pub bright_blue: String,
    pub bright_magenta: String,
    pub bright_cyan: String,
    pub bright_white: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ThemeMode {
    Light,
    Dark,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BridgeTheme {
    pub app: AppThemeTokens,
    pub terminal: TerminalThemeTokens,
    pub mode: ThemeMode,
}

impl Default for BridgeTheme {
    fn default() -> Self {
        Self {
            mode: ThemeMode::Dark,
            app: AppThemeTokens {
                background: "#10151d".to_string(),
                foreground: "#e8edf5".to_string(),
                card: "#151b24".to_string(),
                card_foreground: "#e8edf5".to_string(),
                popover: "#151b24".to_string(),
                popover_foreground: "#e8edf5".to_string(),
                primary: "#4f8bd6".to_string(),
                primary_foreground: "#f8fafc".to_string(),
                secondary: "#263242".to_string(),
                secondary_foreground: "#e8edf5".to_string(),
                muted: "#202a38".to_string(),
                muted_foreground: "#9aa7b7".to_string(),
                accent: "#314154".to_string(),
                accent_foreground: "#e8edf5".to_string(),
                destructive: "#ef4444".to_string(),
                destructive_foreground: "#f8fafc".to_string(),
                border: "#2d3948".to_string(),
                input: "#263242".to_string(),
                ring: "#4f8bd6".to_string(),
            },
            terminal: TerminalThemeTokens {
                background: "#000000".to_string(),
                foreground: "#f8fafc".to_string(),
                cursor: "#f8fafc".to_string(),
                cursor_accent: "#000000".to_string(),
                selection: "#334155".to_string(),
                selection_foreground: Some("#f8fafc".to_string()),
                black: "#0f172a".to_string(),
                red: "#ef4444".to_string(),
                green: "#22c55e".to_string(),
                yellow: "#eab308".to_string(),
                blue: "#3b82f6".to_string(),
                magenta: "#d946ef".to_string(),
                cyan: "#06b6d4".to_string(),
                white: "#e2e8f0".to_string(),
                bright_black: "#475569".to_string(),
                bright_red: "#f87171".to_string(),
                bright_green: "#4ade80".to_string(),
                bright_yellow: "#facc15".to_string(),
                bright_blue: "#60a5fa".to_string(),
                bright_magenta: "#e879f9".to_string(),
                bright_cyan: "#22d3ee".to_string(),
                bright_white: "#f8fafc".to_string(),
            },
        }
    }
}
