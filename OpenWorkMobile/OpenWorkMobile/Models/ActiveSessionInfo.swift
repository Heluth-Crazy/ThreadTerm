import Foundation

/// A live PTY session from `GET /api/sessions`.
/// Wrapped in `{"sessions": [ActiveSessionInfo]}`.
struct ActiveSessionInfo: Codable, Identifiable, Sendable {
    let id: String
    let state: String
    let provider: String?
    let projectPath: String?

    /// Provider defaults to "claude" when backend returns nil.
    var effectiveProvider: String { provider ?? "claude" }

    enum CodingKeys: String, CodingKey {
        case id, state, provider
        case projectPath = "project_path"
    }
}

struct ActiveSessionsResponse: Codable, Sendable {
    let sessions: [ActiveSessionInfo]
}
