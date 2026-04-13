import Foundation

@Observable
class ConnectionViewModel {
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
    /// Set after a successful connection to allow auto-dismiss in the view.
    var didJustConnect = false

    /// The sole owner of the APIClient — no other ViewModel creates its own.
    var currentAPIClient: OpenWorkAPIClient? {
        if case .connected(let client) = state { return client }
        return nil
    }

    init() {
        savedConnections = ConnectionStorage.loadConnections()
    }

    func connect(to connection: ServerConnection) async {
        await MainActor.run {
            connectionLog.removeAll()
            didJustConnect = false
            state = .connecting
        }
        await appendLog("→ Connecting to \(connection.host):\(connection.port)...")
        do {
            let client = try await attemptConnection(connection)
            await MainActor.run {
                state = .connected(client)
                didJustConnect = true
                TokenStorage.save(token: connection.token, for: connection.host, port: connection.port)
                saveConnection(connection)
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

    func saveConnection(_ connection: ServerConnection) {
        if let idx = savedConnections.firstIndex(where: { $0.id == connection.id }) {
            savedConnections[idx] = connection
        } else {
            savedConnections.append(connection)
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

    // MARK: - Private

    private func attemptConnection(_ connection: ServerConnection) async throws -> OpenWorkAPIClient {
        let client = OpenWorkAPIClient(connection: connection)
        await appendLog("→ Sending health check...")
        let health = try await client.healthCheck()
        await appendLog("✓ Connected — \(health.app)")
        return client
    }

    @MainActor
    private func appendLog(_ message: String) {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        let ts = formatter.string(from: Date())
        connectionLog.append("[\(ts)] \(message)")
    }
}
