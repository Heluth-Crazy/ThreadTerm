import XCTest
@testable import OpenWorkMobile

@MainActor
final class SessionIntegrationTests: XCTestCase {
    private struct TestConfig {
        let connection: ServerConnection
        let preferredProjectPath: String?
    }

    func testHistorySessionCanCreateAndConnectRealPTY() async throws {
        let config = try loadConfig()
        let client = OpenWorkAPIClient(connection: config.connection)
        let project = try await loadProject(using: client, preferredPath: config.preferredProjectPath)
        guard let historySession = project.sessions.first else {
            throw XCTSkip("No saved history session exists for project \(project.fullPath)")
        }

        let viewModel = SessionViewModel(session: historySession, streamCompletionDelay: 0.8)
        await viewModel.connect(using: client)
        defer {
            if let ptyId = viewModel.ptyId {
                Task {
                    try? await client.killSession(ptyId: ptyId)
                }
            }
            viewModel.disconnect()
        }

        try await waitUntil(timeout: 30, description: "history session websocket should connect") {
            viewModel.isConnected || viewModel.errorMessage != nil
        }

        XCTAssertTrue(viewModel.isConnected, viewModel.errorMessage ?? "History session failed to connect")
        XCTAssertNil(viewModel.errorMessage)
        XCTAssertNotNil(viewModel.ptyId)
    }

    func testRealSessionSupportsTwoConsecutiveMessagesWithoutANSILeakage() async throws {
        let config = try loadConfig()
        let client = OpenWorkAPIClient(connection: config.connection)
        let project = try await loadProject(using: client, preferredPath: config.preferredProjectPath)
        let provider = project.sessions.first?.provider ?? "claude"

        let ptyId = try await client.createAndStartSession(
            projectPath: project.fullPath,
            provider: provider,
            resumeSessionId: nil
        )
        defer {
            Task {
                try? await client.killSession(ptyId: ptyId)
            }
        }

        let viewModel = SessionViewModel(
            session: Session(
                id: "integration-session",
                projectPath: project.fullPath,
                provider: provider,
                name: "Integration Session",
                createdAt: nil,
                lastMessage: nil,
                messageCount: 0
            ),
            streamCompletionDelay: 0.8
        )

        await viewModel.attachToExisting(ptyId: ptyId, using: client)

        try await waitUntil(timeout: 30, description: "fresh PTY should connect") {
            viewModel.isConnected || viewModel.errorMessage != nil
        }
        XCTAssertTrue(viewModel.isConnected, viewModel.errorMessage ?? "PTY failed to connect")
        XCTAssertNil(viewModel.errorMessage)

        // Let startup banners or shell noise settle before the first send.
        try await waitUntil(timeout: 15, description: "initial stream should settle") {
            !viewModel.isStreaming
        }

        let markerOne = "OW_IOS_SEND_ONE_" + UUID().uuidString.prefix(8)
        await viewModel.sendMessage("Reply with exactly \(markerOne) and nothing else.")
        try await waitForAssistantMessage(containing: String(markerOne), in: viewModel, timeout: 120)
        try await waitUntil(timeout: 20, description: "first reply should finish streaming") {
            !viewModel.isStreaming
        }
        XCTAssertNil(viewModel.errorMessage)

        let firstReply = latestAssistantMessage(in: viewModel)
        XCTAssertNotNil(firstReply)
        XCTAssertTrue(firstReply?.content.contains(String(markerOne)) == true, "First reply did not contain marker")
        XCTAssertFalse(firstReply?.content.contains("\u{001B}") == true, "First reply still contains ANSI escapes")

        let assistantCountAfterFirst = assistantMessageCount(in: viewModel)

        let markerTwo = "OW_IOS_SEND_TWO_" + UUID().uuidString.prefix(8)
        await viewModel.sendMessage("Reply with exactly \(markerTwo) and nothing else.")
        try await waitForAssistantMessage(containing: String(markerTwo), in: viewModel, timeout: 120)
        try await waitUntil(timeout: 20, description: "second reply should finish streaming") {
            !viewModel.isStreaming
        }
        XCTAssertNil(viewModel.errorMessage)

        let secondReply = latestAssistantMessage(in: viewModel)
        XCTAssertNotNil(secondReply)
        XCTAssertTrue(secondReply?.content.contains(String(markerTwo)) == true, "Second reply did not contain marker")
        XCTAssertFalse(secondReply?.content.contains("\u{001B}") == true, "Second reply still contains ANSI escapes")
        XCTAssertGreaterThan(assistantMessageCount(in: viewModel), assistantCountAfterFirst)
    }

    func testRealCodexSessionCanSendAndReceiveAssistantReply() async throws {
        let config = try loadConfig()
        let client = OpenWorkAPIClient(connection: config.connection)
        let project = try await loadProject(using: client, preferredPath: config.preferredProjectPath)

        let ptyId = try await client.createAndStartSession(
            projectPath: project.fullPath,
            provider: "codex",
            resumeSessionId: nil
        )
        defer {
            Task {
                try? await client.killSession(ptyId: ptyId)
            }
        }

        let viewModel = SessionViewModel(
            session: Session(
                id: "integration-codex-session",
                projectPath: project.fullPath,
                provider: "codex",
                name: "Integration Codex Session",
                createdAt: nil,
                lastMessage: nil,
                messageCount: 0
            ),
            streamCompletionDelay: 0.8
        )

        await viewModel.attachToExisting(ptyId: ptyId, using: client)

        try await waitUntil(timeout: 30, description: "codex PTY should connect") {
            viewModel.isConnected || viewModel.errorMessage != nil
        }
        XCTAssertTrue(viewModel.isConnected, viewModel.errorMessage ?? "Codex PTY failed to connect")
        XCTAssertNil(viewModel.errorMessage)

        try await waitUntil(timeout: 20, description: "codex startup noise should settle") {
            !viewModel.isStreaming
        }

        let marker = "OW_IOS_CODEX_" + UUID().uuidString.prefix(8)
        await viewModel.sendMessage("Reply with exactly \(marker) and nothing else.")
        try await waitForAssistantMessage(containing: String(marker), in: viewModel, timeout: 180)
        try await waitUntil(timeout: 20, description: "codex reply should finish streaming") {
            !viewModel.isStreaming
        }

        XCTAssertNil(viewModel.errorMessage)
        XCTAssertFalse(
            viewModel.messages.contains {
                $0.kind == .assistant && $0.content.localizedCaseInsensitiveContains("booting mcp")
            },
            "Startup noise leaked into assistant chat bubbles"
        )

        let reply = latestAssistantMessage(in: viewModel)
        XCTAssertNotNil(reply)
        XCTAssertTrue(reply?.content.contains(String(marker)) == true, "Codex reply did not contain marker")
        XCTAssertFalse(reply?.content.contains("\u{001B}") == true, "Codex reply still contains ANSI escapes")
    }

    private func loadConfig() throws -> TestConfig {
        let env = ProcessInfo.processInfo.environment
        let savedConnection = ConnectionStorage.loadConnections().first
        let host = envValue("OPENWORK_TEST_HOST", env: env) ?? savedConnection?.host ?? "192.168.1.118"
        let port = Int(envValue("OPENWORK_TEST_PORT", env: env) ?? "") ?? savedConnection?.port ?? 3002
        let token = try loadToken(from: env, savedConnection: savedConnection)
        let preferredProjectPath = envValue("OPENWORK_TEST_PROJECT_PATH", env: env)

        return TestConfig(
            connection: ServerConnection(
                name: "Integration",
                host: host,
                port: port,
                token: token
            ),
            preferredProjectPath: preferredProjectPath
        )
    }

    private func loadToken(from env: [String: String], savedConnection: ServerConnection?) throws -> String {
        if let token = envValue("OPENWORK_TEST_TOKEN", env: env)?.trimmingCharacters(in: .whitespacesAndNewlines),
           !token.isEmpty {
            return token
        }

        if let token = savedConnection?.token.trimmingCharacters(in: .whitespacesAndNewlines),
           !token.isEmpty {
            return token
        }

        let url = URL(fileURLWithPath: NSString(string: "~/.openwork/api-token.txt").expandingTildeInPath)
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw XCTSkip("Missing test token in env, saved connection, and ~/.openwork/api-token.txt")
        }

        let token = try String(contentsOf: url, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else {
            throw XCTSkip("Token file ~/.openwork/api-token.txt is empty")
        }
        return token
    }

    private func envValue(_ key: String, env: [String: String]) -> String? {
        env[key] ?? env["TEST_RUNNER_\(key)"]
    }

    private func loadProject(
        using client: OpenWorkAPIClient,
        preferredPath: String?
    ) async throws -> Project {
        let projects = try await client.fetchProjects()

        if let preferredPath,
           let match = projects.first(where: { $0.fullPath == preferredPath || $0.path == preferredPath }) {
            return match
        }

        if let repoProject = projects.first(where: { $0.fullPath.hasSuffix("/OpenWork") || $0.path.hasSuffix("/OpenWork") }) {
            return repoProject
        }

        guard let first = projects.first else {
            throw XCTSkip("No projects available from OpenWork backend")
        }
        return first
    }

    private func waitForAssistantMessage(
        containing marker: String,
        in viewModel: SessionViewModel,
        timeout: TimeInterval
    ) async throws {
        try await waitUntil(timeout: timeout, description: "assistant response should contain \(marker)") {
            viewModel.messages.contains {
                $0.kind == .assistant && $0.content.contains(marker)
            } || viewModel.errorMessage != nil
        }

        if let errorMessage = viewModel.errorMessage {
            XCTFail("Session failed while waiting for assistant response: \(errorMessage)")
        }
    }

    private func waitUntil(
        timeout: TimeInterval,
        pollInterval: TimeInterval = 0.25,
        description: String,
        condition: @escaping () -> Bool
    ) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return }
            try await Task.sleep(nanoseconds: UInt64(pollInterval * 1_000_000_000))
        }
        XCTFail("Timed out waiting: \(description)")
    }

    private func assistantMessageCount(in viewModel: SessionViewModel) -> Int {
        viewModel.messages.filter { $0.kind == .assistant }.count
    }

    private func latestAssistantMessage(in viewModel: SessionViewModel) -> SessionViewModel.ChatMessage? {
        viewModel.messages.last { $0.kind == .assistant }
    }
}
