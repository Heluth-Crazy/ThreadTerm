import Foundation

struct HealthResponse: Codable, Sendable {
    let status: String
    let app: String
    let lanUrl: String
}

struct LocalIPResponse: Codable, Sendable {
    let ip: String
    let url: String
}

struct TokenInfoResponse: Codable, Sendable {
    let hint: String
}
