import Foundation

/// Navigation wrapper that distinguishes active PTY sessions from history sessions.
/// Active sessions attach directly to an existing PTY WebSocket;
/// history sessions create a new PTY via POST /api/sessions.
struct SessionDestination: Hashable {
    let session: Session
    let isActive: Bool
}
