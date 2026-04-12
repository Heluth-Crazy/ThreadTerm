import Foundation

/// Client-side model for a saved server connection.
/// Stored in Keychain. Not sent to/from the backend.
struct ServerConnection: Codable, Identifiable, Hashable, Sendable {
    let id: UUID
    var name: String
    var host: String
    var port: Int
    var token: String

    var baseURL: URL {
        URL(string: "http://\(host):\(port)")!
    }

    var wsBaseURL: URL {
        URL(string: "ws://\(host):\(port)")!
    }

    init(name: String = "", host: String, port: Int = 3002, token: String = "") {
        self.id = UUID()
        self.name = name
        self.host = host
        self.port = port
        self.token = token
    }
}
