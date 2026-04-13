import Foundation

@Observable
class TerminalViewModel {
    private(set) var outputLines: [TerminalLine] = []
    private(set) var isConnected = false
    private(set) var exitCode: UInt32?
    private(set) var connectionError: String?

    struct TerminalLine: Identifiable {
        let id = UUID()
        var text: String
        var isHistory: Bool
        var isError: Bool = false
    }

    private var ptyClient: PTYWebSocketClient?
    private let maxLines = 5000

    func connect(sessionId: String, using connection: ServerConnection) async {
        let client = PTYWebSocketClient(sessionId: sessionId, connection: connection)
        self.ptyClient = client

        client.onOutput = { [weak self] text in
            Task { @MainActor in
                self?.appendOutput(text)
            }
        }

        client.onHistoryReceived = { [weak self] text in
            Task { @MainActor in
                self?.appendOutput(text, isHistory: true)
            }
        }

        client.onExit = { [weak self] code in
            Task { @MainActor in
                self?.exitCode = code
                self?.isConnected = false
            }
        }

        client.onConnected = { [weak self] in
            Task { @MainActor in
                self?.isConnected = true
                self?.connectionError = nil
            }
        }

        client.onError = { [weak self] error in
            Task { @MainActor in
                self?.isConnected = false
                self?.connectionError = error.localizedDescription
            }
        }

        client.connect()
    }

    func disconnect() {
        ptyClient?.disconnect()
        ptyClient = nil
        isConnected = false
    }

    func sendInput(_ text: String) async throws {
        try await ptyClient?.sendInput(text)
    }

    func sendResize(cols: Int, rows: Int) async throws {
        try await ptyClient?.sendResize(cols: cols, rows: rows)
    }

    /// Append an error message to the terminal output.
    func appendError(_ text: String) {
        outputLines.append(TerminalLine(text: text, isHistory: false, isError: true))
        trimIfNeeded()
    }

    /// Incremental append — does NOT re-parse full buffer.
    private func appendOutput(_ text: String, isHistory: Bool = false) {
        let newLines = text.components(separatedBy: "\n")
        for line in newLines {
            outputLines.append(TerminalLine(text: line, isHistory: isHistory))
        }
        trimIfNeeded()
    }

    private func trimIfNeeded() {
        if outputLines.count > maxLines {
            outputLines.removeFirst(outputLines.count - maxLines)
        }
    }
}
