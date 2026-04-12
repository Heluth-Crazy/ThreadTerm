import Foundation

/// A registered project from `GET /api/projects`.
/// Response is a bare JSON array `[Project]`, NOT wrapped.
struct Project: Codable, Identifiable, Hashable, Sendable {
    let name: String
    let path: String
    let fullPath: String
    let description: String?
    let sessions: [Session]
    let createdAt: String?
    let lastAccessed: String?
    let config: AnyCodableValue?

    var id: String { path }

    enum CodingKeys: String, CodingKey {
        case name, path, description, sessions, config
        case fullPath = "full_path"
        case createdAt = "created_at"
        case lastAccessed = "last_accessed"
    }
}
