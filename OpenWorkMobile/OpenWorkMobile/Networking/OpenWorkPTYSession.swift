import Foundation

// DEPRECATED — not used. PTY sessions are managed via OpenWorkAPIClient.
@Observable
final class OpenWorkPTYSession {
    let ptyId: String
    init(ptyId: String, connection: ServerConnection) {
        self.ptyId = ptyId
    }
}
