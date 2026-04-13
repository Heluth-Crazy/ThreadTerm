import Foundation

/// PTY-based session view model. Chat/AI interaction flows through:
/// 1. POST /api/sessions → creates and starts a PTY → returns ptyId
/// 2. WS /api/pty/{ptyId}/ws → streams AI output (pty-output messages)
/// 3. POST /api/sessions/{ptyId}/send → sends user text input to the AI
@Observable
class SessionViewModel {
    struct ChatMessage: Identifiable {
        let id = UUID()
        let role: String          // "user" or "assistant"
        var content: String
        let timestamp: Date
        var isStreaming: Bool
    }

    private(set) var messages: [ChatMessage] = []
    private(set) var isStreaming = false
    var errorMessage: String?
    private(set) var ptyId: String?
    private(set) var isConnected = false

    let session: Session
    private var ptyClient: PTYWebSocketClient?
    private var apiClient: OpenWorkAPIClient?

    init(session: Session) {
        self.session = session
    }

    /// For ACTIVE sessions: attach WebSocket to an already-running PTY.
    /// Does NOT call POST /api/sessions.
    func attachToExisting(ptyId: String, using client: OpenWorkAPIClient) async {
        self.apiClient = client
        errorMessage = nil

        let ptyClient = PTYWebSocketClient(sessionId: ptyId, connection: client.connection)
        await MainActor.run {
            self.ptyId = ptyId
            self.ptyClient = ptyClient
        }

        configurePTYCallbacks(ptyClient)
        ptyClient.connect()
    }

    /// For HISTORY sessions: create a new PTY via POST /api/sessions, then connect WebSocket.
    func connect(using client: OpenWorkAPIClient) async {
        self.apiClient = client
        errorMessage = nil

        do {
            let id = try await client.createAndStartSession(
                projectPath: session.projectPath,
                provider: session.provider,
                resumeSessionId: session.id
            )
            await MainActor.run { self.ptyId = id }

            let ptyClient = PTYWebSocketClient(sessionId: id, connection: client.connection)
            await MainActor.run { self.ptyClient = ptyClient }

            configurePTYCallbacks(ptyClient)
            ptyClient.connect()
        } catch let apiError as APIError {
            await MainActor.run {
                self.errorMessage = apiError.errorDescription ?? apiError.localizedDescription
            }
        } catch {
            await MainActor.run {
                self.errorMessage = "Failed to start session: \(error.localizedDescription)"
            }
        }
    }

    private func configurePTYCallbacks(_ ptyClient: PTYWebSocketClient) {
        ptyClient.onHistoryReceived = { [weak self] data in
            Task { @MainActor in
                self?.appendAssistantOutput(data, isHistory: true)
            }
        }
        ptyClient.onOutput = { [weak self] data in
            Task { @MainActor in
                self?.appendAssistantOutput(data, isHistory: false)
            }
        }
        ptyClient.onExit = { [weak self] code in
            Task { @MainActor in
                self?.isConnected = false
                self?.isStreaming = false
                if let code = code, code != 0 {
                    self?.errorMessage = "Session exited with code \(code)"
                }
            }
        }
        ptyClient.onError = { [weak self] error in
            Task { @MainActor in
                self?.isConnected = false
                self?.errorMessage = "Connection error: \(error.localizedDescription)"
            }
        }
        ptyClient.onConnected = { [weak self] in
            Task { @MainActor in
                self?.isConnected = true
            }
        }
    }

    func disconnect() {
        ptyClient?.disconnect()
        ptyClient = nil
        isConnected = false
        isStreaming = false
    }

    func sendMessage(_ text: String) async {
        guard let apiClient, let ptyId, isConnected else {
            errorMessage = "Not connected. Please wait for the session to start."
            return
        }

        let userMsg = ChatMessage(role: "user", content: text, timestamp: Date(), isStreaming: false)
        messages.append(userMsg)
        isStreaming = true
        errorMessage = nil

        do {
            try await apiClient.sendToSession(ptyId: ptyId, text: text + "\n")
        } catch {
            isStreaming = false
            messages.removeLast()
            errorMessage = "Failed to send: \(error.localizedDescription)"
        }
    }

    func abort() async {
        guard let apiClient, let ptyId else { return }
        do {
            try await apiClient.killSession(ptyId: ptyId)
            isStreaming = false
        } catch {
            errorMessage = "Failed to abort: \(error.localizedDescription)"
        }
    }

    private func appendAssistantOutput(_ data: String, isHistory: Bool) {
        if isHistory {
            let msg = ChatMessage(role: "assistant", content: data, timestamp: Date(), isStreaming: false)
            messages.append(msg)
        } else {
            if let last = messages.last, last.role == "assistant", last.isStreaming {
                messages[messages.count - 1].content += data
            } else {
                let msg = ChatMessage(role: "assistant", content: data, timestamp: Date(), isStreaming: true)
                messages.append(msg)
            }
            isStreaming = true
        }
    }
}
