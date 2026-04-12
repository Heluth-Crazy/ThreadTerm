import Foundation

/// Manages a single WebSocket connection to `/ws?token=<token>` for chat messages.
@Observable
class ChatWebSocketClient: NSObject, @unchecked Sendable {
    enum State {
        case disconnected
        case connecting
        case connected
        case failed(Error)
    }

    private(set) var state: State = .disconnected
    private var task: URLSessionWebSocketTask?
    private let connection: ServerConnection

    // Callbacks for received messages
    var onChatResponse: ((String, String, Bool) -> Void)?  // (sessionId, content, done)
    var onChatError: ((String, String) -> Void)?            // (sessionId, error)
    var onPermissionRequest: ((String, String, String) -> Void)? // (sessionId, type, prompt)

    init(connection: ServerConnection) {
        self.connection = connection
        super.init()
    }

    func connect() {
        guard task == nil else { return }
        state = .connecting

        let urlString = "ws://\(connection.host):\(connection.port)/ws?token=\(connection.token)"
        guard let url = URL(string: urlString) else {
            state = .failed(URLError(.badURL))
            return
        }

        let session = URLSession(configuration: .default)
        task = session.webSocketTask(with: url)
        task?.resume()
        receiveLoop()
    }

    func disconnect() {
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
        state = .disconnected
    }

    func sendMessage(
        sessionId: String,
        projectPath: String,
        message: String,
        provider: String
    ) async throws {
        let payload: [String: Any] = [
            "type": "claude-command",
            "session_id": sessionId,
            "project_path": projectPath,
            "message": message,
            "provider": provider,
        ]
        try await sendJSON(payload)
    }

    func abortSession(sessionId: String) async throws {
        let payload: [String: Any] = [
            "type": "abort-session",
            "session_id": sessionId,
        ]
        try await sendJSON(payload)
    }

    func respondToPermission(sessionId: String, allow: Bool) async throws {
        let payload: [String: Any] = [
            "type": "permission-response",
            "session_id": sessionId,
            "allow": allow,
        ]
        try await sendJSON(payload)
    }

    // MARK: - Private

    private func sendJSON(_ dict: [String: Any]) async throws {
        guard let task = task else {
            throw APIError.networkError(URLError(.notConnectedToInternet))
        }
        let data = try JSONSerialization.data(withJSONObject: dict)
        guard let string = String(data: data, encoding: .utf8) else { return }
        try await task.send(.string(string))
    }

    private func receiveLoop() {
        Task { [weak self] in
            while let self = self, let ws = self.task {
                do {
                    let message = try await ws.receive()
                    switch message {
                    case .string(let text):
                        if let data = text.data(using: .utf8) {
                            self.parseMessage(data)
                        }
                    case .data(let data):
                        self.parseMessage(data)
                    @unknown default:
                        break
                    }
                } catch {
                    await MainActor.run {
                        self.state = .failed(error)
                    }
                    break
                }
            }
        }
    }

    private func parseMessage(_ data: Data) {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else { return }

        Task { @MainActor [weak self] in
            guard let self = self else { return }

            // Mark as connected on first message received
            if case .connecting = self.state {
                self.state = .connected
            }

            switch type {
            case "claude-response", "codex-response":
                let sessionId = json["session_id"] as? String ?? ""
                let content = json["content"] as? String ?? ""
                let done = json["done"] as? Bool ?? false
                self.onChatResponse?(sessionId, content, done)

            case "claude-error", "codex-error":
                let sessionId = json["session_id"] as? String ?? ""
                let error = json["error"] as? String ?? "Unknown error"
                self.onChatError?(sessionId, error)

            case "claude-permission-request":
                let sessionId = json["session_id"] as? String ?? ""
                let permType = json["permission_type"] as? String ?? ""
                let prompt = json["prompt"] as? String ?? ""
                self.onPermissionRequest?(sessionId, permType, prompt)

            default:
                break
            }
        }
    }
}
