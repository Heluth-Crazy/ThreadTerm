import Foundation
struct HealthResponse: Codable {
    let status: String
}
struct LocalIPResponse: Codable {
    let ip: String
}
struct TokenInfoResponse: Codable {
    let hint: String
}
