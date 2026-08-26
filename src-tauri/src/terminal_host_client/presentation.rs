use terminal_host_protocol::{DesktopRegisterRequest, Placement, SURFACE_PRESENTATION_V1};

/// Advertises every presentation the desktop can render: dedicated windows and
/// runtime-only workspace cards hosted inside the main window.
pub(crate) fn desktop_registration() -> DesktopRegisterRequest {
    DesktopRegisterRequest {
        surface_protocol_version: SURFACE_PRESENTATION_V1.to_owned(),
        placements: vec![Placement::Window, Placement::Workspace],
        background_presentation: true,
    }
}
