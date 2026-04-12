import Foundation
struct SessionSummary: Codable, Identifiable {
    let sessionId: String
    var id: String { sessionId }
}
