import Foundation

@Observable
class ConnectionViewModel {
    typealias APIClientFactory = (ServerConnection) -> OpenWorkAPIClient

    struct ConnectionDraft: Equatable {
        var host = ""
        var port = "3002"
        var token = ""
        var name = ""
    }

    enum ConnectionState: Equatable {
        case disconnected
        case connecting
        case connected(OpenWorkAPIClient)
        case failed(String)

        static func == (lhs: ConnectionState, rhs: ConnectionState) -> Bool {
            switch (lhs, rhs) {
            case (.disconnected, .disconnected): return true
            case (.connecting, .connecting): return true
            case (.connected(let a), .connected(let b)): return a === b
            case (.failed(let a), .failed(let b)): return a == b
            default: return false
            }
        }
    }

    private(set) var state: ConnectionState = .disconnected
    var savedConnections: [ServerConnection] = []
    var connectionLog: [String] = []
    var draft = ConnectionDraft()
    /// Set after a successful connection to allow auto-dismiss in the view.
    var didJustConnect = false

    /// The sole owner of the APIClient — no other ViewModel creates its own.
    var currentAPIClient: OpenWorkAPIClient? {
        if case .connected(let client) = state { return client }
        return nil
    }

    private let clientFactory: APIClientFactory

    init(clientFactory: @escaping APIClientFactory = OpenWorkAPIClient.init) {
        self.clientFactory = clientFactory
        savedConnections = ConnectionStorage.loadConnections().map { connection in
            resolvedSavedConnection(connection)
        }
    }

    func connect(to connection: ServerConnection) async {
        await MainActor.run {
            self.populateDraft(from: connection)
        }

        let normalizedConnection: ServerConnection
        do {
            normalizedConnection = try normalize(connection)
        } catch {
            await MainActor.run {
                connectionLog.removeAll()
                didJustConnect = false
                state = .failed(error.localizedDescription)
            }
            await appendLog("✗ \(error.localizedDescription)")
            return
        }

        await MainActor.run {
            self.populateDraft(from: normalizedConnection)
            connectionLog.removeAll()
            didJustConnect = false
            state = .connecting
        }
        await appendLog("→ Connecting to \(normalizedConnection.host):\(normalizedConnection.port)...")
        do {
            let client = try await attemptConnection(normalizedConnection)
            await MainActor.run {
                state = .connected(client)
                didJustConnect = true
                TokenStorage.save(token: normalizedConnection.token, for: normalizedConnection.host, port: normalizedConnection.port)
                saveConnection(normalizedConnection)
            }
        } catch let error as APIError where error.errorDescription?.contains("Unauthorized") == true {
            await appendLog("✗ Unauthorized — check your API token")
            await MainActor.run { state = .failed(error.localizedDescription) }
        } catch {
            await appendLog("✗ \(error.localizedDescription)")
            await MainActor.run { state = .failed(error.localizedDescription) }
        }
    }

    func disconnect() {
        state = .disconnected
        didJustConnect = false
    }

    func draftConnection() -> ServerConnection {
        ServerConnection(
            name: draft.name.isEmpty ? draft.host : draft.name,
            host: draft.host,
            port: Int(draft.port) ?? 3002,
            token: draft.token
        )
    }

    func saveConnection(_ connection: ServerConnection) {
        let resolved = resolvedSavedConnection(connection)
        if let idx = savedConnections.firstIndex(where: { $0.id == resolved.id }) {
            savedConnections[idx] = resolved
        } else {
            savedConnections.append(resolved)
        }
        ConnectionStorage.saveConnections(savedConnections)
    }

    func deleteConnection(_ connection: ServerConnection) {
        savedConnections.removeAll { $0.id == connection.id }
        ConnectionStorage.saveConnections(savedConnections)
        TokenStorage.delete(for: connection.host, port: connection.port)
        if case .connected(let client) = state,
           client.connection.id == connection.id {
            disconnect()
        }
    }

    func resolvedSavedConnection(_ connection: ServerConnection) -> ServerConnection {
        var resolved = connection
        resolved.token = TokenStorage.load(for: connection.host, port: connection.port) ?? connection.token
        return resolved
    }

    @discardableResult
    func selectSavedConnection(_ connection: ServerConnection) -> ServerConnection {
        let resolved = resolvedSavedConnection(connection)
        populateDraft(from: resolved)
        return resolved
    }

    // MARK: - Private

    private func populateDraft(from connection: ServerConnection) {
        draft.host = connection.host
        draft.port = String(connection.port)
        draft.token = connection.token
        draft.name = connection.name
    }

    private func attemptConnection(_ connection: ServerConnection) async throws -> OpenWorkAPIClient {
        let client = clientFactory(connection)
        await appendLog("→ Sending health check...")
        let health = try await client.healthCheck()
        await appendLog("✓ Server reachable — \(health.app)")
        await appendLog("→ Validating API token...")
        try await client.validateAuthentication()
        await appendLog("✓ API token accepted")
        await appendLog("✓ Connected — \(health.app)")
        return client
    }

    private func normalize(_ connection: ServerConnection) throws -> ServerConnection {
        var normalized = connection
        normalized.name = connection.name.trimmingCharacters(in: .whitespacesAndNewlines)
        normalized.token = connection.token.trimmingCharacters(in: .whitespacesAndNewlines)
        normalized.host = try normalizeHost(connection.host, defaultPort: connection.port)

        guard !normalized.host.isEmpty else {
            throw APIError.serverError("Server host is required")
        }
        guard !normalized.token.isEmpty else {
            throw APIError.serverError("API token is required")
        }

        #if !targetEnvironment(simulator)
        if isLoopbackHost(normalized.host) {
            throw APIError.serverError(
                "localhost only works in Simulator. On iPhone, use your Mac's LAN IP, for example 192.168.x.x."
            )
        }
        #endif

        return normalized
    }

    private func normalizeHost(_ rawHost: String, defaultPort: Int) throws -> String {
        let trimmed = rawHost.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }

        if let url = URL(string: trimmed), let host = url.host {
            return host
        }

        if let url = URL(string: "http://\(trimmed)"), let host = url.host {
            if let pastedPort = url.port, pastedPort != defaultPort {
                throw APIError.serverError("Host already contains port \(pastedPort). Please keep the port field consistent.")
            }
            return host
        }

        return trimmed
            .replacingOccurrences(of: "http://", with: "")
            .replacingOccurrences(of: "https://", with: "")
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }

    private func isLoopbackHost(_ host: String) -> Bool {
        let value = host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return value == "localhost" || value == "127.0.0.1" || value == "::1"
    }

    @MainActor
    private func appendLog(_ message: String) {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        let ts = formatter.string(from: Date())
        connectionLog.append("[\(ts)] \(message)")
    }
}
