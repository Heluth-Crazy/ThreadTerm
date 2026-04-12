import Foundation
struct ActiveSessionInfo: Codable, Identifiable {
    let id: String
    let state: String
}
struct ActiveSessionsResponse: Codable {
    let sessions: [ActiveSessionInfo]
}
