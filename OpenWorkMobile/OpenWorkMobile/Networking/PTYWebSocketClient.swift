import Foundation

/// Manages a single PTY WebSocket connection to `/api/pty/{id}/ws?token=<token>`.
@Observable
class PTYWebSocketClient: NSObject, @unchecked Sendable {
    enum State {
        case disconnected
        case connecting
        case connected
        case failed(Error)
    }

    private(set) var state: State = .disconnected
    private var task: URLSessionWebSocketTask?
    let sessionId: String
    let connection: ServerConnection

    // Callbacks
    var onOutput: ((String) -> Void)?
    var onHistoryReceived: ((String) -> Void)?
    var onExit: ((UInt32?) -> Void)?
    var onError: ((Error) -> Void)?
    var onConnected: (() -> Void)?

    init(sessionId: String, connection: ServerConnection) {
        self.sessionId = sessionId
        self.connection = connection
        super.init()
    }

    func connect() {
        guard task == nil else { return }
        state = .connecting

        let urlString = "ws://\(connection.host):\(connection.port)/api/pty/\(sessionId)/ws?token=\(connection.token)"
        guard let url = URL(string: urlString) else {
            let error = URLError(.badURL)
            state = .failed(error)
            onError?(error)
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

    func sendInput(_ text: String) async throws {
        guard let task = task else { return }
        let msg = PTYInputMessage(data: text)
        let data = try JSONEncoder().encode(msg)
        guard let string = String(data: data, encoding: .utf8) else { return }
        try await task.send(.string(string))
    }

    func sendResize(cols: Int, rows: Int) async throws {
        guard let task = task else { return }
        let payload: [String: Any] = [
            "type": "pty-resize",
            "cols": cols,
            "rows": rows,
        ]
        let data = try JSONSerialization.data(withJSONObject: payload)
        guard let string = String(data: data, encoding: .utf8) else { return }
        try await task.send(.string(string))
    }

    // MARK: - Private

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
                        self.onError?(error)
                    }
                    break
                }
            }
        }
    }

    private func parseMessage(_ data: Data) {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let msg = PTYMessageFromServer(json: json) else { return }

        Task { @MainActor [weak self] in
            guard let self = self else { return }

            // Fire onConnected only once, on first message received
            if case .connecting = self.state {
                self.state = .connected
                self.onConnected?()
            }

            switch msg {
            case .history(_, let data):
                self.onHistoryReceived?(data)
            case .output(_, let data):
                self.onOutput?(data)
            case .exit(_, let code):
                self.onExit?(code)
                self.state = .disconnected
            }
        }
    }
}
