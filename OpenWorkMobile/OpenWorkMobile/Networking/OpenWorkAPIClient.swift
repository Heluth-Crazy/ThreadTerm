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

/// Used for endpoints returning { ok: true, ptyId?: "..." }
struct OkResponse: Decodable {
    let ok: Bool
    let error: String?
    let ptyId: String?
}

/// GET /api/sessions → { sessions: [...] }
private struct SessionsWrapper: Decodable {
    let sessions: [ActiveSessionInfo]
}

/// GET /api/commands/discover → { commands: [...] }
private struct CommandsWrapper: Decodable {
    let commands: [DiscoveredCommand]
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
        let request = makeRequest("/health")
        let (data, response) = try await session.data(for: request)
        try checkResponse(response)
        return try decode(HealthResponse.self, from: data)
    }

    /// Uses an authenticated endpoint so invalid tokens fail before the app
    /// transitions into the connected navigation state.
    func validateAuthentication() async throws {
        _ = try await fetchProjects()
    }

    // MARK: - Projects (direct array response)

    func fetchProjects() async throws -> [Project] {
        let request = makeRequest("/api/projects")
        let (data, response) = try await session.data(for: request)
        try checkResponse(response)
        return try decode([Project].self, from: data)
    }

    // MARK: - Active Sessions

    func fetchActiveSessions() async throws -> [ActiveSessionInfo] {
        let request = makeRequest("/api/sessions")
        let (data, response) = try await session.data(for: request)
        try checkResponse(response)
        let wrapper = try decode(SessionsWrapper.self, from: data)
        return wrapper.sessions
    }

    // MARK: - Session Lifecycle

    /// POST /api/sessions — creates AND starts a PTY session. Returns the ptyId.
    func createAndStartSession(
        projectPath: String,
        provider: String,
        resumeSessionId: String? = nil
    ) async throws -> String {
        var body: [String: Any] = [
            "project_path": projectPath,
            "provider": provider,
        ]
        if let resumeId = resumeSessionId {
            body["resume_session_id"] = resumeId
        }
        let bodyData = try JSONSerialization.data(withJSONObject: body)
        let request = makeRequest("/api/sessions", method: "POST", body: bodyData)
        let (data, response) = try await session.data(for: request)
        try checkResponse(response)
        let result = try decode(OkResponse.self, from: data)
        guard result.ok, let ptyId = result.ptyId else {
            throw APIError.serverError(result.error ?? "Failed to create session")
        }
        return ptyId
    }

    /// POST /api/sessions/{ptyId}/send — sends text input to a running PTY session.
    func sendToSession(ptyId: String, text: String) async throws {
        let body = try JSONSerialization.data(withJSONObject: ["text": text])
        let request = makeRequest("/api/sessions/\(ptyId)/send", method: "POST", body: body)
        let (data, response) = try await session.data(for: request)
        try checkResponse(response)
        let result = try decode(OkResponse.self, from: data)
        guard result.ok else {
            throw APIError.serverError(result.error ?? "Failed to send to session")
        }
    }

    /// POST /api/sessions/{ptyId}/kill — kills a running PTY session.
    func killSession(ptyId: String) async throws {
        let request = makeRequest("/api/sessions/\(ptyId)/kill", method: "POST")
        let (data, response) = try await session.data(for: request)
        try checkResponse(response)
        let result = try decode(OkResponse.self, from: data)
        guard result.ok else {
            throw APIError.serverError(result.error ?? "Failed to kill session")
        }
    }

    /// Returns the PTY WebSocket URL for a given ptyId.
    func ptyWebSocketURL(ptyId: String) -> URL {
        URL(string: "\(wsBaseURL)/pty/ws?id=\(ptyId)&token=\(connection.token)")!
    }

    // MARK: - Session History

    /// GET /api/session-history?project_path=&provider= — returns direct array.
    func fetchSessionSummaries(
        projectPath: String,
        provider: String = "claude",
        limit: Int? = nil,
        offset: Int? = nil
    ) async throws -> [SessionSummary] {
        var components = URLComponents(string: "\(baseURL)/api/session-history")!
        var items = [
            URLQueryItem(name: "project_path", value: projectPath),
            URLQueryItem(name: "provider", value: provider),
        ]
        if let limit { items.append(URLQueryItem(name: "limit", value: "\(limit)")) }
        if let offset { items.append(URLQueryItem(name: "offset", value: "\(offset)")) }
        components.queryItems = items
        let request = makeRequest(url: components.url!)
        let (data, response) = try await session.data(for: request)
        try checkResponse(response)
        return try decode([SessionSummary].self, from: data)
    }

    /// GET /api/session-history/{sessionId}/messages — returns direct array.
    func fetchSessionMessages(
        sessionId: String,
        projectPath: String,
        provider: String = "claude"
    ) async throws -> [SessionMessage] {
        var components = URLComponents(string: "\(baseURL)/api/session-history/\(sessionId)/messages")!
        components.queryItems = [
            URLQueryItem(name: "project_path", value: projectPath),
            URLQueryItem(name: "provider", value: provider),
        ]
        let request = makeRequest(url: components.url!)
        let (data, response) = try await session.data(for: request)
        try checkResponse(response)
        return try decode([SessionMessage].self, from: data)
    }

    // MARK: - Commands

    /// GET /api/commands/discover → { commands: [...] }
    func discoverCommands() async throws -> [DiscoveredCommand] {
        let request = makeRequest("/api/commands/discover")
        let (data, response) = try await session.data(for: request)
        try checkResponse(response)
        let wrapper = try decode(CommandsWrapper.self, from: data)
        return wrapper.commands
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
}
