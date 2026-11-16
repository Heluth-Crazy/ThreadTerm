//! Whether Windows would show a notification now (`system.notificationState`).
//!
//! The desktop's task island hides while a full-screen app, a game or a presentation runs. Electron cannot see other
//! programs' windows, so the runtime asks the shell. Read-only and local to this PC.

/// The shell's answer as a protocol word; `unknown` off Windows or when the call fails.
pub fn notification_state() -> &'static str {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::Shell::{
            SHQueryUserNotificationState, QUNS_ACCEPTS_NOTIFICATIONS, QUNS_APP, QUNS_BUSY, QUNS_NOT_PRESENT,
            QUNS_PRESENTATION_MODE, QUNS_QUIET_TIME, QUNS_RUNNING_D3D_FULL_SCREEN,
        };
        let mut state = 0;
        // SAFETY: the only argument is a valid pointer to a local the call writes once.
        if unsafe { SHQueryUserNotificationState(&mut state) } < 0 {
            return "unknown";
        }
        word(state, [QUNS_NOT_PRESENT, QUNS_BUSY, QUNS_RUNNING_D3D_FULL_SCREEN, QUNS_PRESENTATION_MODE, QUNS_ACCEPTS_NOTIFICATIONS, QUNS_QUIET_TIME, QUNS_APP])
    }
    #[cfg(not(windows))]
    {
        "unknown"
    }
}

/// `codes` lists the shell's values in the order of `WORDS`.
#[cfg_attr(not(windows), allow(dead_code))]
fn word(state: i32, codes: [i32; 7]) -> &'static str {
    const WORDS: [&str; 7] = ["notPresent", "busy", "fullscreen", "presentation", "available", "quietTime", "app"];
    codes.iter().position(|code| *code == state).map_or("unknown", |index| WORDS[index])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_every_shell_state_and_rejects_others() {
        let codes = [1, 2, 3, 4, 5, 6, 7];
        assert_eq!(word(2, codes), "busy");
        assert_eq!(word(3, codes), "fullscreen");
        assert_eq!(word(4, codes), "presentation");
        assert_eq!(word(5, codes), "available");
        assert_eq!(word(9, codes), "unknown");
        let live = notification_state();
        assert!(["notPresent", "busy", "fullscreen", "presentation", "available", "quietTime", "app", "unknown"].contains(&live), "{live}");
    }
}
