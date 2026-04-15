import XCTest
@testable import OpenWorkMobile

@MainActor
final class SessionViewModelTests: XCTestCase {
    func testANSIParserStripsEscapeSequencesFromAssistantOutput() {
        let input = "\u{001B}[?2004h\u{001B}]0;Claude Code\u{0007}Hello\u{001B}[0m"

        XCTAssertEqual(ANSIParser.clean(input), "Hello")
    }

    func testWhitespaceOnlyPTYOutputDoesNotCreateAssistantBubble() {
        let viewModel = makeViewModel(streamCompletionDelay: 0.01)

        viewModel.handleAssistantOutput("\u{001B}[?2004h\r\n", isHistory: false)

        XCTAssertTrue(viewModel.messages.isEmpty)
    }

    func testTerminalFrameOutputDoesNotCreateChatBubble() {
        let viewModel = makeViewModel(streamCompletionDelay: 0.01)

        viewModel.handleAssistantOutput("╭────────────────────╮\n│ OpenAI Codex       │\n╰────────────────────╯", isHistory: false)

        XCTAssertTrue(viewModel.messages.isEmpty)
    }

    func testToolLikeOutputCreatesToolMessageInsteadOfAssistantBubble() {
        let viewModel = makeViewModel(streamCompletionDelay: 0.01)

        viewModel.handleAssistantOutput("Running rg --files src", isHistory: false)

        XCTAssertEqual(viewModel.messages.count, 1)
        XCTAssertEqual(viewModel.messages[0].kind, .tool)
        XCTAssertEqual(viewModel.activityPhase, .tool)
    }

    func testStartupNoiseDoesNotCreateAssistantBubble() {
        let viewModel = makeViewModel(streamCompletionDelay: 0.01)

        viewModel.handleAssistantOutput(
            "/Users/test/.openclaw/completions/openclaw.zsh:3685: command not found: compdef\ndemo6598qq.com@bogon OpenWork %\ncodex --dangerously-bypass-approvals-and-sandbox\n› Summarize recent commits   gpt-5.4 high · ~/Desktop/project/OpenWork",
            isHistory: false
        )

        XCTAssertTrue(viewModel.messages.isEmpty)
    }

    func testFragmentedCodexStartupNoiseDoesNotCreateAssistantBubble() {
        let viewModel = makeViewModel(provider: "codex", streamCompletionDelay: 0.01)

        [
            "B",
            "Bo",
            "Boo",
            "Boot",
            "Booting ",
            "Booting M",
            "Booting MCP",
            " server: xco",
            "debuildmcp",
        ].forEach {
            viewModel.handleAssistantOutput($0, isHistory: false)
        }

        XCTAssertTrue(viewModel.messages.isEmpty)
    }

    func testSplitNoiseFragmentsDoNotLeakIntoCodexChatBubble() {
        let viewModel = makeViewModel(provider: "codex", streamCompletionDelay: 0.01)

        [
            "Booting MCP se",
            "rver xcod",
            "ebuildmcp",
        ].forEach {
            viewModel.handleAssistantOutput($0, isHistory: false)
        }

        XCTAssertTrue(viewModel.messages.isEmpty)
    }

    func testCodexStartupNoiseFlushesWhenRealAssistantTextArrives() {
        let viewModel = makeViewModel(provider: "codex", streamCompletionDelay: 0.01)

        viewModel.handleAssistantOutput("Booting MCP", isHistory: false)
        viewModel.handleAssistantOutput(" server: xcodebuildmcp", isHistory: false)
        viewModel.handleAssistantOutput("Here is the fix.", isHistory: false)

        XCTAssertEqual(viewModel.messages.count, 1)
        guard viewModel.messages.count == 1 else { return }
        XCTAssertEqual(viewModel.messages[0].kind, .assistant)
        XCTAssertEqual(viewModel.messages[0].content, "Here is the fix.")
    }

    func testCodexSplitNoiseFlushesWhenRealAssistantTextArrives() {
        let viewModel = makeViewModel(provider: "codex", streamCompletionDelay: 0.01)

        viewModel.handleAssistantOutput("Booting MCP se", isHistory: false)
        viewModel.handleAssistantOutput("rver xcod", isHistory: false)
        viewModel.handleAssistantOutput("ebuildmcp", isHistory: false)
        viewModel.handleAssistantOutput("Here is the actual reply.", isHistory: false)

        XCTAssertEqual(viewModel.messages.count, 1)
        guard viewModel.messages.count == 1 else { return }
        XCTAssertEqual(viewModel.messages[0].kind, .assistant)
        XCTAssertEqual(viewModel.messages[0].content, "Here is the actual reply.")
    }

    func testLiveStreamingChunksAppendWithoutArtificialNewlines() {
        let viewModel = makeViewModel(streamCompletionDelay: 0.05)

        viewModel.handleAssistantOutput("Booting MCP", isHistory: false)
        viewModel.handleAssistantOutput(" server: xcodebuildmcp", isHistory: false)

        XCTAssertEqual(viewModel.messages.count, 1)
        XCTAssertEqual(viewModel.messages[0].content, "Booting MCP server: xcodebuildmcp")
    }

    func testStreamingOutputFinishesAfterIdleDelay() async {
        let viewModel = makeViewModel(streamCompletionDelay: 0.05)

        viewModel.handleAssistantOutput("\u{001B}[31mHello\u{001B}[0m", isHistory: false)

        XCTAssertEqual(viewModel.messages.count, 1)
        XCTAssertTrue(viewModel.isStreaming)
        XCTAssertTrue(viewModel.messages[0].isStreaming)
        XCTAssertEqual(viewModel.messages[0].content, "Hello")
        XCTAssertEqual(viewModel.messages[0].kind, .assistant)

        try? await Task.sleep(nanoseconds: 150_000_000)

        XCTAssertFalse(viewModel.isStreaming)
        XCTAssertFalse(viewModel.messages[0].isStreaming)
        XCTAssertEqual(viewModel.messages[0].content, "Hello")
        XCTAssertEqual(viewModel.activityPhase, .idle)
    }

    func testCodexUsesCarriageReturnToSubmitMessage() {
        let viewModel = makeViewModel(provider: "codex", streamCompletionDelay: 0.01)

        XCTAssertEqual(viewModel.submissionTerminator(for: "codex"), "\r")
        XCTAssertEqual(viewModel.submissionTerminator(for: "claude"), "\n")
    }

    private func makeViewModel(
        provider: String = "claude",
        streamCompletionDelay: TimeInterval
    ) -> SessionViewModel {
        SessionViewModel(
            session: Session(
                id: "test-session",
                projectPath: "/tmp/project",
                provider: provider,
                name: nil,
                createdAt: nil,
                lastMessage: nil,
                messageCount: 0
            ),
            streamCompletionDelay: streamCompletionDelay
        )
    }
}
