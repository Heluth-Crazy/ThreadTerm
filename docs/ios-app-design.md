# OpenWork iOS App — Technical Design Document

> **Document version:** 1.0
> **Last updated:** 2025-07-17
> **Target:** iOS 17+ / iPadOS 17+
> **Framework:** SwiftUI + Swift Concurrency (async/await)
> **Project name:** OpenWorkMobile
> **Bundle ID:** `com.openwork.mobile`

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Data Models](#2-data-models)
3. [Networking Layer](#3-networking-layer)
4. [Screen-by-Screen Design](#4-screen-by-screen-design)
5. [Gesture Design Document](#5-gesture-design-document)
6. [SwiftUI Code Skeletons](#6-swiftui-code-skeletons)
7. [Xcode Project Setup](#7-xcode-project-setup)
8. [Authentication Flow](#8-authentication-flow)
9. [Terminal Implementation](#9-terminal-implementation)
10. [Implementation Phases](#10-implementation-phases)

---


## 1. Architecture Overview

### 1.1 Technology Choice Rationale

| Decision | Choice | Rationale |
|----------|--------|-----------|
| UI Framework | SwiftUI | Native iOS feel, built-in Dark Mode, Dynamic Type, split view on iPad, declarative state management |
| Networking | URLSession | Built-in async/await, native WebSocket via `URLSessionWebSocketTask`, zero dependencies |
| WebSocket | URLSessionWebSocketTask | Native Apple API, handles ping/pong automatically, supports both text and binary frames |
| Secure Storage | Keychain (Security.framework) | OS-level encryption for tokens and server credentials |
| State Management | `@Observable` (Observation framework) | iOS 17+ macro-based observation, simpler than Combine, native SwiftUI integration |
| Terminal Rendering | Custom `AttributedString` renderer | Lightweight ANSI parser; avoids heavyweight WebView or third-party terminal emulators |
| Dependencies | **None** (Apple frameworks only) | Reduces maintenance burden; `URLSessionWebSocketTask` eliminates need for Starscream |

### 1.2 App Architecture Pattern

**MVVM + Service Layer** using Swift's `@Observable` macro:

```
+-----------------------------------------------------+
|                    SwiftUI Views                     |
|  (ContentView, SessionsListView, ChatView, etc.)    |
+-----------------------------------------------------+
|                   ViewModels                         |
|  (@Observable classes with async methods)            |
+-----------------------------------------------------+
|                  Service Layer                       |
|  OpenWorkAPIClient  |  OpenWorkWebSocket  |  Token   |
|  (REST HTTP)        |  (WebSocket)        |  Storage |
+-----------------------------------------------------+
|               Apple Frameworks                       |
|  URLSession  |  Security (Keychain)  |  Foundation   |
+-----------------------------------------------------+
```

### 1.3 Project Structure

```
OpenWorkMobile/
+-- OpenWorkMobile.xcodeproj
+-- OpenWorkMobile/
|   +-- App/
|   |   +-- OpenWorkMobileApp.swift          # @main entry point
|   |   +-- ContentView.swift                # Root navigation
|   +-- Models/
|   |   +-- ServerConnection.swift
|   |   +-- Project.swift
|   |   +-- Session.swift
|   |   +-- ChatMessage.swift
|   |   +-- WebSocketMessage.swift
|   +-- ViewModels/
|   |   +-- ConnectionViewModel.swift
|   |   +-- ProjectsViewModel.swift
|   |   +-- SessionsViewModel.swift
|   |   +-- ChatViewModel.swift
|   |   +-- TerminalViewModel.swift
|   +-- Views/
|   |   +-- Connection/
|   |   |   +-- ConnectionSetupView.swift
|   |   |   +-- ServerListView.swift
|   |   +-- Projects/
|   |   |   +-- ProjectsListView.swift
|   |   |   +-- ProjectRow.swift
|   |   +-- Sessions/
|   |   |   +-- SessionsListView.swift
|   |   |   +-- SessionRow.swift
|   |   |   +-- NewSessionSheet.swift
|   |   +-- Chat/
|   |   |   +-- ChatView.swift
|   |   |   +-- ChatBubble.swift
|   |   |   +-- ChatInputBar.swift
|   |   |   +-- CommandPickerSheet.swift
|   |   +-- Terminal/
|   |   |   +-- TerminalView.swift
|   |   |   +-- ANSITextRenderer.swift
|   |   +-- Settings/
|   |       +-- SettingsView.swift
|   +-- Services/
|   |   +-- OpenWorkAPIClient.swift
|   |   +-- OpenWorkWebSocket.swift
|   |   +-- TokenStorage.swift
|   +-- Utilities/
|   |   +-- HapticManager.swift
|   |   +-- ANSIParser.swift
|   |   +-- KeychainHelper.swift
|   +-- Extensions/
|   |   +-- Date+Relative.swift
|   |   +-- Color+Theme.swift
|   +-- Resources/
|       +-- Assets.xcassets
|       +-- Localizable.xcstrings
+-- OpenWorkMobileTests/
    +-- APIClientTests.swift
    +-- WebSocketTests.swift
    +-- ModelDecodingTests.swift
```


---

## 2. Data Models

### 2.1 ServerConnection

```swift
import Foundation

struct ServerConnection: Codable, Identifiable, Hashable {
    let id: UUID
    var name: String                    // User-defined label, e.g. "Home Mac"
    var host: String                    // e.g. "192.168.1.42"
    var port: Int                       // default 3001
    var useTLS: Bool                    // false for LAN, true for tunneled
    var token: String                   // JWT from /api/auth/login

    var baseURL: URL {
        let scheme = useTLS ? "https" : "http"
        return URL(string: "\(scheme)://\(host):\(port)")!
    }

    var wsBaseURL: URL {
        let scheme = useTLS ? "wss" : "ws"
        return URL(string: "\(scheme)://\(host):\(port)")!
    }

    init(name: String = "", host: String, port: Int = 3001,
         useTLS: Bool = false, token: String = "") {
        self.id = UUID()
        self.name = name
        self.host = host
        self.port = port
        self.useTLS = useTLS
        self.token = token
    }
}
```

### 2.2 Project

```swift
struct Project: Codable, Identifiable, Hashable {
    let name: String            // Filesystem-safe name used in API paths
    let displayName: String     // Human-readable display name
    let fullPath: String        // Full absolute path on the server
    let path: String?           // Short relative path
    let isGitRepo: Bool?
    let branch: String?
    var sessions: [Session]?
    var codexSessions: [Session]?

    var id: String { name }

    var allSessions: [Session] {
        let claude = (sessions ?? []).map { s in
            var copy = s; copy.provider = .claude; return copy
        }
        let codex = (codexSessions ?? []).map { s in
            var copy = s; copy.provider = .codex; return copy
        }
        return (claude + codex).sorted { $0.effectiveDate > $1.effectiveDate }
    }

    var totalSessionCount: Int {
        (sessions?.count ?? 0) + (codexSessions?.count ?? 0)
    }
}
```

### 2.3 Session

```swift
enum SessionProvider: String, Codable, CaseIterable {
    case claude
    case codex
}

struct Session: Codable, Identifiable, Hashable {
    let id: String
    var title: String?
    var summary: String?
    var name: String?
    var createdAt: String?
    var created_at: String?
    var updated_at: String?
    var lastActivity: String?
    var messageCount: Int?
    var provider: SessionProvider?
    var projectName: String?

    var effectiveDate: Date {
        let dateString = lastActivity ?? updated_at ?? createdAt ?? created_at ?? ""
        return ISO8601DateFormatter().date(from: dateString) ?? .distantPast
    }

    var displayTitle: String {
        title ?? name ?? summary ?? "Session \(id.prefix(8))"
    }

    func hash(into hasher: inout Hasher) { hasher.combine(id) }
    static func == (lhs: Session, rhs: Session) -> Bool { lhs.id == rhs.id }
}
```

### 2.4 ChatMessage

```swift
enum MessageKind: String, Codable {
    case user, assistant, tool, thinking, status, error
}

struct ChatMessage: Codable, Identifiable {
    let id: String
    let kind: MessageKind
    var text: String
    let provider: SessionProvider?
    let timestamp: Date
    var isStreaming: Bool

    init(id: String = UUID().uuidString, kind: MessageKind, text: String,
         provider: SessionProvider? = nil, timestamp: Date = .now,
         isStreaming: Bool = false) {
        self.id = id
        self.kind = kind
        self.text = text
        self.provider = provider
        self.timestamp = timestamp
        self.isStreaming = isStreaming
    }

    var isSent: Bool { kind == .user }
}
```

### 2.5 WebSocket Message Types

```swift
// MARK: - Client -> Server

enum WSClientMessage: Encodable {
    case claudeCommand(command: String, options: WSCommandOptions)
    case codexCommand(command: String, options: WSCommandOptions)
    case abortSession(sessionId: String, provider: SessionProvider?)
    case permissionResponse(requestId: String, allow: Bool)
    case getActiveSessions
    case startWatching(projectPath: String)
    case stopWatching(projectPath: String)

    struct WSCommandOptions: Encodable {
        let projectPath: String?
        let sessionId: String?
        let model: String?
    }

    // Custom Encodable conformance omitted for brevity -- serialize to
    // {"type": "claude-command", "command": "...", "options": {...}}
}

// MARK: - Server -> Client

enum WSServerMessage {
    case text(content: String, sessionId: String?)
    case code(content: String, language: String?, sessionId: String?)
    case thinking(content: String, sessionId: String?)
    case sessionAborted(sessionId: String, provider: String, success: Bool)
    case sessionStatus(sessionId: String, provider: String, isProcessing: Bool)
    case activeSessions(claude: [String], codex: [String])
    case projectsUpdated(projects: [Project])
    case error(message: String)
    case permissionRequest(requestId: String, tool: String?, description: String?)
    case unknown(type: String, raw: [String: Any])

    static func parse(from dict: [String: Any]) -> WSServerMessage {
        guard let type = dict["type"] as? String else {
            return .unknown(type: "missing", raw: dict)
        }
        let sessionId = dict["sessionId"] as? String
        switch type {
        case "text":
            return .text(content: dict["content"] as? String ?? "", sessionId: sessionId)
        case "code":
            return .code(content: dict["content"] as? String ?? "",
                         language: dict["language"] as? String, sessionId: sessionId)
        case "thinking":
            return .thinking(content: dict["content"] as? String ?? "", sessionId: sessionId)
        case "session-aborted":
            return .sessionAborted(sessionId: sessionId ?? "",
                                   provider: dict["provider"] as? String ?? "",
                                   success: dict["success"] as? Bool ?? false)
        case "session-status":
            return .sessionStatus(sessionId: sessionId ?? "",
                                  provider: dict["provider"] as? String ?? "",
                                  isProcessing: dict["isProcessing"] as? Bool ?? false)
        case "active-sessions":
            let sessions = dict["sessions"] as? [String: [String]] ?? [:]
            return .activeSessions(claude: sessions["claude"] ?? [], codex: sessions["codex"] ?? [])
        case "error":
            return .error(message: dict["error"] as? String ?? "Unknown error")
        case "claude-permission-request":
            return .permissionRequest(requestId: dict["requestId"] as? String ?? "",
                                      tool: dict["tool"] as? String,
                                      description: dict["description"] as? String)
        default:
            return .unknown(type: type, raw: dict)
        }
    }
}
```


---

## 3. Networking Layer

### 3.1 OpenWorkAPIClient

```swift
import Foundation

actor OpenWorkAPIClient {
    private let session: URLSession
    private var connection: ServerConnection
    private let decoder: JSONDecoder = {
        let d = JSONDecoder(); d.dateDecodingStrategy = .iso8601; return d
    }()
    private let encoder = JSONEncoder()

    init(connection: ServerConnection) {
        self.connection = connection
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 15
        config.timeoutIntervalForResource = 60
        self.session = URLSession(configuration: config)
    }

    func updateConnection(_ newConnection: ServerConnection) {
        self.connection = newConnection
    }

    // MARK: - Generic Request

    private func request<T: Decodable>(
        _ method: String, path: String,
        body: (any Encodable)? = nil,
        queryItems: [URLQueryItem]? = nil
    ) async throws -> T {
        var url = connection.baseURL.appendingPathComponent(path)
        if let queryItems, !queryItems.isEmpty {
            var components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
            components.queryItems = queryItems
            url = components.url!
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(connection.token)", forHTTPHeaderField: "Authorization")
        if let body { request.httpBody = try encoder.encode(body) }

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        guard (200...299).contains(http.statusCode) else {
            throw APIError.httpError(status: http.statusCode,
                                     body: String(data: data, encoding: .utf8) ?? "")
        }
        return try decoder.decode(T.self, from: data)
    }

    private func requestVoid(_ method: String, path: String,
                             body: (any Encodable)? = nil) async throws {
        let _: EmptyResponse = try await request(method, path: path, body: body)
    }

    // MARK: - Health

    struct HealthResponse: Decodable { let status: String; let timestamp: String }

    func checkHealth() async throws -> HealthResponse {
        let url = connection.baseURL.appendingPathComponent("health")
        var req = URLRequest(url: url); req.httpMethod = "GET"; req.timeoutInterval = 5
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200
        else { throw APIError.connectionFailed }
        return try decoder.decode(HealthResponse.self, from: data)
    }

    // MARK: - Authentication

    struct LoginRequest: Encodable { let username: String; let password: String? }
    struct LoginResponse: Decodable { let success: Bool; let user: UserInfo?; let token: String? }
    struct UserInfo: Decodable { let id: Int; let username: String }

    func login(username: String, password: String? = nil) async throws -> LoginResponse {
        try await request("POST", path: "api/auth/login",
                          body: LoginRequest(username: username, password: password))
    }

    struct AuthStatusResponse: Decodable { let needsSetup: Bool; let isAuthenticated: Bool }
    func authStatus() async throws -> AuthStatusResponse {
        try await request("GET", path: "api/auth/status")
    }

    // MARK: - Projects

    func listProjects() async throws -> [Project] {
        try await request("GET", path: "api/projects")
    }

    func createProject(path: String) async throws -> Project {
        struct Req: Encodable { let path: String }
        struct Res: Decodable { let success: Bool; let project: Project }
        return (try await request("POST", path: "api/projects/create",
                                  body: Req(path: path)) as Res).project
    }

    func deleteProject(_ name: String, force: Bool = false) async throws {
        try requestVoid("DELETE", path: "api/projects/\(name)" + (force ? "?force=true" : ""))
    }

    // MARK: - Sessions

    struct SessionsResponse: Decodable {
        let messages: [Session]; let total: Int?; let hasMore: Bool?
    }

    func listSessions(projectName: String, limit: Int = 20,
                      offset: Int = 0) async throws -> SessionsResponse {
        try await request("GET", path: "api/projects/\(projectName)/sessions",
                          queryItems: [URLQueryItem(name: "limit", value: "\(limit)"),
                                       URLQueryItem(name: "offset", value: "\(offset)")])
    }

    func renameSession(projectName: String, sessionId: String, title: String) async throws {
        struct Req: Encodable { let title: String }
        try requestVoid("PUT",
            path: "api/projects/\(projectName)/sessions/\(sessionId)/rename",
            body: Req(title: title))
    }

    func deleteSession(projectName: String, sessionId: String) async throws {
        try requestVoid("DELETE",
            path: "api/projects/\(projectName)/sessions/\(sessionId)")
    }

    // MARK: - Session Messages

    struct MessagesResponse: Decodable {
        let messages: [HistoryMessage]; let total: Int?; let hasMore: Bool?
    }
    struct HistoryMessage: Decodable, Identifiable {
        let id: String?; let role: String?; let content: String?; let timestamp: String?
        var stableId: String { id ?? UUID().uuidString }
    }

    func getSessionMessages(projectName: String, sessionId: String,
                            limit: Int = 50, offset: Int = 0) async throws -> MessagesResponse {
        try await request("GET",
            path: "api/projects/\(projectName)/sessions/\(sessionId)/messages",
            queryItems: [URLQueryItem(name: "limit", value: "\(limit)"),
                         URLQueryItem(name: "offset", value: "\(offset)")])
    }

    // MARK: - Commands

    struct CommandsResponse: Decodable {
        let builtIn: [SlashCommand]?; let custom: [SlashCommand]?; let count: Int?
    }
    struct SlashCommand: Decodable, Identifiable {
        let name: String; let description: String?; let path: String?
        var id: String { name }
    }

    func listCommands(projectPath: String) async throws -> CommandsResponse {
        struct Req: Encodable { let projectPath: String }
        return try await request("POST", path: "api/commands/list",
                                 body: Req(projectPath: projectPath))
    }

    // MARK: - Errors

    enum APIError: LocalizedError {
        case connectionFailed, invalidResponse
        case httpError(status: Int, body: String)
        var errorDescription: String? {
            switch self {
            case .connectionFailed: return "Cannot connect to server"
            case .invalidResponse: return "Invalid server response"
            case .httpError(let s, let b): return "HTTP \(s): \(b)"
            }
        }
    }
    private struct EmptyResponse: Decodable {}
}
```

### 3.2 OpenWorkWebSocket

```swift
import Foundation

protocol OpenWorkWebSocketDelegate: AnyObject {
    func webSocket(_ ws: OpenWorkWebSocket, didReceive message: WSServerMessage)
    func webSocket(_ ws: OpenWorkWebSocket, didChangeState state: OpenWorkWebSocket.State)
    func webSocket(_ ws: OpenWorkWebSocket, didEncounterError error: Error)
}

final class OpenWorkWebSocket: NSObject, @unchecked Sendable {

    enum State: Equatable {
        case disconnected, connecting, connected, reconnecting(attempt: Int)
    }

    enum Endpoint {
        case chat                          // /ws
        case terminal(sessionId: String)   // /shell
        var path: String {
            switch self { case .chat: return "ws"; case .terminal: return "shell" }
        }
    }

    weak var delegate: OpenWorkWebSocketDelegate?
    private let connection: ServerConnection
    private let endpoint: Endpoint
    private var task: URLSessionWebSocketTask?
    private var urlSession: URLSession?
    private var receiveTask: Task<Void, Never>?
    private(set) var state: State = .disconnected {
        didSet { if oldValue != state { delegate?.webSocket(self, didChangeState: state) } }
    }

    private let maxReconnectAttempts = 10
    private let baseReconnectDelay: TimeInterval = 1.0
    private var reconnectAttempt = 0
    private var reconnectTask: Task<Void, Never>?
    private var intentionalDisconnect = false

    init(connection: ServerConnection, endpoint: Endpoint) {
        self.connection = connection; self.endpoint = endpoint; super.init()
    }
    deinit { disconnect() }

    // MARK: - Connect / Disconnect

    func connect() {
        intentionalDisconnect = false; reconnectAttempt = 0; performConnect()
    }

    func disconnect() {
        intentionalDisconnect = true
        reconnectTask?.cancel(); receiveTask?.cancel()
        task?.cancel(with: .goingAway, reason: nil); task = nil
        state = .disconnected
    }

    private func performConnect() {
        var components = URLComponents()
        components.scheme = connection.useTLS ? "wss" : "ws"
        components.host = connection.host
        components.port = connection.port
        components.path = "/\(endpoint.path)"
        components.queryItems = [URLQueryItem(name: "token", value: connection.token)]
        guard let url = components.url else { return }

        state = reconnectAttempt > 0 ? .reconnecting(attempt: reconnectAttempt) : .connecting
        let config = URLSessionConfiguration.default
        urlSession = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        var request = URLRequest(url: url)
        request.setValue("Bearer \(connection.token)", forHTTPHeaderField: "Authorization")
        task = urlSession?.webSocketTask(with: request)
        task?.resume()
        startReceiving()
    }

    // MARK: - Send

    func send(_ message: WSClientMessage) {
        guard let task, state == .connected else { return }
        guard let data = try? JSONEncoder().encode(message),
              let str = String(data: data, encoding: .utf8) else { return }
        task.send(.string(str)) { [weak self] error in
            if let error, let self { self.delegate?.webSocket(self, didEncounterError: error) }
        }
    }

    func sendRaw(_ text: String) {
        guard let task, state == .connected else { return }
        task.send(.string(text)) { _ in }
    }

    func sendJSON(_ dict: [String: Any]) {
        guard let task, state == .connected,
              let data = try? JSONSerialization.data(withJSONObject: dict),
              let str = String(data: data, encoding: .utf8) else { return }
        task.send(.string(str)) { _ in }
    }

    // MARK: - Receive

    private func startReceiving() {
        receiveTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, let task = self.task else { break }
                do {
                    let msg = try await task.receive()
                    self.handleMessage(msg)
                } catch {
                    if !Task.isCancelled && !self.intentionalDisconnect {
                        self.handleDisconnect(error: error)
                    }
                    break
                }
            }
        }
    }

    private func handleMessage(_ message: URLSessionWebSocketTask.Message) {
        switch message {
        case .string(let text):
            guard let data = text.data(using: .utf8),
                  let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { return }
            delegate?.webSocket(self, didReceive: WSServerMessage.parse(from: dict))
        case .data(let data):
            if let text = String(data: data, encoding: .utf8) {
                delegate?.webSocket(self, didReceive: .text(content: text, sessionId: nil))
            }
        @unknown default: break
        }
    }

    // MARK: - Reconnection

    private func handleDisconnect(error: Error?) {
        state = .disconnected
        guard !intentionalDisconnect, reconnectAttempt < maxReconnectAttempts else { return }
        reconnectAttempt += 1
        let delay = min(baseReconnectDelay * pow(2, Double(reconnectAttempt - 1)), 30.0)
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            self?.performConnect()
        }
    }
}

extension OpenWorkWebSocket: URLSessionWebSocketDelegate {
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didOpenWithProtocol protocol: String?) {
        state = .connected; reconnectAttempt = 0
    }
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        if !intentionalDisconnect { handleDisconnect(error: nil) }
    }
}
```

### 3.3 TokenStorage (Keychain)

```swift
import Foundation
import Security

final class TokenStorage {
    static let shared = TokenStorage()
    private let serviceKey = "com.openwork.mobile.servers"
    private let activeServerKey = "com.openwork.mobile.activeServer"
    private init() {}

    func saveConnections(_ connections: [ServerConnection]) throws {
        let data = try JSONEncoder().encode(connections)
        try saveToKeychain(data: data, key: serviceKey)
    }

    func loadConnections() -> [ServerConnection] {
        guard let data = loadFromKeychain(key: serviceKey),
              let conns = try? JSONDecoder().decode([ServerConnection].self, from: data)
        else { return [] }
        return conns
    }

    func saveActiveServerID(_ id: UUID) {
        UserDefaults.standard.set(id.uuidString, forKey: activeServerKey)
    }

    func loadActiveServerID() -> UUID? {
        guard let s = UserDefaults.standard.string(forKey: activeServerKey) else { return nil }
        return UUID(uuidString: s)
    }

    func clearAll() {
        deleteFromKeychain(key: serviceKey)
        UserDefaults.standard.removeObject(forKey: activeServerKey)
    }

    private func saveToKeychain(data: Data, key: String) throws {
        deleteFromKeychain(key: key)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: key,
            kSecAttrAccount as String: "OpenWorkMobile",
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock
        ]
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError.saveFailed(status) }
    }

    private func loadFromKeychain(key: String) -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: key,
            kSecAttrAccount as String: "OpenWorkMobile",
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: AnyObject?
        return SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess
            ? result as? Data : nil
    }

    private func deleteFromKeychain(key: String) {
        SecItemDelete([kSecClass as String: kSecClassGenericPassword,
                       kSecAttrService as String: key,
                       kSecAttrAccount as String: "OpenWorkMobile"] as CFDictionary)
    }

    enum KeychainError: LocalizedError {
        case saveFailed(OSStatus)
        var errorDescription: String? { "Keychain save failed" }
    }
}
```


---

## 4. Screen-by-Screen Design

### 4.1 Connection Setup Screen

**Purpose:** First-run and server management. User enters server URL + credentials.

**ViewModel:** `ConnectionViewModel` (see Section 6.3 for full code)

| Gesture | Action |
|---------|--------|
| Tap "Test Connection" | Calls `GET /health`, shows success/failure indicator |
| Tap "Connect" | Calls `POST /api/auth/login`, saves token to Keychain |
| Swipe left on saved server | Delete the server connection |
| Tap saved server row | Switch to that server |

### 4.2 Projects + Sessions List (Main Screen)

**Purpose:** Primary navigation. Shows projects with expandable session lists.

**ViewModel:** `ProjectsViewModel` (see Section 6.4 for full code)

| Gesture | Action |
|---------|--------|
| Pull down | Refresh projects list |
| Tap project row | Expand/collapse session list |
| Tap session row | Navigate to ChatView |
| Swipe left on session | Delete session (confirmation alert) |
| Swipe right on session | Pin session (blue button) |
| Long press session | Context menu: Rename, Copy ID, Delete |
| Tap filter pill (Claude/Codex/All) | Filter sessions by provider |
| Tap "+" button | Present NewSessionSheet as half-sheet |

### 4.3 Chat Screen

**Purpose:** Real-time conversation with Claude or Codex via WebSocket.

**ViewModel:** `ChatViewModel` (see Section 6.5 for full code)

| Gesture | Action |
|---------|--------|
| Tap Send button | Send message via WebSocket |
| Cmd+Return (hardware keyboard) | Send message |
| Tap Stop button (during streaming) | Abort current session |
| Cmd+K | Show command picker sheet |
| Swipe down on sheet | Dismiss command picker |
| Tap command in picker | Insert command into input |
| Tap "Allow" / "Deny" | Respond to permission request |
| Long press on message | Copy text, Share |
| Scroll up | Load older messages (pagination) |

### 4.4 Terminal Screen

**Purpose:** Full PTY terminal connected to a session via WebSocket.

**ViewModel:** `TerminalViewModel` (see Section 6.6 for full code)

| Gesture | Action |
|---------|--------|
| Hardware keyboard input | Sent to PTY as raw keystrokes |
| Pinch | Adjust font size |
| Two-finger scroll | Scroll terminal buffer |
| Swipe from left edge | Back navigation |
| Cmd+C | Copy selected text |
| Cmd+V | Paste into PTY |

### 4.5 iPad Split View Layout

On iPad, the app uses `NavigationSplitView` with two columns:

- **Left column (sidebar):** Projects list with expandable sessions
- **Right column (detail):** Chat or Terminal view

The `ContentView` detects `horizontalSizeClass` to switch between:
- **iPhone:** `TabView` with Projects, Sessions, and Settings tabs
- **iPad:** `NavigationSplitView` with sidebar + detail

See Section 6.2 for full `ContentView` implementation.


---

## 5. Gesture Design Document

### 5.1 Complete Gesture Table

| Screen | Gesture | Target | Action | Haptic |
|--------|---------|--------|--------|--------|
| **Connection** | Tap | "Test Connection" | Call `GET /health` | -- |
| **Connection** | Tap | "Connect" | Login + save to Keychain | success / error |
| **Connection** | Swipe left | Saved server row | Delete server | -- |
| **Connection** | Tap | Saved server row | Switch active server | light |
| **Projects** | Pull down | List | Refresh project list | -- |
| **Projects** | Tap | Project row | Expand/collapse sessions | light |
| **Projects** | Tap | Session row | Navigate to Chat | -- |
| **Sessions** | Swipe left | Session row | Delete button (red) | -- |
| **Sessions** | Swipe right | Session row | Pin session (blue) | medium |
| **Sessions** | Long press | Session row | Context menu: Rename, Copy ID, Delete | rigid |
| **Sessions** | Tap | Filter chip | Filter session list | selection |
| **Sessions** | Tap | "+" button | Present NewSessionSheet | -- |
| **Chat** | Tap | Send button | Send message | medium |
| **Chat** | Cmd+Return | Hardware keyboard | Send message | medium |
| **Chat** | Tap | Stop button | Abort streaming | warning |
| **Chat** | Cmd+K | Hardware keyboard | Show command picker | -- |
| **Chat** | Swipe down | Sheet | Dismiss command picker | -- |
| **Chat** | Tap | Command in picker | Insert command | selection |
| **Chat** | Long press | Message bubble | Context menu: Copy, Share | -- |
| **Chat** | Tap | "Allow" / "Deny" | Respond to permission | success / -- |
| **Chat** | Scroll up | Message list | Load older messages | -- |
| **Terminal** | Hardware keys | Terminal view | Send keystrokes to PTY | -- |
| **Terminal** | Pinch | Terminal view | Adjust font size | -- |
| **Terminal** | Cmd+C | Hardware keyboard | Copy selection | -- |
| **Terminal** | Cmd+V | Hardware keyboard | Paste into PTY | -- |
| **Terminal** | Two-finger scroll | Terminal view | Scroll buffer | -- |
| **Global** | Swipe from left edge | Navigation | Pop back (iOS native) | -- |
| **iPad** | Drag divider | Split view | Resize sidebar/detail | -- |

### 5.2 Haptic Feedback Implementation

```swift
import UIKit

final class HapticManager {
    static let shared = HapticManager()
    private init() {}

    private let impact = UIImpactFeedbackGenerator(style: .medium)
    private let notification = UINotificationFeedbackGenerator()
    private let selectionGen = UISelectionFeedbackGenerator()

    func send()      { impact.impactOccurred() }
    func success()   { notification.notificationOccurred(.success) }
    func error()     { notification.notificationOccurred(.error) }
    func warning()   { notification.notificationOccurred(.warning) }
    func selection() { selectionGen.selectionChanged() }
    func light()     { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
    func rigid()     { UIImpactFeedbackGenerator(style: .rigid).impactOccurred() }
}
```


---

## 6. SwiftUI Code Skeletons

### 6.1 OpenWorkMobileApp.swift

```swift
import SwiftUI

@main
struct OpenWorkMobileApp: App {
    @State private var appState = AppState()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(appState)
        }
    }
}

@Observable
final class AppState {
    var activeConnection: ServerConnection?
    var savedConnections: [ServerConnection] = []
    var isConnected = false
    var apiClient: OpenWorkAPIClient?
    var chatWebSocket: OpenWorkWebSocket?

    init() {
        savedConnections = TokenStorage.shared.loadConnections()
        if let activeID = TokenStorage.shared.loadActiveServerID(),
           let conn = savedConnections.first(where: { $0.id == activeID }) {
            activateConnection(conn)
        }
    }

    func activateConnection(_ connection: ServerConnection) {
        activeConnection = connection
        apiClient = OpenWorkAPIClient(connection: connection)
        chatWebSocket?.disconnect()
        chatWebSocket = OpenWorkWebSocket(connection: connection, endpoint: .chat)
        chatWebSocket?.connect()
        isConnected = true
        TokenStorage.shared.saveActiveServerID(connection.id)
    }

    func disconnect() {
        chatWebSocket?.disconnect(); chatWebSocket = nil
        apiClient = nil; activeConnection = nil; isConnected = false
    }

    func addConnection(_ conn: ServerConnection) {
        savedConnections.append(conn)
        try? TokenStorage.shared.saveConnections(savedConnections)
    }

    func removeConnection(_ id: UUID) {
        savedConnections.removeAll { $0.id == id }
        try? TokenStorage.shared.saveConnections(savedConnections)
        if activeConnection?.id == id { disconnect() }
    }
}
```

### 6.2 ContentView.swift

```swift
import SwiftUI

struct ContentView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        Group {
            if appState.isConnected {
                if sizeClass == .regular { iPadLayout } else { iPhoneLayout }
            } else {
                ConnectionSetupView()
            }
        }
    }

    // iPhone: Tab-based navigation
    private var iPhoneLayout: some View {
        TabView {
            Tab("Projects", systemImage: "folder.fill") {
                NavigationStack { ProjectsListView() }
            }
            Tab("Sessions", systemImage: "bubble.left.and.bubble.right.fill") {
                NavigationStack { SessionsListView() }
            }
            Tab("Settings", systemImage: "gearshape.fill") {
                NavigationStack { SettingsView() }
            }
        }
    }

    // iPad: Split view
    @State private var selectedProject: Project?
    @State private var selectedSession: Session?

    private var iPadLayout: some View {
        NavigationSplitView(columnVisibility: .constant(.all)) {
            ProjectsListView(onSelectSession: { project, session in
                selectedProject = project
                selectedSession = session
            })
            .navigationSplitViewColumnWidth(min: 280, ideal: 320, max: 400)
        } detail: {
            if let project = selectedProject, let session = selectedSession {
                ChatView(session: session, project: project)
            } else {
                ContentUnavailableView("Select a Session",
                    systemImage: "bubble.left.and.text.bubble.right",
                    description: Text("Choose a session from the sidebar to start chatting"))
            }
        }
    }
}
```

### 6.3 ConnectionSetupView.swift

```swift
import SwiftUI

struct ConnectionSetupView: View {
    @Environment(AppState.self) private var appState
    @State private var viewModel = ConnectionViewModel()
    @FocusState private var focusedField: Field?

    enum Field: Hashable { case host, port, name, username, password }

    var body: some View {
        NavigationStack {
            Form {
                if !viewModel.savedConnections.isEmpty {
                    Section("Saved Servers") {
                        ForEach(viewModel.savedConnections) { conn in
                            Button {
                                appState.activateConnection(conn)
                            } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(conn.name.isEmpty ? conn.host : conn.name).font(.headline)
                                        Text("\(conn.host):\(conn.port)").font(.caption).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Image(systemName: "chevron.right").foregroundStyle(.tertiary)
                                }
                            }.tint(.primary)
                        }
                        .onDelete { indices in
                            for i in indices { viewModel.deleteConnection(viewModel.savedConnections[i].id) }
                        }
                    }
                }

                Section("Server") {
                    TextField("Name (optional)", text: $viewModel.serverName)
                        .focused($focusedField, equals: .name)
                    TextField("Host (e.g., 192.168.1.42)", text: $viewModel.serverHost)
                        .focused($focusedField, equals: .host)
                        .keyboardType(.URL).autocapitalization(.none)
                    TextField("Port", text: $viewModel.serverPort)
                        .focused($focusedField, equals: .port).keyboardType(.numberPad)
                }

                Section("Authentication") {
                    TextField("Username", text: $viewModel.username)
                        .focused($focusedField, equals: .username).autocapitalization(.none)
                    SecureField("Password (optional)", text: $viewModel.password)
                        .focused($focusedField, equals: .password)
                }

                if let result = viewModel.connectionTestResult {
                    Section {
                        switch result {
                        case .success:
                            Label("Server reachable", systemImage: "checkmark.circle.fill")
                                .foregroundStyle(.green)
                        case .authRequired:
                            Label("Authentication required", systemImage: "lock.fill")
                                .foregroundStyle(.orange)
                        case .failed(let msg):
                            Label(msg, systemImage: "xmark.circle.fill").foregroundStyle(.red)
                        }
                    }
                }

                Section {
                    Button {
                        Task { await viewModel.testConnection() }
                    } label: {
                        HStack {
                            Label("Test Connection", systemImage: "antenna.radiowaves.left.and.right")
                            if viewModel.isTestingConnection { Spacer(); ProgressView() }
                        }
                    }.disabled(viewModel.serverHost.isEmpty || viewModel.isTestingConnection)

                    Button {
                        Task {
                            await viewModel.loginAndSave()
                            if let conn = viewModel.savedConnections.last {
                                appState.addConnection(conn)
                                appState.activateConnection(conn)
                            }
                        }
                    } label: {
                        HStack {
                            Label("Connect & Save", systemImage: "checkmark.circle.fill")
                            if viewModel.isTestingConnection { Spacer(); ProgressView() }
                        }
                    }
                    .disabled(viewModel.serverHost.isEmpty || viewModel.username.isEmpty)
                    .tint(.green)
                }

                if let error = viewModel.error {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Connect to OpenWork")
            .navigationBarTitleDisplayMode(.large)
        }
    }
}
```

### 6.4 SessionsListView.swift

```swift
import SwiftUI

struct SessionsListView: View {
    @Environment(AppState.self) private var appState
    @State private var viewModel = ProjectsViewModel()
    @State private var selectedFilter: SessionProvider?
    @State private var showNewSession = false
    @State private var renameText = ""; @State private var showRenameAlert = false
    @State private var sessionToRename: (Session, Project)?

    var body: some View {
        List {
            // Filter chips
            Section {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        FilterChip(title: "All", isActive: selectedFilter == nil) {
                            selectedFilter = nil; HapticManager.shared.selection()
                        }
                        FilterChip(title: "Claude", isActive: selectedFilter == .claude) {
                            selectedFilter = .claude; HapticManager.shared.selection()
                        }
                        FilterChip(title: "Codex", isActive: selectedFilter == .codex) {
                            selectedFilter = .codex; HapticManager.shared.selection()
                        }
                    }.padding(.horizontal).padding(.vertical, 8)
                }
            }.listRowBackground(Color.clear).listRowInsets(EdgeInsets())

            // Sessions grouped by project
            ForEach(viewModel.filteredProjects) { project in
                Section(project.displayName) {
                    ForEach(filteredSessions(for: project)) { session in
                        NavigationLink(value: SessionNavigation(session: session, project: project)) {
                            SessionRow(session: session)
                        }
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            Button(role: .destructive) {
                                Task { await viewModel.deleteSession(projectName: project.name,
                                                                     sessionId: session.id) }
                            } label: { Label("Delete", systemImage: "trash") }
                        }
                        .swipeActions(edge: .leading) {
                            Button { HapticManager.shared.send() } label: {
                                Label("Pin", systemImage: "pin")
                            }.tint(.blue)
                        }
                        .contextMenu {
                            Button {
                                sessionToRename = (session, project)
                                renameText = session.displayTitle; showRenameAlert = true
                            } label: { Label("Rename", systemImage: "pencil") }
                            Button {
                                UIPasteboard.general.string = session.id
                                HapticManager.shared.selection()
                            } label: { Label("Copy Session ID", systemImage: "doc.on.doc") }
                            Divider()
                            Button(role: .destructive) {
                                Task { await viewModel.deleteSession(projectName: project.name,
                                                                     sessionId: session.id) }
                            } label: { Label("Delete", systemImage: "trash") }
                        }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Sessions")
        .navigationDestination(for: SessionNavigation.self) { nav in
            ChatView(session: nav.session, project: nav.project)
        }
        .refreshable { await viewModel.loadProjects() }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { showNewSession = true } label: { Image(systemName: "plus") }
            }
        }
        .sheet(isPresented: $showNewSession) { NewSessionSheet() }
        .alert("Rename Session", isPresented: $showRenameAlert) {
            TextField("New name", text: $renameText)
            Button("Cancel", role: .cancel) {}
            Button("Rename") {
                if let (session, project) = sessionToRename {
                    Task { await viewModel.renameSession(projectName: project.name,
                                                         sessionId: session.id, newTitle: renameText) }
                }
            }
        }
        .task { viewModel.configure(client: appState.apiClient!); await viewModel.loadProjects() }
    }

    private func filteredSessions(for project: Project) -> [Session] {
        guard let filter = selectedFilter else { return project.allSessions }
        return project.allSessions.filter { $0.provider == filter }
    }
}

// Supporting views
struct SessionNavigation: Hashable { let session: Session; let project: Project }

struct SessionRow: View {
    let session: Session
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(session.displayTitle).font(.body).lineLimit(1)
                Spacer()
                ProviderBadge(provider: session.provider ?? .claude)
            }
            if let summary = session.summary {
                Text(summary).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
            Text(session.effectiveDate, style: .relative).font(.caption2).foregroundStyle(.tertiary)
        }.padding(.vertical, 2)
    }
}

struct ProviderBadge: View {
    let provider: SessionProvider
    var body: some View {
        Text(provider.rawValue.capitalized)
            .font(.caption2.bold()).padding(.horizontal, 6).padding(.vertical, 2)
            .background(provider == .claude ? Color.purple.opacity(0.15) : Color.green.opacity(0.15))
            .foregroundStyle(provider == .claude ? .purple : .green)
            .clipShape(Capsule())
    }
}

struct FilterChip: View {
    let title: String; let isActive: Bool; let action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(title).font(.subheadline.weight(.medium))
                .padding(.horizontal, 16).padding(.vertical, 8)
                .background(isActive ? Color.accentColor : Color(.secondarySystemBackground))
                .foregroundStyle(isActive ? .white : .primary)
                .clipShape(Capsule())
        }.buttonStyle(.plain)
    }
}
```

### 6.5 ChatView.swift + ChatViewModel.swift

```swift
// ChatViewModel.swift
import Foundation

@Observable
final class ChatViewModel {
    var messages: [ChatMessage] = []
    var inputText = ""
    var isProcessing = false
    var error: String?
    var pendingPermission: PermissionRequest?

    let session: Session
    let project: Project
    let provider: SessionProvider

    struct PermissionRequest: Identifiable {
        let id: String; let tool: String?; let description: String?
    }

    private var webSocket: OpenWorkWebSocket?
    private var apiClient: OpenWorkAPIClient?

    init(session: Session, project: Project) {
        self.session = session; self.project = project
        self.provider = session.provider ?? .claude
    }

    func configure(client: OpenWorkAPIClient, webSocket: OpenWorkWebSocket) {
        self.apiClient = client; self.webSocket = webSocket
        webSocket.delegate = self
    }

    func loadHistory() async {
        guard let client = apiClient else { return }
        do {
            let response = try await client.getSessionMessages(
                projectName: project.name, sessionId: session.id)
            messages = response.messages.compactMap { msg in
                guard let content = msg.content, !content.isEmpty else { return nil }
                return ChatMessage(id: msg.stableId,
                    kind: msg.role == "user" ? .user : .assistant,
                    text: content, provider: provider)
            }
        } catch { self.error = error.localizedDescription }
    }

    func sendMessage() {
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        messages.append(ChatMessage(kind: .user, text: text, provider: provider))
        inputText = ""; isProcessing = true
        HapticManager.shared.send()

        let opts = WSClientMessage.WSCommandOptions(
            projectPath: project.fullPath, sessionId: session.id, model: nil)
        switch provider {
        case .claude: webSocket?.send(.claudeCommand(command: text, options: opts))
        case .codex:  webSocket?.send(.codexCommand(command: text, options: opts))
        }
    }

    func abortSession() {
        webSocket?.send(.abortSession(sessionId: session.id, provider: provider))
        isProcessing = false
    }

    func respondToPermission(allow: Bool) {
        guard let perm = pendingPermission else { return }
        webSocket?.send(.permissionResponse(requestId: perm.id, allow: allow))
        pendingPermission = nil
        if allow { HapticManager.shared.success() }
    }
}

extension ChatViewModel: OpenWorkWebSocketDelegate {
    func webSocket(_ ws: OpenWorkWebSocket, didReceive message: WSServerMessage) {
        Task { @MainActor in
            switch message {
            case .text(let content, let sid) where sid == session.id || sid == nil:
                appendStreaming(content: content, kind: .assistant)
            case .code(let content, _, let sid) where sid == session.id || sid == nil:
                appendStreaming(content: "```\n\(content)\n```", kind: .assistant)
            case .thinking(let content, let sid) where sid == session.id || sid == nil:
                appendStreaming(content: content, kind: .thinking)
            case .sessionAborted(let sid, _, _) where sid == session.id:
                isProcessing = false
            case .sessionStatus(let sid, _, let p) where sid == session.id:
                isProcessing = p
            case .permissionRequest(let rid, let tool, let desc):
                pendingPermission = PermissionRequest(id: rid, tool: tool, description: desc)
                HapticManager.shared.warning()
            case .error(let msg):
                messages.append(ChatMessage(kind: .error, text: msg, provider: provider))
                isProcessing = false; HapticManager.shared.error()
            default: break
            }
        }
    }

    func webSocket(_ ws: OpenWorkWebSocket, didChangeState state: OpenWorkWebSocket.State) {}
    func webSocket(_ ws: OpenWorkWebSocket, didEncounterError error: Error) {
        Task { @MainActor in self.error = error.localizedDescription }
    }

    @MainActor private func appendStreaming(content: String, kind: MessageKind) {
        if let last = messages.last, last.kind == kind, last.isStreaming {
            messages[messages.count - 1].text += content
        } else {
            if let i = messages.indices.last, messages[i].isStreaming { messages[i].isStreaming = false }
            messages.append(ChatMessage(kind: kind, text: content, provider: provider, isStreaming: true))
        }
    }
}
```

```swift
// ChatView.swift
import SwiftUI

struct ChatView: View {
    @Environment(AppState.self) private var appState
    @State private var viewModel: ChatViewModel
    @State private var showCommandPicker = false
    @FocusState private var isInputFocused: Bool
    let session: Session; let project: Project

    init(session: Session, project: Project) {
        self.session = session; self.project = project
        self._viewModel = State(initialValue: ChatViewModel(session: session, project: project))
    }

    var body: some View {
        VStack(spacing: 0) {
            // Messages
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 12) {
                        ForEach(viewModel.messages) { msg in
                            ChatBubble(message: msg).id(msg.id)
                                .contextMenu {
                                    Button { UIPasteboard.general.string = msg.text } label: {
                                        Label("Copy", systemImage: "doc.on.doc")
                                    }
                                    ShareLink(item: msg.text) {
                                        Label("Share", systemImage: "square.and.arrow.up")
                                    }
                                }
                        }
                    }.padding()
                }.onChange(of: viewModel.messages.count) { _, _ in
                    if let id = viewModel.messages.last?.id {
                        withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(id, anchor: .bottom) }
                    }
                }
            }

            // Permission banner
            if let perm = viewModel.pendingPermission {
                VStack(spacing: 8) {
                    HStack {
                        Image(systemName: "exclamationmark.shield.fill").foregroundStyle(.orange)
                        VStack(alignment: .leading) {
                            Text("Permission Required").font(.subheadline.bold())
                            if let tool = perm.tool { Text(tool).font(.caption).foregroundStyle(.secondary) }
                        }; Spacer()
                    }
                    HStack(spacing: 12) {
                        Button("Deny") { viewModel.respondToPermission(allow: false) }.buttonStyle(.bordered)
                        Button("Allow") { viewModel.respondToPermission(allow: true) }.buttonStyle(.borderedProminent)
                    }
                }.padding().background(Color(.secondarySystemBackground))
            }

            // Input bar
            HStack(alignment: .bottom, spacing: 8) {
                Button { showCommandPicker = true } label: {
                    Image(systemName: "slash.circle").font(.title2).foregroundStyle(.secondary)
                }
                TextField("Message...", text: $viewModel.inputText, axis: .vertical)
                    .textFieldStyle(.plain).lineLimit(1...6).focused($isInputFocused)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(Color(.secondarySystemBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 20))
                    .onKeyPress(.return, phases: .down) { press in
                        if press.modifiers.contains(.command) { viewModel.sendMessage(); return .handled }
                        return .ignored
                    }

                if viewModel.isProcessing {
                    Button { viewModel.abortSession() } label: {
                        Image(systemName: "stop.circle.fill").font(.title2).foregroundStyle(.red)
                    }
                } else {
                    Button { viewModel.sendMessage() } label: {
                        Image(systemName: "arrow.up.circle.fill").font(.title2)
                            .foregroundStyle(viewModel.inputText.isEmpty ? .gray : .accentColor)
                    }.disabled(viewModel.inputText.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }.padding(.horizontal, 12).padding(.vertical, 8).background(.bar)
        }
        .navigationTitle(session.displayTitle).navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showCommandPicker) {
            CommandPickerSheet(onSelect: { cmd in
                viewModel.inputText += "/\(cmd) "; showCommandPicker = false; isInputFocused = true
            }).presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
        }
        .task {
            if let c = appState.apiClient, let ws = appState.chatWebSocket {
                viewModel.configure(client: c, webSocket: ws)
            }
            await viewModel.loadHistory()
        }
    }
}

struct ChatBubble: View {
    let message: ChatMessage
    var body: some View {
        HStack {
            if message.isSent { Spacer(minLength: 60) }
            VStack(alignment: message.isSent ? .trailing : .leading, spacing: 4) {
                if message.kind == .thinking {
                    Label("Thinking", systemImage: "brain").font(.caption2).foregroundStyle(.secondary)
                } else if message.kind == .error {
                    Label("Error", systemImage: "exclamationmark.triangle.fill")
                        .font(.caption2).foregroundStyle(.red)
                }
                Text(message.text)
                    .font(message.kind == .thinking ? .caption.italic() : .body)
                    .textSelection(.enabled)
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .foregroundStyle(message.isSent ? .white : .primary)
                    .background(bubbleColor).clipShape(RoundedRectangle(cornerRadius: 18))
                if message.isStreaming {
                    HStack(spacing: 4) {
                        ProgressView().scaleEffect(0.6)
                        Text("Streaming...").font(.caption2).foregroundStyle(.secondary)
                    }
                }
                Text(message.timestamp, style: .time).font(.caption2).foregroundStyle(.tertiary)
            }
            if !message.isSent { Spacer(minLength: 60) }
        }
    }

    private var bubbleColor: Color {
        if message.isSent { return .accentColor }
        if message.kind == .error { return .red.opacity(0.15) }
        if message.kind == .thinking { return .purple.opacity(0.1) }
        return Color(.secondarySystemBackground)
    }
}
```

### 6.6 TerminalView.swift + TerminalViewModel.swift

```swift
// TerminalViewModel.swift
@Observable
final class TerminalViewModel {
    var terminalLines: [AttributedString] = []
    var rawBuffer = ""
    var isConnected = false
    var columns = 80; var rows = 24
    private var webSocket: OpenWorkWebSocket?
    private let ansiParser = ANSIParser()
    let session: Session; let project: Project

    init(session: Session, project: Project) {
        self.session = session; self.project = project
    }

    func connect(using connection: ServerConnection) {
        webSocket = OpenWorkWebSocket(connection: connection, endpoint: .terminal(sessionId: session.id))
        webSocket?.delegate = self; webSocket?.connect()
    }

    func disconnect() { webSocket?.disconnect(); webSocket = nil }

    func sendInit() {
        webSocket?.sendJSON(["type": "init", "projectPath": project.fullPath,
                             "sessionId": session.id, "sessionMode": "resume",
                             "provider": session.provider?.rawValue ?? "claude",
                             "rows": rows, "cols": columns])
    }

    func sendInput(_ text: String) {
        webSocket?.sendJSON(["type": "input", "data": text])
    }

    func sendResize(cols: Int, rows: Int) {
        self.columns = cols; self.rows = rows
        webSocket?.sendJSON(["type": "resize", "cols": cols, "rows": rows])
    }
}

extension TerminalViewModel: OpenWorkWebSocketDelegate {
    func webSocket(_ ws: OpenWorkWebSocket, didReceive message: WSServerMessage) {
        Task { @MainActor in
            if case .text(let content, _) = message {
                rawBuffer += content; terminalLines = ansiParser.parse(rawBuffer)
            }
        }
    }
    func webSocket(_ ws: OpenWorkWebSocket, didChangeState state: OpenWorkWebSocket.State) {
        Task { @MainActor in
            isConnected = (state == .connected)
            if state == .connected { sendInit() }
        }
    }
    func webSocket(_ ws: OpenWorkWebSocket, didEncounterError error: Error) {}
}
```

```swift
// TerminalView.swift
import SwiftUI

struct TerminalView: View {
    @Environment(AppState.self) private var appState
    @State private var viewModel: TerminalViewModel
    @State private var fontSize: CGFloat = 14
    @FocusState private var isTerminalFocused: Bool
    let session: Session; let project: Project

    init(session: Session, project: Project) {
        self.session = session; self.project = project
        self._viewModel = State(initialValue: TerminalViewModel(session: session, project: project))
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            GeometryReader { geo in
                let charW: CGFloat = fontSize * 0.6
                let lineH: CGFloat = fontSize * 1.2
                let cols = Int(geo.size.width / charW)
                let rows = Int(geo.size.height / lineH)

                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(Array(viewModel.terminalLines.enumerated()), id: \.offset) { i, line in
                                Text(line)
                                    .font(.system(size: fontSize, weight: .regular, design: .monospaced))
                                    .foregroundStyle(.white).textSelection(.enabled).id(i)
                            }
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }.onChange(of: viewModel.terminalLines.count) { _, _ in
                        if let last = viewModel.terminalLines.indices.last {
                            proxy.scrollTo(last, anchor: .bottom)
                        }
                    }
                }
                .padding(8)
                .onChange(of: geo.size) { _, _ in viewModel.sendResize(cols: cols, rows: rows) }
                .onAppear { viewModel.sendResize(cols: cols, rows: rows) }
            }
        }
        .navigationTitle("Terminal").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                HStack(spacing: 12) {
                    Circle().fill(viewModel.isConnected ? .green : .red).frame(width: 8, height: 8)
                    Button { fontSize = max(8, fontSize - 1) } label: {
                        Image(systemName: "textformat.size.smaller")
                    }
                    Button { fontSize = min(24, fontSize + 1) } label: {
                        Image(systemName: "textformat.size.larger")
                    }
                }
            }
        }
        .focusable().focused($isTerminalFocused)
        .onKeyPress { press in handleKeyPress(press) }
        .gesture(MagnifyGesture().onChanged { v in fontSize = min(max(8, 14 * v.magnification), 28) })
        .task { if let c = appState.activeConnection { viewModel.connect(using: c) }; isTerminalFocused = true }
        .onDisappear { viewModel.disconnect() }
    }

    private func handleKeyPress(_ press: KeyPress) -> KeyPress.Result {
        var input = press.characters
        if press.key == .return { input = "\r" }
        else if press.key == .delete { input = "\u{7F}" }
        else if press.key == .escape { input = "\u{1B}" }
        else if press.key == .upArrow { input = "\u{1B}[A" }
        else if press.key == .downArrow { input = "\u{1B}[B" }
        else if press.key == .rightArrow { input = "\u{1B}[C" }
        else if press.key == .leftArrow { input = "\u{1B}[D" }
        else if press.key == .tab { input = "\t" }

        if press.modifiers.contains(.control), let c = press.characters.first, let a = c.asciiValue {
            input = String(UnicodeScalar(a - 96))
        }
        viewModel.sendInput(input)
        return .handled
    }
}
```


---

## 7. Xcode Project Setup

### 7.1 Project Configuration

| Setting | Value |
|---------|-------|
| Project name | `OpenWorkMobile` |
| Bundle ID | `com.openwork.mobile` |
| Deployment target | iOS 17.0 |
| Swift version | 5.9+ |
| Supported destinations | iPhone, iPad |
| Device orientation | All (iPhone portrait + landscape, iPad all) |
| Frameworks | SwiftUI, Foundation, Security, UIKit (for haptics) |
| External dependencies | **None** |

### 7.2 Xcode Creation Steps

1. **File > New > Project > iOS > App**
2. Product Name: `OpenWorkMobile`
3. Team: *(your Apple Developer team)*
4. Organization Identifier: `com.openwork`
5. Interface: **SwiftUI**
6. Language: **Swift**
7. Storage: **None**

### 7.3 Capabilities to Enable

| Capability | Reason |
|------------|--------|
| **Keychain Sharing** | Store tokens securely |
| **Background Modes > Background fetch** | Keep WebSocket alive when backgrounded briefly |

### 7.4 Info.plist Entries

```xml
<!-- Allow local network access for LAN discovery -->
<key>NSLocalNetworkUsageDescription</key>
<string>OpenWork needs local network access to connect to your Mac.</string>

<!-- Allow HTTP (non-TLS) connections to LAN servers -->
<key>NSAppTransportSecurity</key>
<dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
</dict>

<!-- Bonjour services for future auto-discovery -->
<key>NSBonjourServices</key>
<array>
    <string>_openwork._tcp</string>
</array>
```

### 7.5 Asset Catalog

| Asset | Specifications |
|-------|---------------|
| AppIcon | 1024x1024 single asset (Xcode generates all sizes) |
| AccentColor | Adaptive: Light = `#6366F1` (indigo), Dark = `#818CF8` |
| BrandLogo | SVG preserving-vector in Assets catalog |


---

## 8. Authentication Flow

### 8.1 Sequence Diagram

```
iOS App                    Keychain                  OpenWork API
   |                          |                          |
   |-- 1. loadConnections() ->|                          |
   |<- [ServerConnection] ----|                          |
   |                          |                          |
   +-- Has saved connection?  |                          |
   |   YES: Skip to step 6   |                          |
   |   NO: Show setup screen  |                          |
   |                          |                          |
   |-- 2. GET /health ---------------------------------->|
   |<- { status: "ok" } ---------------------------------|
   |                          |                          |
   |-- 3. POST /api/auth/login ------------------------->|
   |      { username, password }                         |
   |<- { success, token, user } --------------------------|
   |                          |                          |
   |-- 4. saveConnections() ->|                          |
   |      (with JWT token)    |                          |
   |                          |                          |
   |-- 5. saveActiveServerID->|                          |
   |                          |                          |
   |-- 6. Initialize services                            |
   |   OpenWorkAPIClient(connection)                     |
   |   OpenWorkWebSocket(connection, .chat)              |
   |      ws://host:port/ws?token=JWT                    |
   |<=== WebSocket Connected ============================|
   |                          |                          |
   |-- 7. All API calls use:                             |
   |      Authorization: Bearer <JWT>                    |
   |-- GET /api/projects ---------------------------------|>
   |<- [Project] ------------------------------------------|
```

### 8.2 Token Refresh Strategy

- Server uses **7-day** JWT tokens (HS256)
- On **401** response: clear stored token, show ConnectionSetupView
- On **app foreground**: if token is >6 days old, re-login automatically
- **No refresh endpoint** exists; must re-authenticate via `/api/auth/login`

### 8.3 Multi-Server Support

Users can save multiple Mac connections (stored as JSON in Keychain):

```json
[
    { "id": "UUID-1", "name": "Home Mac", "host": "192.168.1.42", "port": 3001, "token": "..." },
    { "id": "UUID-2", "name": "Office Mac", "host": "10.0.1.100", "port": 3001, "token": "..." }
]
```

Only one server is active at a time. Switching disconnects the current WebSocket, activates the new connection, and refreshes all view models.


---

## 9. Terminal Implementation

### 9.1 Architecture

The terminal is the most complex screen. It requires:
1. **WebSocket PTY connection** via `/shell` endpoint
2. **ANSI escape code parsing** for colors, cursor movement, clearing
3. **Hardware keyboard input** including Control sequences and arrow keys
4. **Scrollback buffer** to retain terminal history

### 9.2 WebSocket PTY Protocol

**Connection URL:** `ws://host:port/shell?token=JWT`

**Initialization (client -> server):**
```json
{
    "type": "init",
    "projectPath": "/Users/dev/myproject",
    "sessionId": "abc123",
    "sessionMode": "resume",
    "provider": "claude",
    "rows": 24,
    "cols": 80
}
```

**Input (client -> server):**
```json
{ "type": "input", "data": "ls -la\r" }
```

**Resize (client -> server):**
```json
{ "type": "resize", "cols": 120, "rows": 40 }
```

**Output (server -> client):**
```json
{ "type": "output", "data": "\u001b[32muser@mac\u001b[0m:~$ " }
```

### 9.3 ANSI Parser

See `ANSIParser` in Section 6.6. Handles:
- SGR (Select Graphic Rendition): colors 30-37, 90-97, bold, dim, italic
- Reset sequences (`\x1B[0m`)
- Background colors 40-47

### 9.4 Keyboard Mapping

| Key / Combo | Bytes Sent | Notes |
|-------------|-----------|-------|
| Regular chars | UTF-8 bytes | Direct pass-through |
| Return/Enter | `\r` (0x0D) | Carriage return |
| Backspace | `\x7F` (DEL) | Standard terminal delete |
| Tab | `\t` (0x09) | Tab character |
| Escape | `\x1B` | Escape character |
| Arrow Up | `\x1B[A` | CSI sequence |
| Arrow Down | `\x1B[B` | CSI sequence |
| Arrow Right | `\x1B[C` | CSI sequence |
| Arrow Left | `\x1B[D` | CSI sequence |
| Ctrl+C | `\x03` (ETX) | Interrupt |
| Ctrl+D | `\x04` (EOT) | End of transmission |
| Ctrl+Z | `\x1A` (SUB) | Suspend |
| Ctrl+L | `\x0C` (FF) | Clear screen |
| Cmd+C | -- | Copy selection (not sent to PTY) |
| Cmd+V | Clipboard text | Paste: read pasteboard, send as input |


---

## 10. Implementation Phases

### Phase 1: Connection + Auth + Project/Session List (Week 1-2)

**Goal:** User can connect to their Mac and browse projects/sessions.

| Task | Files | Estimate |
|------|-------|----------|
| Xcode project setup | Project config | 2h |
| `ServerConnection` model | Models/ | 1h |
| `TokenStorage` (Keychain) | Services/ | 3h |
| `OpenWorkAPIClient` (health, login, projects, sessions) | Services/ | 4h |
| `AppState` + `ContentView` | App/ | 2h |
| `ConnectionSetupView` + ViewModel | Views/Connection/ | 4h |
| `ProjectsListView` with expand/collapse | Views/Projects/ | 3h |
| `SessionsListView` with swipe actions & context menus | Views/Sessions/ | 4h |
| Pull-to-refresh, filter chips | Integration | 2h |
| `HapticManager` | Utilities/ | 1h |
| **Phase 1 Total** | | **~26h** |

**Deliverable:** App connects, authenticates, lists projects and sessions with native iOS interactions.

### Phase 2: Chat Interface + WebSocket (Week 3-4)

**Goal:** User can send messages and receive streaming responses.

| Task | Files | Estimate |
|------|-------|----------|
| `OpenWorkWebSocket` (connect, send, receive, reconnect) | Services/ | 6h |
| WebSocket message models | Models/ | 3h |
| `ChatViewModel` (send, receive, streaming) | ViewModels/ | 5h |
| `ChatView` (message list, input bar, scroll) | Views/Chat/ | 4h |
| `ChatBubble` (user/assistant/thinking/error) | Views/Chat/ | 3h |
| Permission request banner | ChatView | 2h |
| `CommandPickerSheet` | Views/Chat/ | 3h |
| `NewSessionSheet` | Views/Sessions/ | 2h |
| Keyboard shortcuts (Cmd+Return, Cmd+K) | Integration | 2h |
| Session history loading | ChatViewModel | 2h |
| **Phase 2 Total** | | **~32h** |

**Deliverable:** Full chat experience with streaming, permission handling, and command picker.

### Phase 3: Terminal + PTY (Week 5-6)

**Goal:** User can interact with a terminal session.

| Task | Files | Estimate |
|------|-------|----------|
| `ANSIParser` (SGR colors, basic cursor) | Utilities/ | 8h |
| `TerminalViewModel` (PTY WebSocket) | ViewModels/ | 4h |
| `TerminalView` (scroll, monospace) | Views/Terminal/ | 5h |
| Hardware keyboard handling (arrows, Ctrl) | TerminalView | 4h |
| Pinch-to-zoom font size | TerminalView | 1h |
| Terminal resize on view size change | TerminalView | 2h |
| Session-to-terminal navigation | Integration | 2h |
| **Phase 3 Total** | | **~26h** |

**Deliverable:** Working terminal with ANSI rendering and keyboard input.

### Phase 4: iPad Split View + Polish (Week 7-8)

**Goal:** iPad-optimized layout and production polish.

| Task | Files | Estimate |
|------|-------|----------|
| `NavigationSplitView` for iPad | ContentView | 4h |
| Sidebar selection to detail chat | Integration | 3h |
| Dynamic Type support audit | All views | 3h |
| Dark mode fine-tuning | Color+Theme, views | 2h |
| Error handling UX (connection lost, timeout) | ViewModels | 4h |
| Loading states (skeletons, progress) | All views | 3h |
| Accessibility audit (VoiceOver) | All views | 3h |
| App icon, launch screen | Assets | 2h |
| Edge case testing | Testing | 4h |
| **Phase 4 Total** | | **~28h** |

**Deliverable:** Production-ready app with iPad support and polished UX.

### Total Estimate

| Phase | Hours | Calendar |
|-------|-------|----------|
| Phase 1: Connection + Lists | ~26h | Week 1-2 |
| Phase 2: Chat + WebSocket | ~32h | Week 3-4 |
| Phase 3: Terminal + PTY | ~26h | Week 5-6 |
| Phase 4: iPad + Polish | ~28h | Week 7-8 |
| **Total** | **~112h** | **~8 weeks** |

---

## Appendix A: Server API Quick Reference

All API calls use `Authorization: Bearer <JWT>` header.

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | Health check (no auth required) |
| `POST` | `/api/auth/login` | Login, returns JWT token |
| `GET` | `/api/auth/status` | Check auth status |
| `GET` | `/api/projects` | List all projects |
| `POST` | `/api/projects/create` | Create project |
| `PUT` | `/api/projects/:name/rename` | Rename project |
| `DELETE` | `/api/projects/:name` | Delete project |
| `GET` | `/api/projects/:name/sessions` | List sessions |
| `GET` | `/api/projects/:name/sessions/:id/messages` | Get session messages |
| `PUT` | `/api/projects/:name/sessions/:id/rename` | Rename session |
| `DELETE` | `/api/projects/:name/sessions/:id` | Delete session |
| `POST` | `/api/commands/list` | List slash commands |
| `POST` | `/api/commands/execute` | Execute a command |
| `GET` | `/api/user/git-config` | Get git config |
| `WS` | `/ws?token=JWT` | Chat WebSocket |
| `WS` | `/shell?token=JWT` | Terminal PTY WebSocket |

## Appendix B: WebSocket Message Types

### Client -> Server (Chat `/ws`)

| Type | Key Fields | Purpose |
|------|-----------|---------|
| `claude-command` | `command`, `options: {projectPath, sessionId?, model?}` | Send Claude message |
| `codex-command` | `command`, `options: {projectPath?, sessionId?, model?}` | Send Codex message |
| `abort-session` | `sessionId`, `provider?` | Abort streaming response |
| `claude-permission-response` | `requestId`, `allow` | Permission response |
| `get-active-sessions` | -- | Request active session list |
| `start-watching` | `projectPath` | Watch project for file changes |
| `stop-watching` | `projectPath` | Stop watching |

### Server -> Client (Chat `/ws`)

| Type | Key Fields | Purpose |
|------|-----------|---------|
| `text` | `content`, `sessionId?` | Streaming text response |
| `code` | `content`, `language?`, `sessionId?` | Code block |
| `thinking` | `content`, `sessionId?` | Thinking indicator |
| `session-aborted` | `sessionId`, `provider`, `success` | Abort confirmed |
| `session-status` | `sessionId`, `provider`, `isProcessing` | Processing state |
| `active-sessions` | `sessions: {claude: [], codex: []}` | Active session list |
| `projects_updated` | `projects` | Project list changed |
| `error` | `error` | Error message |
| `claude-permission-request` | `requestId`, `tool?`, `description?` | Permission needed |

### Client -> Server (Terminal `/shell`)

| Type | Key Fields | Purpose |
|------|-----------|---------|
| `init` | `projectPath, sessionId, sessionMode, provider, rows, cols` | Initialize PTY |
| `input` | `data` | Send keyboard input |
| `resize` | `cols, rows` | Resize terminal dimensions |

### Server -> Client (Terminal `/shell`)

| Type | Key Fields | Purpose |
|------|-----------|---------|
| `output` | `data` | Terminal output (ANSI-escaped) |
| `pty-output` | `data` | PTY output |
| `pty-history` | `data` | Scrollback buffer content |
| `pty-exit` | `code?` | PTY session ended |
