import Foundation

/// A session summary from `GET /api/session-history`.
/// Response is a bare JSON array `[SessionSummary]`.
struct SessionSummary: Codable, Identifiable, Hashable, Sendable {
    let sessionId: String
    let projectPath: String
    let provider: String
    let name: String?
    let messageCount: Int
    let lastMessage: String?
    let createdAt: String?

    var id: String { sessionId }

    enum CodingKeys: String, CodingKey {
        case provider, name
        case sessionId = "session_id"
        case projectPath = "project_path"
        case messageCount = "message_count"
        case lastMessage = "last_message"
        case createdAt = "created_at"
    }
}
