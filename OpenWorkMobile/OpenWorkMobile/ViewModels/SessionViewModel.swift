import Foundation

@Observable
class SessionViewModel {
    enum ChatMessageKind: String {
        case user
        case assistant
        case tool
        case thinking
        case status
        case error
    }

    enum ChatMessageSource: String {
        case localEcho
        case history
        case live
    }

    enum ActivityPhase: Equatable {
        case idle
        case sending
        case thinking
        case tool
        case writing
        case failed(String)

        var label: String? {
            switch self {
            case .idle:
                return nil
            case .sending:
                return "Sending..."
            case .thinking:
                return "Thinking..."
            case .tool:
                return "Working..."
            case .writing:
                return "Writing response..."
            case .failed(let message):
                return message
            }
        }
    }

    struct ChatMessage: Identifiable {
        let id: UUID
        let kind: ChatMessageKind
        var content: String
        let timestamp: Date
        var isStreaming: Bool
        let source: ChatMessageSource

        init(
            id: UUID = UUID(),
            kind: ChatMessageKind,
            content: String,
            timestamp: Date = Date(),
            isStreaming: Bool = false,
            source: ChatMessageSource
        ) {
            self.id = id
            self.kind = kind
            self.content = content
            self.timestamp = timestamp
            self.isStreaming = isStreaming
            self.source = source
        }
    }

    private(set) var messages: [ChatMessage] = []
    private(set) var isStreaming = false
    private(set) var activityPhase: ActivityPhase = .idle
    var errorMessage: String?
    private(set) var ptyId: String?
    private(set) var isConnected = false

    let session: Session
    private var ptyClient: PTYWebSocketClient?
    private var apiClient: OpenWorkAPIClient?
    private let streamCompletionDelay: TimeInterval
    private var streamCompletionTask: Task<Void, Never>?
    private var hasLoadedStructuredHistory = false
    private var activeStreamingMessageId: UUID?
    private var liveOutputGate = LiveOutputGate()

    init(session: Session, streamCompletionDelay: TimeInterval = 0.8) {
        self.session = session
        self.streamCompletionDelay = streamCompletionDelay
        liveOutputGate = LiveOutputGate(provider: session.provider)
    }

    func attachToExisting(ptyId: String, using client: OpenWorkAPIClient) async {
        self.apiClient = client
        errorMessage = nil
        liveOutputGate.reset()
        await preloadStructuredHistoryIfNeeded(using: client)

        let ptyClient = PTYWebSocketClient(sessionId: ptyId, connection: client.connection)
        await MainActor.run {
            self.ptyId = ptyId
            self.ptyClient = ptyClient
        }

        configurePTYCallbacks(ptyClient)
        ptyClient.connect()
    }

    func connect(using client: OpenWorkAPIClient) async {
        self.apiClient = client
        errorMessage = nil
        liveOutputGate.reset()
        await preloadStructuredHistoryIfNeeded(using: client)

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
                self.activityPhase = .failed(self.errorMessage ?? "Failed to start session")
            }
        } catch {
            await MainActor.run {
                self.errorMessage = "Failed to start session: \(error.localizedDescription)"
                self.activityPhase = .failed(self.errorMessage ?? "Failed to start session")
            }
        }
    }

    func disconnect() {
        streamCompletionTask?.cancel()
        streamCompletionTask = nil
        ptyClient?.disconnect()
        ptyClient = nil
        isConnected = false
        activeStreamingMessageId = nil
        liveOutputGate.reset()
        finishStreaming()
    }

    func sendMessage(_ text: String) async {
        guard let ptyClient, isConnected else {
            errorMessage = "Not connected. Please wait for the session to start."
            activityPhase = .failed(errorMessage ?? "Not connected")
            return
        }

        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        streamCompletionTask?.cancel()
        streamCompletionTask = nil
        activeStreamingMessageId = nil
        errorMessage = nil
        activityPhase = .sending
        messages.append(
            ChatMessage(
                kind: .user,
                content: trimmed,
                isStreaming: false,
                source: .localEcho
            )
        )

        do {
            try await ptyClient.sendInput(trimmed + submissionTerminator(for: session.provider))
            isStreaming = true
            activityPhase = .thinking
            scheduleStreamCompletion()
        } catch {
            isStreaming = false
            errorMessage = "Failed to send: \(error.localizedDescription)"
            activityPhase = .failed(errorMessage ?? "Failed to send")
            messages.append(
                ChatMessage(
                    kind: .error,
                    content: errorMessage ?? "Failed to send",
                    isStreaming: false,
                    source: .live
                )
            )
        }
    }

    func abort() async {
        guard let ptyClient else { return }
        do {
            try await ptyClient.sendInput("\u{3}")
            finishStreaming()
        } catch {
            errorMessage = "Failed to abort: \(error.localizedDescription)"
            activityPhase = .failed(errorMessage ?? "Failed to abort")
        }
    }

    func handleAssistantOutput(_ data: String, isHistory: Bool) {
        guard let filtered = liveOutputGate.consume(data, isHistory: isHistory) else {
            if !isHistory {
                scheduleStreamCompletion()
            }
            return
        }

        let events = isHistory
            ? SessionEventInterpreter.replayEvents(from: filtered)
            : SessionEventInterpreter.liveEvents(from: filtered)

        guard !events.isEmpty else {
            if !isHistory {
                scheduleStreamCompletion()
            }
            return
        }

        for event in events {
            append(event: event)
        }

        if !isHistory {
            isStreaming = true
            scheduleStreamCompletion()
        }
    }

    func finishStreaming() {
        streamCompletionTask?.cancel()
        streamCompletionTask = nil
        isStreaming = false
        activeStreamingMessageId = nil
        if let last = messages.last, last.isStreaming {
            messages[messages.count - 1].isStreaming = false
            messages[messages.count - 1].content = messages[messages.count - 1]
                .content
                .trimmingCharacters(in: .whitespacesAndNewlines)
        }
        if case .failed = activityPhase {
            return
        }
        activityPhase = .idle
    }

    private func configurePTYCallbacks(_ ptyClient: PTYWebSocketClient) {
        ptyClient.onHistoryReceived = { [weak self] data in
            Task { @MainActor in
                self?.handleAssistantOutput(data, isHistory: true)
            }
        }
        ptyClient.onOutput = { [weak self] data in
            Task { @MainActor in
                self?.handleAssistantOutput(data, isHistory: false)
            }
        }
        ptyClient.onExit = { [weak self] code in
            Task { @MainActor in
                self?.finishStreaming()
                self?.isConnected = false
                if let code = code, code != 0 {
                    self?.errorMessage = "Session exited with code \(code)"
                    self?.activityPhase = .failed(self?.errorMessage ?? "Session exited")
                    self?.messages.append(
                        ChatMessage(
                            kind: .error,
                            content: self?.errorMessage ?? "Session exited",
                            source: .live
                        )
                    )
                }
            }
        }
        ptyClient.onError = { [weak self] error in
            Task { @MainActor in
                self?.finishStreaming()
                self?.isConnected = false
                self?.errorMessage = "Connection error: \(error.localizedDescription)"
                self?.activityPhase = .failed(self?.errorMessage ?? "Connection error")
            }
        }
        ptyClient.onConnected = { [weak self] in
            Task { @MainActor in
                self?.isConnected = true
                if self?.messages.isEmpty == true {
                    self?.activityPhase = .idle
                }
            }
        }
    }

    private func preloadStructuredHistoryIfNeeded(using client: OpenWorkAPIClient) async {
        guard !hasLoadedStructuredHistory else { return }
        hasLoadedStructuredHistory = true

        do {
            let history = try await client.fetchSessionMessages(
                sessionId: session.id,
                projectPath: session.projectPath,
                provider: session.provider
            )
            let structured = SessionEventInterpreter.historyMessages(from: history)
            await MainActor.run {
                guard !structured.isEmpty else { return }
                self.messages = structured
            }
        } catch {
            // Active sessions may not always have persisted history yet.
        }
    }

    private func append(event: SessionEventInterpreter.InterpretedEvent) {
        let text = event.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }

        switch event.kind {
        case .assistant:
            activityPhase = .writing
        case .tool:
            activityPhase = .tool
        case .thinking:
            activityPhase = .thinking
        case .status:
            if activityPhase == .idle {
                activityPhase = .thinking
            }
        case .error:
            errorMessage = text
            activityPhase = .failed(text)
        case .user:
            break
        }

        if let lastIndex = messages.indices.last {
            let last = messages[lastIndex]
            if last.kind == event.kind,
               last.isStreaming,
               event.kind != .user,
               event.kind != .error
            {
                let separator: String
                if last.source == .live, event.source == .live {
                    separator = needsInlineSeparator(
                        between: last.content,
                        and: text
                    )
                        ? " "
                        : ""
                } else {
                    separator = last.content.hasSuffix("\n") || text.hasPrefix("\n") ? "" : "\n"
                }
                messages[lastIndex].content += separator + text
                return
            }
        }

        let message = ChatMessage(
            id: activeStreamingMessageId ?? UUID(),
            kind: event.kind,
            content: text,
            isStreaming: event.isStreaming,
            source: event.source
        )
        if event.isStreaming {
            activeStreamingMessageId = message.id
        }
        messages.append(message)
    }

    private func scheduleStreamCompletion() {
        streamCompletionTask?.cancel()
        let delay = streamCompletionDelay
        streamCompletionTask = Task { [weak self] in
            let nanos = UInt64(max(delay, 0) * 1_000_000_000)
            try? await Task.sleep(nanoseconds: nanos)
            guard !Task.isCancelled else { return }
            guard let self else { return }
            await MainActor.run {
                self.finishStreaming()
            }
        }
    }

    private func needsInlineSeparator(between lhs: String, and rhs: String) -> Bool {
        guard let left = lhs.last, let right = rhs.first else { return false }
        guard !left.isWhitespace, !right.isWhitespace else { return false }
        return left.isLetter || left.isNumber
            ? (right.isLetter || right.isNumber)
            : false
    }

    func submissionTerminator(for provider: String) -> String {
        provider.lowercased() == "codex" ? "\r" : "\n"
    }
}

private enum SessionEventInterpreter {
    struct InterpretedEvent {
        let kind: SessionViewModel.ChatMessageKind
        let text: String
        let isStreaming: Bool
        let source: SessionViewModel.ChatMessageSource
    }

    static func historyMessages(from messages: [SessionMessage]) -> [SessionViewModel.ChatMessage] {
        messages.flatMap(historyEvents(from:)).map {
            SessionViewModel.ChatMessage(
                kind: $0.kind,
                content: $0.text,
                timestamp: Date(),
                isStreaming: false,
                source: .history
            )
        }
    }

    static func replayEvents(from raw: String) -> [InterpretedEvent] {
        liveEvents(from: raw).map {
            InterpretedEvent(kind: $0.kind, text: $0.text, isStreaming: false, source: .history)
        }
    }

    static func liveEvents(from raw: String) -> [InterpretedEvent] {
        let cleaned = sanitize(raw)
        guard !cleaned.isEmpty else { return [] }

        if let error = classifyError(cleaned) {
            return [InterpretedEvent(kind: .error, text: error, isStreaming: false, source: .live)]
        }
        if let tool = classifyTool(cleaned) {
            return [InterpretedEvent(kind: .tool, text: tool, isStreaming: true, source: .live)]
        }
        if let thinking = classifyThinking(cleaned) {
            return [InterpretedEvent(kind: .thinking, text: thinking, isStreaming: true, source: .live)]
        }

        return [InterpretedEvent(kind: .assistant, text: cleaned, isStreaming: true, source: .live)]
    }

    private static func historyEvents(from message: SessionMessage) -> [InterpretedEvent] {
        if message.isSidechain == true {
            return []
        }

        let kind = baseKind(for: message.role)
        return flattenContent(message.content, defaultKind: kind, source: .history)
    }

    private static func flattenContent(
        _ value: AnyCodableValue,
        defaultKind: SessionViewModel.ChatMessageKind,
        source: SessionViewModel.ChatMessageSource
    ) -> [InterpretedEvent] {
        switch value {
        case .string(let text):
            let cleaned = sanitize(text)
            guard !cleaned.isEmpty else { return [] }
            return [InterpretedEvent(kind: defaultKind, text: cleaned, isStreaming: false, source: source)]

        case .array(let items):
            var events: [InterpretedEvent] = []
            var bufferedText: [String] = []

            func flushBufferedText() {
                let joined = sanitize(bufferedText.joined(separator: "\n\n"))
                if !joined.isEmpty {
                    events.append(
                        InterpretedEvent(
                            kind: defaultKind,
                            text: joined,
                            isStreaming: false,
                            source: source
                        )
                    )
                }
                bufferedText.removeAll()
            }

            for item in items {
                if case .object(let object) = item,
                   case .string(let type) = object["type"] {
                    switch type {
                    case "thinking", "redacted_thinking":
                        continue
                    case "text":
                        if let text = plainText(from: object["text"]) {
                            bufferedText.append(text)
                        }
                        continue
                    case "tool_use":
                        flushBufferedText()
                        let toolName = plainText(from: object["name"]) ?? "Tool"
                        let toolInput = summarizeToolPayload(object["input"])
                        let payload = toolInput.isEmpty ? toolName : "\(toolName)\n\(toolInput)"
                        events.append(
                            InterpretedEvent(kind: .tool, text: payload, isStreaming: false, source: source)
                        )
                        continue
                    case "tool_result":
                        flushBufferedText()
                        let toolOutput = summarizeToolPayload(object["content"] ?? object["output"])
                        guard !toolOutput.isEmpty else { continue }
                        events.append(
                            InterpretedEvent(kind: .tool, text: toolOutput, isStreaming: false, source: source)
                        )
                        continue
                    default:
                        break
                    }
                }

                let nested = flattenContent(item, defaultKind: defaultKind, source: source)
                if nested.count == 1, nested[0].kind == defaultKind {
                    bufferedText.append(nested[0].text)
                } else if !nested.isEmpty {
                    flushBufferedText()
                    events.append(contentsOf: nested)
                }
            }

            flushBufferedText()
            return events

        case .object(let object):
            if case .string(let type) = object["type"] {
                switch type {
                case "thinking", "redacted_thinking":
                    return []
                case "tool_use":
                    let toolName = plainText(from: object["name"]) ?? "Tool"
                    let toolInput = summarizeToolPayload(object["input"])
                    let payload = toolInput.isEmpty ? toolName : "\(toolName)\n\(toolInput)"
                    return [InterpretedEvent(kind: .tool, text: payload, isStreaming: false, source: source)]
                case "tool_result":
                    let output = summarizeToolPayload(object["content"] ?? object["output"])
                    guard !output.isEmpty else { return [] }
                    return [InterpretedEvent(kind: .tool, text: output, isStreaming: false, source: source)]
                default:
                    break
                }
            }

            if let content = object["content"] {
                let nested = flattenContent(content, defaultKind: defaultKind, source: source)
                if !nested.isEmpty {
                    return nested
                }
            }

            if let message = object["message"] {
                let nested = flattenContent(message, defaultKind: defaultKind, source: source)
                if !nested.isEmpty {
                    return nested
                }
            }

            if let text = plainText(from: object["text"]) ?? plainText(from: object["message"]) {
                let cleaned = sanitize(text)
                guard !cleaned.isEmpty else { return [] }
                return [InterpretedEvent(kind: defaultKind, text: cleaned, isStreaming: false, source: source)]
            }

            let fallback = sanitize(object.values.compactMap(plainText(from:)).joined(separator: "\n"))
            guard !fallback.isEmpty else { return [] }
            return [InterpretedEvent(kind: defaultKind, text: fallback, isStreaming: false, source: source)]

        default:
            return []
        }
    }

    private static func classifyTool(_ text: String) -> String? {
        let lower = text.lowercased()
        let prefixes = [
            "running ",
            "searching ",
            "reading ",
            "editing ",
            "applying ",
            "tool ",
            "bash(",
            "command_execution",
            "mcp_tool_call",
            "file_change",
        ]
        return prefixes.contains(where: { lower.hasPrefix($0) }) ? text : nil
    }

    private static func classifyThinking(_ text: String) -> String? {
        let lower = text.lowercased()
        if lower.hasPrefix("thinking")
            || lower.contains("analyzing")
            || lower.contains("processing request")
        {
            return text
        }
        return nil
    }

    private static func classifyError(_ text: String) -> String? {
        let lower = text.lowercased()
        if lower.hasPrefix("error")
            || lower.contains("unauthorized")
            || lower.contains("connection error")
        {
            return text
        }
        return nil
    }

    private static func sanitize(_ raw: String) -> String {
        let cleaned = ANSIParser.clean(raw)
        let lines = cleaned
            .components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { shouldKeep(line: $0) }

        return compact(lines.joined(separator: "\n"))
    }

    private static func shouldKeep(line: String) -> Bool {
        guard !line.isEmpty else { return false }

        let stripped = line.replacingOccurrences(of: #"\s+"#, with: "", options: .regularExpression)
        if stripped.isEmpty {
            return false
        }

        if stripped.range(of: #"^[\p{S}\p{P}╭╮╯╰│─┌┐└┘├┤┬┴┼═]+$"#, options: .regularExpression) != nil {
            return false
        }

        if line.hasPrefix("╭") || line.hasPrefix("╰") || line.hasPrefix("│") || line.hasPrefix("─") {
            return false
        }

        if line.range(of: #"^[^\w]*(?:\$|%|>|❯)\s*$"#, options: .regularExpression) != nil {
            return false
        }

        if line.hasPrefix("›") || line.hasPrefix("•") {
            return false
        }

        if line.range(of: #"^[^\s]+@[^\s]+\s+.*[%$#]$"#, options: .regularExpression) != nil {
            return false
        }

        let lower = line.lowercased()
        let ignoredFragments = [
            "claude code",
            "openai codex",
            "press enter to send",
            "shift+enter",
            "ctrl+c to cancel",
            "booting mcp server",
            ".openclaw/completions",
            "command not found: compdef",
        ]
        if ignoredFragments.contains(where: { lower.contains($0) }) {
            return false
        }

        if lower.hasPrefix("codex ") && lower.contains("--") {
            return false
        }

        if lower.contains("gpt-") && line.contains("·") {
            return false
        }

        return true
    }

    private static func compact(_ text: String) -> String {
        text
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
            .replacingOccurrences(of: #"\n{3,}"#, with: "\n\n", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func gateSnapshot(from raw: String) -> String {
        compact(
            ANSIParser.clean(raw)
                .replacingOccurrences(of: #"[╭╮╰╯│─]+"#, with: " ", options: .regularExpression)
                .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
        )
    }

    private static func summarizeToolPayload(_ value: AnyCodableValue?) -> String {
        guard let value else { return "" }

        switch value {
        case .string(let text):
            return compact(text)
        case .array(let items):
            return compact(items.compactMap(plainText(from:)).joined(separator: "\n"))
        case .object(let object):
            return compact(
                object
                    .sorted(by: { $0.key < $1.key })
                    .compactMap { plainText(from: $0.value) }
                    .joined(separator: "\n")
            )
        default:
            return compact(value.description)
        }
    }

    private static func plainText(from value: AnyCodableValue?) -> String? {
        guard let value else { return nil }
        switch value {
        case .string(let text):
            return text
        case .int(let number):
            return String(number)
        case .double(let number):
            return String(number)
        case .bool(let flag):
            return String(flag)
        case .array(let items):
            return items.compactMap(plainText(from:)).joined(separator: "\n")
        case .object(let object):
            if case .string(let text) = object["text"] {
                return text
            }
            if case .string(let message) = object["message"] {
                return message
            }
            return object.values.compactMap(plainText(from:)).joined(separator: "\n")
        case .null:
            return nil
        }
    }

    private static func baseKind(for role: String) -> SessionViewModel.ChatMessageKind {
        switch role.lowercased() {
        case "user":
            return .user
        case "tool":
            return .tool
        case "assistant":
            return .assistant
        default:
            return .assistant
        }
    }
}

private struct LiveOutputGate {
    private let provider: String
    private var activeNoiseSignature = ""

    init(provider: String = "") {
        self.provider = provider.lowercased()
    }

    mutating func reset() {
        activeNoiseSignature.removeAll(keepingCapacity: false)
    }

    mutating func consume(_ raw: String, isHistory: Bool) -> String? {
        guard provider == "codex" else { return raw }

        let snapshot = SessionEventInterpreter.gateSnapshot(from: raw)
        let compact = normalizedSignature(snapshot)

        if compact.isEmpty {
            return nil
        }

        if looksLikeNoise(compact) || looksLikeNoisePrefix(compact) {
            activeNoiseSignature = mergedNoiseSignature(with: compact)
            return nil
        }

        if !activeNoiseSignature.isEmpty {
            let merged = mergedNoiseSignature(with: compact)
            if looksLikeNoiseWordSequence(snapshot) && looksLikeNoiseFragment(merged) {
                activeNoiseSignature = merged
                return nil
            }

            activeNoiseSignature.removeAll(keepingCapacity: false)
        }

        return raw
    }

    private func mergedNoiseSignature(with compact: String) -> String {
        let merged = activeNoiseSignature + compact
        if merged.count <= 256 {
            return merged
        }
        return String(merged.suffix(256))
    }

    private func normalizedSignature(_ value: String) -> String {
        value
            .lowercased()
            .replacingOccurrences(
                of: #"[^a-z0-9]+"#,
                with: "",
                options: .regularExpression
            )
    }

    private func looksLikeNoise(_ compact: String) -> Bool {
        noiseSignatures.contains { compact.contains($0) }
    }

    private func looksLikeNoisePrefix(_ compact: String) -> Bool {
        noiseSignatures.contains { $0.hasPrefix(compact) }
    }

    private func looksLikeNoiseFragment(_ compact: String) -> Bool {
        noiseSignatures.contains {
            $0.contains(compact) || compact.contains($0)
        }
            || noiseTokens.contains {
                compact.contains($0) || $0.hasPrefix(compact) || compact.hasPrefix($0)
            }
    }

    private func looksLikeNoiseWordSequence(_ snapshot: String) -> Bool {
        let words = snapshot
            .lowercased()
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { !$0.isEmpty }

        guard !words.isEmpty else { return false }

        return words.allSatisfy { word in
            noiseTokens.contains {
                $0 == word
                    || $0.hasPrefix(word)
                    || $0.hasSuffix(word)
                    || word.contains($0)
            } || noiseSignatures.contains {
                $0.contains(word) || word.contains($0)
            }
        }
    }

    private var noiseSignatures: [String] {
        [
            "openaicodex",
            "claudecode",
            "tipnewbuildfasterwiththecodexapp",
            "bootingmcpserver",
            "xcodebuildmcp",
            "tabtoqueuemessage",
            "contextleft",
            "useskillstolistavailableskills",
            "findandfixabuginfilename",
            "explainthiscodebase",
            "gpt54high",
            "directorydesktopprojectopenwork",
        ]
    }

    private var noiseTokens: [String] {
        [
            "boot",
            "booting",
            "mcp",
            "server",
            "xcode",
            "build",
            "codex",
            "context",
            "queue",
            "message",
            "skills",
            "gpt",
        ]
    }
}
