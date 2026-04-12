import Foundation

@Observable
class ConnectionViewModel {
    enum ConnectionState {
        case disconnected
        case connecting
        case connected(OpenWorkAPIClient)
        case failed(String)
    }

    private(set) var state: ConnectionState = .disconnected
    var savedConnections: [ServerConnection] = []

    /// The sole owner of the APIClient — no other ViewModel creates its own.
    var currentAPIClient: OpenWorkAPIClient? {
        if case .connected(let client) = state { return client }
        return nil
    }

    init() {
        savedConnections = ConnectionStorage.loadConnections()
    }

    func connect(to connection: ServerConnection) async {
        await MainActor.run { state = .connecting }
        do {
            let client = try await attemptConnection(connection)
            await MainActor.run {
                state = .connected(client)
                TokenStorage.save(token: connection.token, for: connection.host)
                saveConnection(connection)
            }
        } catch {
            await MainActor.run { state = .failed(error.localizedDescription) }
        }
    }

    func disconnect() {
        state = .disconnected
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
        TokenStorage.delete(for: connection.host)
        if case .connected(let client) = state,
           client.connection.id == connection.id {
            disconnect()
        }
    }

    private func attemptConnection(_ connection: ServerConnection) async throws -> OpenWorkAPIClient {
        let client = OpenWorkAPIClient(connection: connection)
        _ = try await client.healthCheck()
        return client
    }
}
