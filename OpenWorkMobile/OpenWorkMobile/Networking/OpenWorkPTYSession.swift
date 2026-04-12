import Foundation

@Observable
final class OpenWorkPTYSession {
    let ptyId: String
    init(ptyId: String, connection: ServerConnection) {
        self.ptyId = ptyId
    }
}
