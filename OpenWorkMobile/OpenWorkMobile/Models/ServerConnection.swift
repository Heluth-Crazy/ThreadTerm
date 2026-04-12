import Foundation
struct ServerConnection: Codable, Identifiable, Hashable {
    let id: UUID
    var host: String
    var port: Int
    var token: String
    var name: String
}
