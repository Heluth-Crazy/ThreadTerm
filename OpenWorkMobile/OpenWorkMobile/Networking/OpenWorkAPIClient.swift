import Foundation

// MARK: - Error Types

enum APIError: Error, LocalizedError {
    case unauthorized
    case serverError(String)
    case decodingError(Error)
    case networkError(Error)

    var errorDescription: String? {
        switch self {
        case .unauthorized:
            return "Unauthorized – invalid or expired token"
        case .serverError(let msg):
            return msg
        case .decodingError(let err):
            return "Decoding error: \(err.localizedDescription)"
        case .networkError(let err):
            return "Network error: \(err.localizedDescription)"
        }
    }
}

// MARK: - Response Wrappers

struct APIResponse<T: Decodable>: Decodable {
    let ok: Bool
    let data: T?
    let error: String?
}

struct SessionsWrapper: Decodable {
    let sessions: [ActiveSessionInfo]
}

struct PTYCreateData: Decodable {
    let id: String
}

// MARK: - API Client

@Observable
class OpenWorkAPIClient {
    let connection: ServerConnection
    private let session: URLSession

    var baseURL: String { "http://\(connection.host):\(connection.port)" }
    var wsBaseURL: String { "ws://\(connection.host):\(connection.port)" }

    init(connection: ServerConnection) {
        self.connection = connection
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 15
        self.session = URLSession(configuration: config)
    }

    // MARK: - Health

    func healthCheck() async throws -> HealthResponse {
        let request = makeRequest("/api/health")
        let (data, response) = try await session.data(for: request)
        try checkResponse(response)
        return try decode(HealthResponse.self, from: data)
    }

    // MARK: - Projects

    func fetchProjects() async throws -> [Project] {
        return try await fetchData("/api/projects")
    }

    func fetchProjectSessions(projectPath: String) async throws -> [Session] {
        var components = URLComponents(string: "\(baseURL)/api/sessions/project")!
        components.queryItems = [
            URLQueryItem(name: "project_path", value: projectPath),
        ]
        let request = makeRequest(url: components.url!)
        let (data, response) = try await session.data(for: request)
        try checkResponse(response)
        return try decode([Session].self, from: data)
    }

    // MARK: - Active Sessions

    func fetchActiveSessions() async throws -> [ActiveSessionInfo] {
        let wrapper: SessionsWrapper = try await fetchData("/api/sessions")
        return wrapper.sessions
    }

    // MARK: - Session History

    func fetchSessionHistory(
        projectPath: String,
        sessionId: String,
        provider: String
    ) async throws -> [SessionMessage] {
        var components = URLComponents(string: "\(baseURL)/api/session_history")!
        components.queryItems = [
            URLQueryItem(name: "project_path", value: projectPath),
            URLQueryItem(name: "session_id", value: sessionId),
            URLQueryItem(name: "provider", value: provider),
        ]
        let request = makeRequest(url: components.url!)
        let (data, response) = try await session.data(for: request)
        try checkResponse(response)
        return try decode([SessionMessage].self, from: data)
    }

    // MARK: - Commands

    func discoverCommands() async throws -> [DiscoveredCommand] {
        let request = makeRequest("/api/commands/discover")
        let (data, response) = try await session.data(for: request)
        try checkResponse(response)
        let result = try decode(CommandDiscoveryResponse.self, from: data)
        guard result.ok, let discovery = result.data else {
            throw APIError.serverError(result.error ?? "Command discovery failed")
        }
        return discovery.commands
    }

    // MARK: - PTY Management

    func createPTYSession(projectPath: String, provider: String) async throws -> String {
        let body = try JSONSerialization.data(withJSONObject: [
            "project_path": projectPath,
            "provider": provider,
        ])
        let request = makeRequest("/api/pty/create", method: "POST", body: body)
        let (data, response) = try await session.data(for: request)
        try checkResponse(response)
        let apiResp = try decode(APIResponse<PTYCreateData>.self, from: data)
        guard apiResp.ok, let ptyData = apiResp.data else {
            throw APIError.serverError(apiResp.error ?? "Failed to create PTY session")
        }
        return ptyData.id
    }

    func startPTYSession(id: String) async throws {
        let request = makeRequest("/api/pty/\(id)/start", method: "POST")
        let (data, response) = try await session.data(for: request)
        try checkResponse(response)
        let result = try decode(OkResponse.self, from: data)
        guard result.ok else {
            throw APIError.serverError(result.error ?? "Failed to start PTY session")
        }
    }

    func deletePTYSession(id: String) async throws {
        let request = makeRequest("/api/pty/\(id)", method: "DELETE")
        let (data, response) = try await session.data(for: request)
        try checkResponse(response)
        let result = try decode(OkResponse.self, from: data)
        guard result.ok else {
            throw APIError.serverError(result.error ?? "Failed to delete PTY session")
        }
    }

    // MARK: - Private Helpers

    private func makeRequest(
        _ path: String,
        method: String = "GET",
        body: Data? = nil
    ) -> URLRequest {
        let urlString = "\(baseURL)\(path)"
        var request = URLRequest(url: URL(string: urlString)!)
        request.httpMethod = method
        request.setValue("Bearer \(connection.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        return request
    }

    private func makeRequest(
        url: URL,
        method: String = "GET",
        body: Data? = nil
    ) -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(connection.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        return request
    }

    private func fetchData<T: Decodable>(_ path: String) async throws -> T {
        let request = makeRequest(path)
        let (data, response) = try await session.data(for: request)
        try checkResponse(response)
        // Try to unwrap from APIResponse<T> envelope
        if let apiResp = try? JSONDecoder().decode(APIResponse<T>.self, from: data) {
            guard apiResp.ok else {
                throw APIError.serverError(apiResp.error ?? "Server error")
            }
            if let result = apiResp.data {
                return result
            }
        }
        // Fall back to direct decode
        return try decode(T.self, from: data)
    }

    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError.decodingError(error)
        }
    }

    private func checkResponse(_ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse else { return }
        if http.statusCode == 401 {
            throw APIError.unauthorized
        }
        if http.statusCode >= 400 {
            throw APIError.serverError("Server returned status \(http.statusCode)")
        }
    }

    private struct OkResponse: Decodable {
        let ok: Bool
        let error: String?
    }
}
