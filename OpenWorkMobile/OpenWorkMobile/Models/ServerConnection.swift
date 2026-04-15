import Foundation

/// Client-side model for a saved server connection.
/// Stored in Keychain. Not sent to/from the backend.
struct ServerConnection: Codable, Identifiable, Hashable, Sendable {
    let id: UUID
    var name: String
    var host: String
    var port: Int
    var token: String

    private enum CodingKeys: String, CodingKey {
        case id
        case name
        case host
        case port
    }

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

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(UUID.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        host = try container.decode(String.self, forKey: .host)
        port = try container.decode(Int.self, forKey: .port)
        token = ""
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(name, forKey: .name)
        try container.encode(host, forKey: .host)
        try container.encode(port, forKey: .port)
    }
}
