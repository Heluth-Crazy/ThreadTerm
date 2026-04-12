import Foundation

/// A session record from the project's disk storage.
/// Embedded in `Project.sessions` from `GET /api/projects`.
struct Session: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let projectPath: String
    let provider: String
    let name: String?
    let createdAt: String?
    let lastMessage: String?
    let messageCount: UInt32

    enum CodingKeys: String, CodingKey {
        case id, provider, name
        case projectPath = "project_path"
        case createdAt = "created_at"
        case lastMessage = "last_message"
        case messageCount = "message_count"
    }
}
