import Foundation

@Observable
final class OpenWorkAPIClient {
    var connection: ServerConnection?
}

enum APIError: LocalizedError {
    case notConnected
    case unauthorized
    case serverError(String)
    var errorDescription: String? { "Error" }
}
