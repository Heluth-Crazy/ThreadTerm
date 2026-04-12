import Foundation

@Observable
class SessionViewModel {
    private(set) var messages: [ChatMessage] = []
    private(set) var isStreaming = false
    private(set) var error: String?
    private(set) var streamingContent = ""

    let session: Session
    private weak var chatClient: ChatWebSocketClient?

    struct ChatMessage: Identifiable {
        let id = UUID()
        let role: String  // "user" or "assistant"
        var content: String
        let timestamp: Date
        var isStreaming: Bool
    }

    init(session: Session, chatClient: ChatWebSocketClient) {
        self.session = session
        self.chatClient = chatClient
        setupCallbacks()
    }

    func sendMessage(_ text: String, projectPath: String, provider: String) async throws {
        let userMessage = ChatMessage(
            role: "user",
            content: text,
            timestamp: Date(),
            isStreaming: false
        )
        await MainActor.run {
            messages.append(userMessage)
            isStreaming = true
            streamingContent = ""

            let assistantMessage = ChatMessage(
                role: "assistant",
                content: "",
                timestamp: Date(),
                isStreaming: true
            )
            messages.append(assistantMessage)
        }

        try await chatClient?.sendMessage(
            sessionId: session.id,
            projectPath: projectPath,
            message: text,
            provider: provider
        )
    }

    func abort() async throws {
        try await chatClient?.abortSession(sessionId: session.id)
        await MainActor.run {
            isStreaming = false
            if !messages.isEmpty {
                messages[messages.count - 1].isStreaming = false
            }
        }
    }

    private func setupCallbacks() {
        chatClient?.onChatResponse = { [weak self] sessionId, content, done in
            guard let self = self, sessionId == self.session.id else { return }
            Task { @MainActor in
                if done {
                    self.isStreaming = false
                    if !self.messages.isEmpty {
                        self.messages[self.messages.count - 1].isStreaming = false
                        self.messages[self.messages.count - 1].content = self.streamingContent
                    }
                    self.streamingContent = ""
                } else {
                    self.streamingContent += content
                    if !self.messages.isEmpty {
                        self.messages[self.messages.count - 1].content = self.streamingContent
                    }
                }
            }
        }

        chatClient?.onChatError = { [weak self] sessionId, error in
            guard let self = self, sessionId == self.session.id else { return }
            Task { @MainActor in
                self.error = error
                self.isStreaming = false
                if !self.messages.isEmpty {
                    self.messages[self.messages.count - 1].isStreaming = false
                }
            }
        }
    }
}
