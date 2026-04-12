# OpenWork iOS App — Technical Design Document

> **Document version:** 2.0
> **Last updated:** 2025-07-18
> **Target:** iOS 17+ / iPadOS 17+
> **Framework:** SwiftUI + Swift Concurrency (async/await)
> **Project name:** OpenWorkMobile
> **Bundle ID:** `com.openwork.mobile`

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Authentication & Token Pairing](#2-authentication--token-pairing)
3. [Data Models](#3-data-models)
4. [Networking Layer](#4-networking-layer)
5. [Session Architecture — The PTY Model](#5-session-architecture--the-pty-model)
6. [Screen-by-Screen Design](#6-screen-by-screen-design)
7. [Gesture Design](#7-gesture-design)
8. [SwiftUI Code Skeletons](#8-swiftui-code-skeletons)
9. [Xcode Project Setup](#9-xcode-project-setup)
10. [Implementation Phases](#10-implementation-phases)
11. [Appendix: Real API Reference](#11-appendix-real-api-reference)

---


## 1. Architecture Overview

### 1.1 How OpenWork Works

OpenWork is a **Tauri desktop application** (Rust backend + web frontend) that manages AI coding sessions by running CLI tools (`claude`, `codex`, `cursor`) inside pseudo-terminals (PTY). The Tauri backend exposes an **Axum HTTP server on port 3002** over the LAN, enabling mobile clients to interact with the same PTY sessions.

**Critical design fact:** There is no chat protocol. The iOS app communicates with AI agents through raw PTY streams — the same terminal interface the desktop app uses. The server sends chunks of terminal output (including ANSI escape codes); the client sends text that gets written to the PTY's stdin.

### 1.2 Technology Stack

| Decision | Choice | Rationale |
|----------|--------|-----------|
| UI Framework | SwiftUI | Native iOS feel, built-in Dark Mode, Dynamic Type, split view on iPad |
| Networking | URLSession | Built-in async/await, native WebSocket via `URLSessionWebSocketTask`, zero dependencies |
| WebSocket | URLSessionWebSocketTask | Native Apple API, handles ping/pong, supports text and binary frames |
| Secure Storage | Keychain (Security.framework) | OS-level encryption for API tokens and server connection info |
| State Management | `@Observable` (Observation framework) | iOS 17+ macro-based observation, simpler than Combine |
| Terminal Rendering | `NSAttributedString` + `UITextView` | Lightweight ANSI SGR color parser; avoids heavyweight WebView or terminal emulators |
| Dependencies | **None** (Apple frameworks only) | `URLSessionWebSocketTask` eliminates need for Starscream; Keychain eliminates need for KeychainAccess |

### 1.3 App Architecture Pattern

**MVVM + Service Layer** using Swift's `@Observable` macro:

```
+-----------------------------------------------------------+
|                      SwiftUI Views                        |
|  (ConnectionSetupView, ProjectsListView, SessionView …)   |
+-----------------------------------------------------------+
|                      ViewModels                           |
|  (@Observable classes with async methods)                  |
+-----------------------------------------------------------+
|                     Service Layer                          |
|  OpenWorkAPIClient  |  OpenWorkPTYSession  |  TokenStorage |
|  (REST HTTP)        |  (PTY WebSocket)     |  (Keychain)   |
+-----------------------------------------------------------+
|                  Apple Frameworks                          |
|  URLSession  |  Security (Keychain)  |  Foundation         |
+-----------------------------------------------------------+
```

Key difference from v1: `OpenWorkWebSocket` (single global WS) is replaced by `OpenWorkPTYSession` — one WebSocket per active PTY session, keyed by `ptyId`.

### 1.4 Data Flow

```
                  ┌─────────────────────────────────────────┐
                  │          Mac Desktop (Tauri)             │
                  │                                         │
                  │  ┌─────────┐   ┌──────────────────┐     │
                  │  │ Claude  │   │ Axum HTTP Server  │     │
                  │  │ Codex   │◄──│ port 3002         │     │
                  │  │ Cursor  │   │ /api/* + /ws      │     │
                  │  │  (PTY)  │   └──────────────────┘     │
                  │  └─────────┘           ▲                │
                  └────────────────────────│────────────────┘
                                           │ LAN (Wi-Fi)
                  ┌────────────────────────│────────────────┐
                  │       iOS App          │                │
                  │                        ▼                │
                  │  ┌──────────────────────────────────┐   │
                  │  │  OpenWorkAPIClient (REST)         │   │
                  │  │  OpenWorkPTYSession (WebSocket)   │   │
                  │  └──────────────────────────────────┘   │
                  │        ▲                                │
                  │        │                                │
                  │  ┌─────┴─────────────────────────────┐  │
                  │  │   ViewModels → SwiftUI Views       │  │
                  │  └───────────────────────────────────┘  │
                  └─────────────────────────────────────────┘
```

### 1.5 Project Structure

```
OpenWorkMobile/
├── OpenWorkMobile.xcodeproj
├── OpenWorkMobile/
│   ├── App/
│   │   ├── OpenWorkMobileApp.swift          # @main entry point
│   │   └── ContentView.swift                # Root navigation
│   ├── Models/
│   │   ├── ServerConnection.swift           # Host + port + token
│   │   ├── Project.swift                    # Project + embedded Session
│   │   ├── SessionSummary.swift             # History session list item
│   │   ├── SessionMessage.swift             # History message with JSON content
│   │   ├── PTYMessage.swift                 # WebSocket message types
│   │   └── CommandDiscovery.swift           # Commands + Skills
│   ├── ViewModels/
│   │   ├── ConnectionViewModel.swift        # Token pairing, server validation
│   │   ├── ProjectsViewModel.swift          # Project list management
│   │   ├── SessionsViewModel.swift          # Session list + history
│   │   └── SessionViewModel.swift           # Active PTY session controller
│   ├── Views/
│   │   ├── Connection/
│   │   │   ├── ConnectionSetupView.swift    # Token + IP + Port entry, QR scan
│   │   │   └── ServerListView.swift         # Multi-server list
│   │   ├── Projects/
│   │   │   ├── ProjectsListView.swift
│   │   │   └── ProjectRow.swift
│   │   ├── Sessions/
│   │   │   ├── SessionsListView.swift       # History + active sessions
│   │   │   ├── SessionRow.swift
│   │   │   └── NewSessionSheet.swift        # Provider picker
│   │   ├── Session/
│   │   │   ├── SessionView.swift            # Combined PTY output + input
│   │   │   ├── PTYOutputView.swift          # Terminal-style text display
│   │   │   └── CommandPickerSheet.swift     # Slash commands / skills
│   │   └── Settings/
│   │       └── SettingsView.swift
│   ├── Services/
│   │   ├── OpenWorkAPIClient.swift          # All REST API calls
│   │   ├── OpenWorkPTYSession.swift         # Per-session PTY WebSocket
│   │   └── TokenStorage.swift               # Keychain multi-server storage
│   ├── Utilities/
│   │   ├── HapticManager.swift
│   │   ├── ANSIParser.swift                 # SGR color → NSAttributedString
│   │   └── KeychainHelper.swift
│   ├── Extensions/
│   │   ├── Date+Relative.swift
│   │   └── Color+Theme.swift
│   └── Resources/
│       ├── Assets.xcassets
│       └── Localizable.xcstrings
└── OpenWorkMobileTests/
    ├── APIClientTests.swift
    ├── PTYSessionTests.swift
    └── ModelDecodingTests.swift
```


---


## 2. Authentication & Token Pairing

### 2.1 How Authentication Works

OpenWork uses **static UUID token authentication** — NOT JWT, NOT username/password. There is no login form.

When the Tauri desktop app starts, it:
1. Generates a random UUID v4: `uuid::Uuid::new_v4().to_string()`
2. Writes it to `~/.openwork/api-token.txt`
3. Uses this token to authenticate all HTTP API requests from LAN clients

The token is a plain UUID string like `a1b2c3d4-e5f6-7890-abcd-ef1234567890`.

**There is no:**
- `POST /api/auth/login` endpoint
- User registration, username, or password
- JWT issuance or refresh
- Token expiration (token is valid until the desktop app restarts)

### 2.2 Token Pairing Flow

```
[Mac Desktop App]                       [iOS App]
      │                                      │
      │── App starts                         │
      │── Generates UUID token               │
      │── Writes ~/.openwork/api-token.txt   │
      │── Shows token in Settings UI         │
      │── (Optional) Displays QR code        │
      │   containing: ip, port, token        │
      │                                      │
      │                                      │── User opens "Add Server" screen
      │                                      │── Option A: Enters IP + Port + Token manually
      │                                      │── Option B: Scans QR code (gets all three)
      │                                      │── Stores {host, port, token} in Keychain
      │                                      │── Validates: GET /health (no auth needed)
      │                                      │── Validates: GET /api/sessions (with auth)
      │                                      │── If both pass → connected → show Projects
      │                                      │── If auth fails → show error, re-enter token
```

### 2.3 How to Send the Token

Every request to `/api/*` paths (except exempt ones) must include the token:

**Option A — Authorization header** (recommended for REST):
```
Authorization: Bearer a1b2c3d4-e5f6-7890-abcd-ef1234567890
```

**Option B — Query parameter** (required for WebSocket upgrade):
```
ws://192.168.1.42:3002/api/pty/{ptyId}/ws?token=a1b2c3d4-e5f6-7890-abcd-ef1234567890
```

### 2.4 Exempt Endpoints (No Auth Required)

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Server health check |
| `GET /api/local-ip` | Discover server LAN IP |
| `GET /api/auth/token-info` | Returns hint about where token is stored |
| Any non-`/api/` path | Static file serving (SPA assets) |

### 2.5 Multi-Server Support

Users may have multiple Macs running OpenWork. The iOS app stores multiple `ServerConnection` entries in the Keychain, each with its own host, port, and token.

### 2.6 QR Code Format

The desktop app should encode connection info as a JSON string in the QR code:

```json
{
  "host": "192.168.1.42",
  "port": 3002,
  "token": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
```

The iOS app uses `AVCaptureSession` with `AVMetadataObjectTypeQRCode` to scan this.

### 2.7 Token Invalidation

When the desktop app restarts, a **new** token is generated. The iOS app will get `401 Unauthorized` on subsequent requests. The app should:
1. Detect the 401 response
2. Show a "Token expired — re-pair required" alert
3. Navigate to the ConnectionSetupView to enter the new token


---


## 3. Data Models

All Swift structs must match the **exact JSON field names** produced by Rust `serde`. The Rust backend uses two serialization conventions:

- **Default serde (snake_case)**: `Project`, `Session`, `SessionSummary`, `SessionMessage`, `SessionInfo`
- **`#[serde(rename_all = "camelCase")]`**: `DiscoveredCommand`, `DiscoveredSkill`, `CommandDiscoveryResult`

### 3.1 ServerConnection (Client-Side Only)

```swift
import Foundation

struct ServerConnection: Codable, Identifiable, Hashable {
    let id: UUID
    var name: String           // User-defined label, e.g. "Home Mac"
    var host: String           // e.g. "192.168.1.42"
    var port: Int              // default 3002
    var token: String          // UUID token from ~/.openwork/api-token.txt

    var baseURL: URL {
        URL(string: "http://\(host):\(port)")!
    }

    var wsBaseURL: URL {
        URL(string: "ws://\(host):\(port)")!
    }

    init(name: String = "", host: String, port: Int = 3002, token: String = "") {
        self.id = UUID()
        self.name = name
        self.host = host
        self.port = port
        self.token = token
    }
}
```

**Note:** Port is `3002` (Tauri Axum server), not `3001` (the old Node/Express server).

### 3.2 Project

Returned by `GET /api/projects` as a **bare JSON array** `[Project]`, NOT wrapped in `{"projects":[]}`.

```swift
struct Project: Codable, Identifiable, Hashable {
    let name: String
    let path: String
    let fullPath: String
    let description: String?
    let sessions: [Session]
    let createdAt: String?
    let lastAccessed: String?
    let config: AnyCodableValue?

    var id: String { path }

    enum CodingKeys: String, CodingKey {
        case name, path, description, sessions, config
        case fullPath = "full_path"
        case createdAt = "created_at"
        case lastAccessed = "last_accessed"
    }
}
```

### 3.3 Session (Embedded in Project)

This is the `Session` struct from `projects.rs` — part of the Project object, representing known sessions on disk.

```swift
struct Session: Codable, Identifiable, Hashable {
    let id: String
    let projectPath: String
    let provider: String          // "claude" | "codex" | "cursor"
    let name: String?
    let createdAt: String?
    let lastMessage: String?
    let messageCount: UInt32

    enum CodingKeys: String, CodingKey {
        case id, provider, name
        case projectPath = "project_path"
        case createdAt = "created_at"
        case lastMessage = "last_message"
        case messageCount = "message_count"
    }
}
```

### 3.4 ActiveSessionInfo

Returned by `GET /api/sessions` inside `{"sessions": [ActiveSessionInfo]}`.

> **Backend enhancement proposed:** The Rust `SessionInfo` struct in `http_server.rs` should be extended to include `project_path: Option<String>`. Currently only `{id, state, provider}` are returned, with `provider` always `None`. Adding `project_path` enables iOS to reliably map active sessions to projects (see §6.4 for the resolution strategy).

```swift
struct ActiveSessionInfo: Codable, Identifiable {
    let id: String
    let state: String            // "Idle" | "Running" | "WaitingForInput" | "Completed" | "Failed"
    let provider: String?        // NOTE: Currently always nil from backend; default to "claude" when nil
    let projectPath: String?     // Proposed backend field — nil on older backends

    /// Effective provider, defaulting to "claude" when backend returns nil.
    var effectiveProvider: String { provider ?? "claude" }

    enum CodingKeys: String, CodingKey {
        case id, state, provider
        case projectPath = "project_path"
    }
}

struct ActiveSessionsResponse: Codable {
    let sessions: [ActiveSessionInfo]
}
```

### 3.5 SessionSummary (History)

Returned by `GET /api/session-history` as a **bare JSON array** `[SessionSummary]`.

```swift
struct SessionSummary: Codable, Identifiable {
    let sessionId: String
    let projectPath: String
    let provider: String
    let name: String?
    let messageCount: Int
    let lastMessage: String?
    let createdAt: String?

    var id: String { sessionId }

    enum CodingKeys: String, CodingKey {
        case provider, name
        case sessionId = "session_id"
        case projectPath = "project_path"
        case messageCount = "message_count"
        case lastMessage = "last_message"
        case createdAt = "created_at"
    }
}
```

### 3.6 SessionMessage (History)

Returned by `GET /api/session-history/{session_id}/messages` as a **bare JSON array**.

**Critical:** The `content` field is a `serde_json::Value` — an arbitrary JSON value, NOT a plain string. For Claude it may be `{"type":"text","text":"..."}` or an array of content blocks. For Codex it may be `{"type":"agent_message","message":"..."}`.

```swift
struct SessionMessage: Codable, Identifiable {
    let uuid: String
    let role: String              // "user" | "assistant" | "summary"
    let content: AnyCodableValue  // JSON object — varies by provider
    let timestamp: String?
    let isSidechain: Bool?

    var id: String { uuid }

    enum CodingKeys: String, CodingKey {
        case uuid, role, content, timestamp
        case isSidechain = "is_sidechain"
    }

    /// Extract human-readable text from the content JSON.
    /// Handles multiple provider formats gracefully.
    var textContent: String {
        switch content {
        case .string(let s):
            return s
        case .object(let dict):
            // Claude format: {"type":"text","text":"..."}
            if case .string(let text) = dict["text"] {
                return text
            }
            // Codex format: {"type":"agent_message","message":"..."}
            if case .string(let msg) = dict["message"] {
                return msg
            }
            return String(describing: dict)
        case .array(let blocks):
            // Claude multi-block: [{"type":"text","text":"..."}, ...]
            return blocks.compactMap { block in
                if case .object(let obj) = block,
                   case .string(let text) = obj["text"] {
                    return text
                }
                return nil
            }.joined(separator: "\n")
        default:
            return String(describing: content)
        }
    }
}
```

### 3.7 AnyCodableValue

A type-erasing wrapper to decode arbitrary JSON. Required because `SessionMessage.content` and `Project.config` are `serde_json::Value` in Rust.

```swift
enum AnyCodableValue: Codable, Hashable {
    case null
    case bool(Bool)
    case int(Int)
    case double(Double)
    case string(String)
    case array([AnyCodableValue])
    case object([String: AnyCodableValue])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let b = try? container.decode(Bool.self) {
            self = .bool(b)
        } else if let i = try? container.decode(Int.self) {
            self = .int(i)
        } else if let d = try? container.decode(Double.self) {
            self = .double(d)
        } else if let s = try? container.decode(String.self) {
            self = .string(s)
        } else if let arr = try? container.decode([AnyCodableValue].self) {
            self = .array(arr)
        } else if let obj = try? container.decode([String: AnyCodableValue].self) {
            self = .object(obj)
        } else {
            throw DecodingError.typeMismatch(
                AnyCodableValue.self,
                DecodingError.Context(codingPath: decoder.codingPath,
                                      debugDescription: "Unsupported JSON value")
            )
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null:      try container.encodeNil()
        case .bool(let b):   try container.encode(b)
        case .int(let i):    try container.encode(i)
        case .double(let d): try container.encode(d)
        case .string(let s): try container.encode(s)
        case .array(let a):  try container.encode(a)
        case .object(let o): try container.encode(o)
        }
    }
}
```

### 3.8 Command Discovery

The `DiscoveredCommand` and `DiscoveredSkill` structs use `#[serde(rename_all = "camelCase")]` in Rust, so JSON keys are camelCase — Swift properties can map directly.

```swift
struct CommandDiscoveryResponse: Codable {
    let ok: Bool
    let data: CommandDiscoveryResult?
    let error: String?
}

struct CommandDiscoveryResult: Codable {
    let commands: [DiscoveredCommand]
    let skills: [DiscoveredSkill]
}

struct DiscoveredCommand: Codable, Identifiable {
    let name: String
    let description: String
    let provider: String
    let scope: String              // "user" | "project"
    let filePath: String

    var id: String { "\(provider)-\(scope)-\(name)" }
}

struct DiscoveredSkill: Codable, Identifiable {
    let name: String
    let displayName: String
    let description: String
    let provider: String
    let scope: String              // "user" | "vendor"

    var id: String { "\(provider)-\(scope)-\(name)" }
}
```

### 3.9 PTY WebSocket Messages

```swift
enum PTYMessageFromServer {
    case history(id: String, data: String)
    case output(id: String, data: String)
    case exit(id: String, code: UInt32?)

    init?(json: [String: Any]) {
        guard let type = json["type"] as? String else { return nil }
        switch type {
        case "pty-history":
            guard let id = json["id"] as? String,
                  let data = json["data"] as? String else { return nil }
            self = .history(id: id, data: data)
        case "pty-output":
            guard let id = json["id"] as? String,
                  let data = json["data"] as? String else { return nil }
            self = .output(id: id, data: data)
        case "pty-exit":
            guard let id = json["id"] as? String else { return nil }
            let code = json["code"] as? UInt32
            self = .exit(id: id, code: code)
        default:
            return nil
        }
    }
}

struct PTYInputMessage: Encodable {
    let type = "pty-input"
    let data: String
}
```

### 3.10 Health & Info Responses

```swift
struct HealthResponse: Codable {
    let status: String
    let app: String              // "openwork"
    let lanUrl: String           // "http://192.168.1.42:3002"
}

struct LocalIPResponse: Codable {
    let ip: String
    let url: String              // "http://192.168.1.42:3002"
}

struct TokenInfoResponse: Codable {
    let hint: String             // "Token is stored at ~/.openwork/api-token.txt"
}
```

### 3.11 Provider Capability Matrix

The three supported AI providers have **significantly different backend capabilities**. The iOS app must adapt its UI based on the selected provider.

| Capability | Claude | Codex | Cursor |
|---|---|---|---|
| Start new session | ✅ | ✅ | ✅ |
| Session history | ✅ | ✅ (from `~/.codex/sessions/`) | ❌ |
| Commands/Skills discovery | ✅ | ❌ (skills only, no commands) | ❌ |
| Project auto-discovery | ✅ (sessions embedded in `GET /api/projects`) | ❌ (sessions discovered separately from `~/.codex/sessions/`) | ❌ |
| Resume session | ✅ | ❌ | ❌ |

**Key implementation notes:**
- `ai_list_sessions` in the Rust backend returns `Ok(vec![])` for non-Claude providers — only Claude stores session files in `~/.claude/projects/`.
- `commands_discover` returns empty `{commands: [], skills: []}` for Cursor. For Codex, it returns skills (from `~/.codex/skills/`) but no commands.
- Codex sessions are discovered from `~/.codex/sessions/YYYY/MM/DD/rollout-{ts}-{uuid}.jsonl`, NOT from `projects.json`.
- Cursor has no disk persistence for sessions — no history, no resume capability.
- The iOS app should gracefully degrade UI elements based on this matrix (see §6.4 and §6.5 for specific UI adaptations).


---


## 4. Networking Layer

### 4.1 OpenWorkAPIClient

A singleton-style service that holds the current `ServerConnection` and provides typed async methods for every REST endpoint.

```swift
import Foundation

@Observable
final class OpenWorkAPIClient {

    var connection: ServerConnection?

    // MARK: - Low-level helpers

    private func url(_ path: String, queryItems: [URLQueryItem] = []) -> URL? {
        guard let base = connection?.baseURL else { return nil }
        var components = URLComponents(url: base.appendingPathComponent(path), resolvingAgainstBaseURL: false)
        if !queryItems.isEmpty {
            components?.queryItems = queryItems
        }
        return components?.url
    }

    private func authorizedRequest(_ url: URL, method: String = "GET") -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = method
        if let token = connection?.token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return request
    }

    // MARK: - Health (no auth)

    func health() async throws -> HealthResponse {
        guard let url = url("/health") else { throw APIError.notConnected }
        let (data, _) = try await URLSession.shared.data(from: url)
        return try JSONDecoder().decode(HealthResponse.self, from: data)
    }

    func localIP() async throws -> LocalIPResponse {
        guard let url = url("/api/local-ip") else { throw APIError.notConnected }
        let (data, _) = try await URLSession.shared.data(from: url)
        return try JSONDecoder().decode(LocalIPResponse.self, from: data)
    }

    func tokenInfo() async throws -> TokenInfoResponse {
        guard let url = url("/api/auth/token-info") else { throw APIError.notConnected }
        let (data, _) = try await URLSession.shared.data(from: url)
        return try JSONDecoder().decode(TokenInfoResponse.self, from: data)
    }

    // MARK: - Projects

    /// Returns bare array `[Project]` — NOT wrapped in {"projects": []}
    func listProjects() async throws -> [Project] {
        guard let url = url("/api/projects") else { throw APIError.notConnected }
        let request = authorizedRequest(url)
        let (data, response) = try await URLSession.shared.data(for: request)
        try checkAuth(response)
        return try JSONDecoder().decode([Project].self, from: data)
    }

    func addProject(name: String, path: String) async throws -> Project {
        guard let url = url("/api/projects") else { throw APIError.notConnected }
        var request = authorizedRequest(url, method: "POST")
        request.httpBody = try JSONEncoder().encode(["name": name, "path": path])
        let (data, response) = try await URLSession.shared.data(for: request)
        try checkAuth(response)
        return try JSONDecoder().decode(Project.self, from: data)
    }

    func removeProject(path: String) async throws {
        guard let url = url("/api/projects/remove") else { throw APIError.notConnected }
        var request = authorizedRequest(url, method: "POST")
        request.httpBody = try JSONEncoder().encode(["path": path])
        let (_, response) = try await URLSession.shared.data(for: request)
        try checkAuth(response)
    }

    // MARK: - Active PTY Sessions

    func listActiveSessions() async throws -> [ActiveSessionInfo] {
        guard let url = url("/api/sessions") else { throw APIError.notConnected }
        let request = authorizedRequest(url)
        let (data, response) = try await URLSession.shared.data(for: request)
        try checkAuth(response)
        let wrapper = try JSONDecoder().decode(ActiveSessionsResponse.self, from: data)
        return wrapper.sessions
    }

    struct CreateSessionRequest: Encodable {
        let project_path: String
        let provider: String
        let resume_session_id: String?
    }

    struct CreateSessionResponse: Decodable {
        let ok: Bool
        let ptyId: String?
        let error: String?
    }

    func createSession(
        projectPath: String,
        provider: String = "claude",
        resumeSessionId: String? = nil
    ) async throws -> String {
        guard let url = url("/api/sessions") else { throw APIError.notConnected }
        var request = authorizedRequest(url, method: "POST")
        let body = CreateSessionRequest(
            project_path: projectPath,
            provider: provider,
            resume_session_id: resumeSessionId
        )
        request.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await URLSession.shared.data(for: request)
        try checkAuth(response)
        let result = try JSONDecoder().decode(CreateSessionResponse.self, from: data)
        guard result.ok, let ptyId = result.ptyId else {
            throw APIError.serverError(result.error ?? "Unknown error creating session")
        }
        return ptyId
    }

    func sendToSession(ptyId: String, text: String) async throws {
        guard let url = url("/api/sessions/\(ptyId)/send") else { throw APIError.notConnected }
        var request = authorizedRequest(url, method: "POST")
        request.httpBody = try JSONEncoder().encode(["text": text])
        let (data, response) = try await URLSession.shared.data(for: request)
        try checkAuth(response)
        let result = try JSONDecoder().decode(OkResponse.self, from: data)
        if !result.ok {
            throw APIError.serverError(result.error ?? "Failed to send")
        }
    }

    func killSession(ptyId: String) async throws {
        guard let url = url("/api/sessions/\(ptyId)/kill") else { throw APIError.notConnected }
        let request = authorizedRequest(url, method: "POST")
        let (_, response) = try await URLSession.shared.data(for: request)
        try checkAuth(response)
    }

    // MARK: - Session History

    /// Returns bare array `[SessionSummary]`
    func sessionHistory(
        projectPath: String,
        provider: String = "claude",
        limit: Int = 20,
        offset: Int = 0
    ) async throws -> [SessionSummary] {
        guard let url = url("/api/session-history", queryItems: [
            URLQueryItem(name: "project_path", value: projectPath),
            URLQueryItem(name: "provider", value: provider),
            URLQueryItem(name: "limit", value: String(limit)),
            URLQueryItem(name: "offset", value: String(offset)),
        ]) else { throw APIError.notConnected }
        let request = authorizedRequest(url)
        let (data, response) = try await URLSession.shared.data(for: request)
        try checkAuth(response)
        return try JSONDecoder().decode([SessionSummary].self, from: data)
    }

    /// Returns bare array `[SessionMessage]`
    func sessionMessages(
        sessionId: String,
        projectPath: String,
        provider: String = "claude",
        limit: Int = 200,
        offset: Int = 0
    ) async throws -> [SessionMessage] {
        guard let url = url("/api/session-history/\(sessionId)/messages", queryItems: [
            URLQueryItem(name: "project_path", value: projectPath),
            URLQueryItem(name: "provider", value: provider),
            URLQueryItem(name: "limit", value: String(limit)),
            URLQueryItem(name: "offset", value: String(offset)),
        ]) else { throw APIError.notConnected }
        let request = authorizedRequest(url)
        let (data, response) = try await URLSession.shared.data(for: request)
        try checkAuth(response)
        return try JSONDecoder().decode([SessionMessage].self, from: data)
    }

    // MARK: - Command Discovery

    func discoverCommands(
        provider: String = "claude",
        projectPath: String? = nil
    ) async throws -> CommandDiscoveryResult {
        var items = [URLQueryItem(name: "provider", value: provider)]
        if let pp = projectPath {
            items.append(URLQueryItem(name: "project_path", value: pp))
        }
        guard let url = url("/api/commands/discover", queryItems: items) else {
            throw APIError.notConnected
        }
        let request = authorizedRequest(url)
        let (data, response) = try await URLSession.shared.data(for: request)
        try checkAuth(response)
        let wrapper = try JSONDecoder().decode(CommandDiscoveryResponse.self, from: data)
        guard wrapper.ok, let result = wrapper.data else {
            throw APIError.serverError(wrapper.error ?? "Command discovery failed")
        }
        return result
    }

    // MARK: - Error handling

    struct OkResponse: Decodable {
        let ok: Bool
        let error: String?
    }

    private func checkAuth(_ response: URLResponse) throws {
        if let http = response as? HTTPURLResponse, http.statusCode == 401 {
            throw APIError.unauthorized
        }
    }
}

enum APIError: LocalizedError {
    case notConnected
    case unauthorized
    case serverError(String)

    var errorDescription: String? {
        switch self {
        case .notConnected: return "Not connected to server"
        case .unauthorized: return "Token invalid or expired — re-pair required"
        case .serverError(let msg): return msg
        }
    }
}
```

### 4.2 OpenWorkPTYSession

A per-session WebSocket manager that connects to `/api/pty/{ptyId}/ws`, receives terminal output, and sends input. **One instance per active PTY session** — NOT a global singleton.

```swift
import Foundation

@Observable
final class OpenWorkPTYSession {

    let ptyId: String
    private let connection: ServerConnection
    private var webSocket: URLSessionWebSocketTask?
    private var isListening = false

    /// Connection state — prefer this over the boolean `isConnected`.
    enum ConnectionState: Equatable {
        case disconnected
        case connecting      // resume() called, waiting for first message from server
        case connected       // first pty-history or pty-output received
        case failed(String)  // connection error (message for display)

        static func == (lhs: ConnectionState, rhs: ConnectionState) -> Bool {
            switch (lhs, rhs) {
            case (.disconnected, .disconnected), (.connecting, .connecting), (.connected, .connected):
                return true
            case (.failed(let a), .failed(let b)):
                return a == b
            default:
                return false
            }
        }
    }

    // Output buffer: sliding window of the last N lines
    private(set) var outputLines: [String] = []
    private(set) var connectionState: ConnectionState = .disconnected
    private(set) var exitCode: UInt32?
    private(set) var hasExited = false

    /// Convenience for UI — true only after first server message received.
    var isConnected: Bool { connectionState == .connected }
    var isConnecting: Bool { connectionState == .connecting }

    static let maxBufferLines = 5000

    init(ptyId: String, connection: ServerConnection) {
        self.ptyId = ptyId
        self.connection = connection
    }

    // MARK: - Connect

    func connect() {
        guard webSocket == nil else { return }
        let wsURL = connection.wsBaseURL
            .appendingPathComponent("/api/pty/\(ptyId)/ws")
        var components = URLComponents(url: wsURL, resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "token", value: connection.token)]

        guard let url = components.url else { return }
        let session = URLSession(configuration: .default)
        webSocket = session.webSocketTask(with: url)
        webSocket?.resume()
        // Do NOT set isConnected here — wait for first server message
        connectionState = .connecting
        listen()
    }

    // MARK: - Disconnect

    func disconnect() {
        webSocket?.cancel(with: .normalClosure, reason: nil)
        webSocket = nil
        connectionState = .disconnected
        isListening = false
    }

    // MARK: - Send input

    func send(_ text: String) {
        let msg = PTYInputMessage(data: text)
        guard let data = try? JSONEncoder().encode(msg),
              let json = String(data: data, encoding: .utf8) else { return }
        webSocket?.send(.string(json)) { error in
            if let error {
                print("[PTYSession] Send error: \(error)")
            }
        }
    }

    // MARK: - Listen loop

    private func listen() {
        guard !isListening else { return }
        isListening = true
        Task { [weak self] in
            while let self, let ws = self.webSocket {
                do {
                    let message = try await ws.receive()
                    switch message {
                    case .string(let text):
                        self.handleMessage(text)
                    case .data(let data):
                        if let text = String(data: data, encoding: .utf8) {
                            self.handleMessage(text)
                        }
                    @unknown default:
                        break
                    }
                } catch {
                    // WebSocket closed or failed
                    await MainActor.run {
                        self.connectionState = .failed(error.localizedDescription)
                        self.isListening = false
                    }
                    break
                }
            }
        }
    }

    private func handleMessage(_ text: String) {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let msg = PTYMessageFromServer(json: json) else { return }

        Task { @MainActor in
            // Transition from .connecting → .connected on first server message
            if self.connectionState == .connecting {
                self.connectionState = .connected
            }

            switch msg {
            case .history(_, let data):
                self.appendOutput(data)
            case .output(_, let data):
                self.appendOutput(data)
            case .exit(_, let code):
                self.exitCode = code
                self.hasExited = true
                self.connectionState = .disconnected
            }
        }
    }

    /// Append output lines, keeping buffer within maxBufferLines.
    private func appendOutput(_ text: String) {
        let newLines = text.components(separatedBy: "\n")
        outputLines.append(contentsOf: newLines)
        let overflow = outputLines.count - Self.maxBufferLines
        if overflow > 0 {
            outputLines.removeFirst(overflow)
        }
    }
}
```

### 4.3 TokenStorage

Keychain-based storage supporting multiple server connections.

```swift
import Foundation
import Security

final class TokenStorage {

    private static let service = "com.openwork.mobile"
    private static let connectionsKey = "server-connections"

    // MARK: - Save / Load connections

    static func saveConnections(_ connections: [ServerConnection]) {
        guard let data = try? JSONEncoder().encode(connections) else { return }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: connectionsKey,
        ]
        SecItemDelete(query as CFDictionary)

        var add = query
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(add as CFDictionary, nil)
    }

    static func loadConnections() -> [ServerConnection] {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: connectionsKey,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data,
              let connections = try? JSONDecoder().decode([ServerConnection].self, from: data) else {
            return []
        }
        return connections
    }

    static func deleteAll() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
```

### 4.4 Connection & Background Strategy

**iOS aggressively kills WebSocket connections when the app is backgrounded.** Do NOT attempt to keep WebSocket alive in the background.

Strategy:
1. When the app enters background (`scenePhase == .background`), gracefully disconnect all `OpenWorkPTYSession` WebSockets
2. When the app returns to foreground (`scenePhase == .active`), reconnect and re-receive history via the `pty-history` message
3. Show a "Reconnecting…" overlay during reconnection
4. PTY sessions continue running on the server regardless of the iOS app's state — no work is lost

```swift
// In ContentView.swift
@Environment(\.scenePhase) private var scenePhase

.onChange(of: scenePhase) { _, newPhase in
    switch newPhase {
    case .active:
        // Reconnect all active PTY sessions
        sessionManager.reconnectAll()
    case .background:
        // Gracefully disconnect WebSockets
        sessionManager.disconnectAll()
    default:
        break
    }
}
```


---


## 5. Session Architecture — The PTY Model

### 5.1 Understanding the PTY Model

This is the most important section for iOS developers unfamiliar with the backend.

**There is no chat protocol.** OpenWork does not have a structured `{role: "user", content: "text"}` message-based chat API for live sessions. Instead:

1. The server spawns a CLI tool (e.g., `claude`) inside a **pseudo-terminal (PTY)**
2. The PTY produces raw terminal output (including ANSI escape codes for colors, cursor movement, etc.)
3. The iOS app receives this output as text chunks over WebSocket
4. The iOS app sends user input as raw text written to the PTY's stdin

This is fundamentally a **terminal** interface, not a chat interface.

### 5.2 Two Types of Session Interaction

| Type | API | Use Case |
|------|-----|----------|
| **Live PTY Session** | `POST /api/sessions` → `/api/pty/{id}/ws` | Active interaction with Claude/Codex/Cursor |
| **Session History** | `GET /api/session-history/{id}/messages` | Read-only view of past completed sessions |

### 5.3 Live Session Lifecycle

```
┌──────────────────────────────────────────────────────┐
│                   iOS App                            │
│                                                      │
│  1. POST /api/sessions                               │
│     Body: { "project_path": "...",                   │
│             "provider": "claude" }                   │
│     Response: { "ok": true, "ptyId": "abc-123" }    │
│                                                      │
│  2. Connect WebSocket:                               │
│     ws://host:3002/api/pty/abc-123/ws?token=xyz      │
│                                                      │
│  3. Receive { "type": "pty-history", "data": "..." } │
│     (last 200 lines of previous output, if any)      │
│                                                      │
│  4. Receive { "type": "pty-output", "data": "..." }  │
│     (live terminal output, chunk by chunk)            │
│                                                      │
│  5. User types prompt → Send:                        │
│     { "type": "pty-input", "data": "fix the bug\n" } │
│     OR via REST: POST /api/sessions/abc-123/send     │
│                  Body: { "text": "fix the bug\n" }   │
│                                                      │
│  6. Receive more pty-output as Claude responds       │
│                                                      │
│  7. Eventually: { "type": "pty-exit", "code": 0 }   │
│     (session ended)                                  │
└──────────────────────────────────────────────────────┘
```

### 5.4 Input Delivery: WebSocket vs REST

There are two ways to send input to a PTY session:

| Method | When to Use |
|--------|-------------|
| `{ "type": "pty-input", "data": "text\n" }` via WebSocket | When WebSocket is already connected. Lower latency. |
| `POST /api/sessions/{ptyId}/send` with `{ "text": "text\n" }` | When WebSocket is disconnected or for one-off sends from a notification action. |

Both write directly to the PTY stdin. **Include `\n` at the end if you want the CLI to process the input as a submitted line.**

### 5.5 What PTY Output Looks Like

PTY output is **raw terminal data**. Example from a Claude session:

```
\x1b[1;34m❯\x1b[0m What would you like to work on?\n
\x1b[2m(type your message, then press Enter twice to send)\x1b[0m\n
```

After ANSI stripping:
```
❯ What would you like to work on?
(type your message, then press Enter twice to send)
```

### 5.6 ANSI Handling Strategy

**Do NOT attempt full VT100 terminal emulation.** That requires tracking cursor position, screen buffer, scrollback — hundreds of control sequences. Instead:

| Approach | Complexity | Recommendation |
|----------|------------|----------------|
| Strip all ANSI, plain text | Low | Good for v1 MVP |
| Parse SGR (colors/bold) only, strip cursor sequences | Medium | Recommended for v2 |
| Full terminal emulator | Very High | Out of scope; use a library like SwiftTerm if needed |

**Recommended approach for v1-v2:**

1. Strip cursor movement sequences: `ESC[{n}A`, `ESC[{n}B`, `ESC[{n}C`, `ESC[{n}D`, `ESC[H`, `ESC[2J`, `ESC[K`, etc.
2. Parse SGR sequences (`ESC[{n}m`) for basic colors and bold
3. Render into `NSAttributedString` with colored text
4. Display in a `UITextView` wrapped in `UIViewRepresentable`
5. Use a **sliding window buffer** (last 5000 lines) to prevent unbounded memory growth
6. Use **incremental rendering** — parse only new output chunks and append to the attributed string (do NOT re-parse the entire buffer on each update)

**VT100 sequence support status:**

| Sequence | Supported | Notes |
|----------|-----------|-------|
| ANSI color codes (SGR: `\e[...m`) | ✅ | Standard 8/16 colors + bold/italic/underline |
| Bold/italic (SGR) | ✅ | Italic uses oblique trait on monospace |
| Cursor movement (`\e[A`, `\e[B`, `\e[C`, `\e[D`) | ❌ | Not supported — stripped silently. Acknowledged limitation. |
| Screen clear (`\e[2J`) | ⚠️ | Handled by clearing the view buffer |
| Carriage return (`\r`) | ⚠️ | Handled correctly — overwrites current line |
| 256-color / Truecolor (`\e[38;5;N`, `\e[38;2;R;G;B`) | ❌ | Ignored for now |

> **For production use with complex TUI programs (vim, htop, etc.), consider integrating a proper VT100 terminal emulator library like [SwiftTerm](https://github.com/migueldeicaza/SwiftTerm).** The approach in this document is designed for AI CLI session output (mostly text with color), not full terminal emulation.

### 5.7 Detecting "Waiting for Input" State

The Rust backend detects waiting patterns and transitions the session to `WaitingForInput` state. The iOS app can:

1. Poll `GET /api/sessions` to see session states
2. Or (better) parse PTY output locally for patterns like `[y/n]`, `press enter`, `continue?`

When detected, show a prominent input bar or quick-action buttons (e.g., "Yes" / "No" buttons for `[y/n]` prompts).


---


## 6. Screen-by-Screen Design

### 6.1 Navigation Flow

```
ConnectionSetupView          (no server → shown first)
    │
    ▼
ServerListView               (multiple servers)
    │
    ▼
ProjectsListView             (projects for selected server)
    │
    ├──▶ SessionsListView    (sessions for a project — active + history)
    │       │
    │       ├──▶ SessionView (live PTY interaction)
    │       └──▶ HistoryView (read-only past session messages)
    │
    └──▶ NewSessionSheet     (pick provider → creates session → SessionView)
```

### 6.2 ConnectionSetupView

**Purpose:** Pair with a desktop OpenWork server.

**Fields:**
- Server name (optional label, e.g., "Office Mac")
- Host/IP (e.g., `192.168.1.42`)
- Port (default: `3002`, editable)
- Token (UUID string — paste or scan QR)

**Actions:**
- "Scan QR Code" button → camera view → decode JSON → auto-fill all fields
- "Connect" button → validates by calling `GET /health` then `GET /api/sessions` (with token)
- On success → save to Keychain → navigate to ProjectsListView

**Error states:**
- Network unreachable → "Cannot reach server. Check IP and port."
- 401 Unauthorized → "Invalid token. Check the token on your desktop app."

### 6.3 ProjectsListView

**Purpose:** Show all registered projects.

**Data source:** `GET /api/projects` → `[Project]`

**Row contents:**
- Project name
- Path (dimmed)
- Session count badge (`project.sessions.count`)
- Last accessed timestamp

**Actions:**
- Tap row → `SessionsListView` for that project
- Pull to refresh
- Long-press → "Remove Project" (calls `POST /api/projects/remove`)

### 6.4 SessionsListView

**Purpose:** Show active + historical sessions for a project.

**Sections:**

1. **Unattributed Sessions** (shown only when needed) — Active sessions from `GET /api/sessions` that cannot be matched to any project. Displayed at the top as a special section to ensure no sessions are silently hidden.

2. **Active Sessions** — Active PTY sessions matched to this project using the three-step resolution strategy below. Shows state badge (Running / WaitingForInput / etc.).

3. **Past Sessions** — from `GET /api/session-history?project_path=...&provider=claude`. Shows session date, message count, last message preview.
   - **Provider-aware behavior:** By default, only Claude history is shown. For Codex, also attempt `GET /api/session-history?project_path=...&provider=codex` and display results if any are returned. Cursor has no session history support (see §3.11 Provider Capability Matrix).

**Active Session → Project Resolution Strategy:**

The `GET /api/sessions` response returns `{id, state, provider, project_path}`. However, `project_path` requires a backend enhancement (see §3.4) and may be `null` on older backends. The iOS app uses a three-step resolution:

- **Step A (primary):** After backend enhancement, use `project_path` from `ActiveSessionInfo` directly to match the session to a project. This is the fastest and most reliable method.
- **Step B (fallback for older backend / `project_path` is null):** Cross-reference `session_history` to find which project a session ID was previously associated with via `GET /api/session-history?project_path={this_project_path}`. If the session ID appears in the history results, it belongs to this project.
- **Step C (last resort):** If no project association can be determined through Steps A or B, show the session in a special "Unattributed Sessions" section at the top of the ProjectsListView (not nested under any specific project).

> **Note:** Since `provider` is currently always `None` in the `GET /api/sessions` response, iOS should treat `provider` as optional and default to `"claude"` when nil. Use `ActiveSessionInfo.effectiveProvider` (see §3.4).

**Actions:**
- Tap active session → `SessionView` (connect to existing PTY)
- Tap past session → `HistoryView` (read-only, loads messages from history API)
- "New Session" FAB → `NewSessionSheet`

### 6.5 NewSessionSheet

**Purpose:** Create a new PTY session.

**Fields:**
- Provider picker: Claude / Codex / Cursor (segmented control)
- Resume session toggle (optional, shows recent session IDs to resume)

**Provider-aware UI behavior** (see §3.11 Provider Capability Matrix):
- **When Codex is selected:** Disable the "Resume session" toggle/section and show an explanatory label: *"Codex does not support resuming sessions."*
- **When Cursor is selected:** Disable the "Resume session" toggle/section and show: *"Cursor does not support resuming sessions."* Also hide or grey out the commands (slash `/`) button in the subsequent `SessionView`, since `GET /api/commands/discover` returns empty results for Cursor.
- **When Claude is selected:** All features available — resume session toggle is enabled, commands button is visible.

**Action:**
- Calls `POST /api/sessions` with `{ project_path, provider, resume_session_id? }`
- On success → navigates to `SessionView` with returned `ptyId`

### 6.6 SessionView (The Core Screen)

**Purpose:** Live interaction with a PTY session. This is the main screen users spend time on.

**Layout:**
```
┌─────────────────────────────────┐
│  ← Project Name    ● Running    │  ← Navigation bar with state badge
├─────────────────────────────────┤
│                                 │
│  PTY Output Area                │  ← Scrollable terminal-style text
│  (UITextView with attributed    │
│   string, dark background,      │
│   monospace font)               │
│                                 │
│  ❯ What would you like to       │
│    work on?                     │
│                                 │
├─────────────────────────────────┤
│  [/ Commands]  [Type message…]  │  ← Input bar
│                          [Send] │
└─────────────────────────────────┘
```

**PTY Output Area:**
- Dark background (`#1e1e1e`), monospace font (SF Mono or Menlo)
- ANSI colors rendered as `NSAttributedString` attributes
- Auto-scrolls to bottom on new output
- Scroll up pauses auto-scroll; "Jump to bottom" FAB appears

**Input Bar:**
- Text field with send button
- "/" button opens CommandPickerSheet (slash commands and skills)
- When `WaitingForInput` detected, show quick-action buttons above input bar

**Sending input:**
- On send: call `POST /api/sessions/{ptyId}/send` with `{"text": "user input\n"}`
  (REST is simpler and more reliable than WS for input delivery)
- Input is appended to the PTY; the CLI will echo it back in the output stream

**Session ended:**
- When `pty-exit` received: show "Session ended (exit code: N)" banner
- Disable input bar
- Show "View History" button (navigates to history view with structured messages)

### 6.7 HistoryView (Read-Only)

**Purpose:** View past session messages in a structured format.

**Data source:** `GET /api/session-history/{session_id}/messages?project_path=...&provider=...`

**Layout:**
- Structured message list (unlike live PTY, history has parsed `role` + `content`)
- User messages: right-aligned bubbles
- Assistant messages: left-aligned, with markdown rendering if possible
- Uses `SessionMessage.textContent` computed property to extract text from JSON content

### 6.8 SettingsView

**Contents:**
- Current server connection info
- Token (masked, with copy button)
- Switch server (if multiple)
- Disconnect / remove server
- App version
- "About OpenWork" link


---


## 7. Gesture Design

### 7.1 Gesture Table

| Screen | Gesture | Action | Haptic |
|--------|---------|--------|--------|
| ProjectsListView | Pull down | Refresh project list | `.impact(.light)` |
| ProjectsListView | Long press row | Context menu: Remove Project | `.impact(.medium)` |
| SessionsListView | Pull down | Refresh active + history sessions | `.impact(.light)` |
| SessionsListView | Swipe left (active) | Kill session | `.notificationOccurred(.warning)` |
| SessionView | Scroll up | Pause auto-scroll, show "Jump to bottom" | None |
| SessionView | Tap "Jump to bottom" | Resume auto-scroll to latest output | `.impact(.light)` |
| SessionView | Double-tap output | Select text for copy | `.selectionChanged()` |
| SessionView | Long press output | Context menu: Copy, Select All | `.impact(.medium)` |
| SessionView | Swipe right from edge | Back to sessions list | `.impact(.light)` |
| ConnectionSetupView | Tap "Scan QR" | Open camera for QR scan | `.impact(.medium)` |

### 7.2 iPad-Specific

Use `NavigationSplitView` with three columns:

```swift
NavigationSplitView {
    ProjectsListView()           // Sidebar
} content: {
    SessionsListView()           // Content
} detail: {
    SessionView()                // Detail — PTY output + input
}
```

### 7.3 Haptic Feedback Implementation

```swift
import UIKit

enum HapticManager {
    static func impact(_ style: UIImpactFeedbackGenerator.FeedbackStyle) {
        UIImpactFeedbackGenerator(style: style).impactOccurred()
    }

    static func notification(_ type: UINotificationFeedbackGenerator.FeedbackType) {
        UINotificationFeedbackGenerator().notificationOccurred(type)
    }

    static func selection() {
        UISelectionFeedbackGenerator().selectionChanged()
    }
}
```


---


## 8. SwiftUI Code Skeletons

### 8.1 App Entry Point

**Ownership rule:** `ConnectionViewModel` is the **single owner** of `OpenWorkAPIClient`. The app entry point should NOT inject a separate `apiClient` into the environment — only `ConnectionViewModel` is injected. All child views that need the API client access it via `connectionVM.apiClient` (which is the `currentAPIClient` property).

```swift
import SwiftUI

@main
struct OpenWorkMobileApp: App {
    @State private var connectionVM = ConnectionViewModel()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(connectionVM)
            // DO NOT also inject a separate apiClient — ConnectionViewModel owns it
        }
    }
}
```

### 8.2 ContentView (Root Navigation)

```swift
import SwiftUI

struct ContentView: View {
    @Environment(ConnectionViewModel.self) private var connectionVM
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            if connectionVM.isConnected {
                MainNavigationView()
            } else {
                ConnectionSetupView()
            }
        }
        .onChange(of: scenePhase) { _, newPhase in
            switch newPhase {
            case .active:
                connectionVM.reconnectIfNeeded()
            case .background:
                connectionVM.disconnectSessions()
            default:
                break
            }
        }
    }
}

struct MainNavigationView: View {
    var body: some View {
        NavigationSplitView {
            ProjectsListView()
        } detail: {
            Text("Select a project")
                .foregroundStyle(.secondary)
        }
    }
}
```

### 8.3 ConnectionSetupView

```swift
import SwiftUI
import AVFoundation

struct ConnectionSetupView: View {
    @Environment(ConnectionViewModel.self) private var viewModel
    @State private var host = ""
    @State private var port = "3002"
    @State private var token = ""
    @State private var serverName = ""
    @State private var showQRScanner = false
    @State private var isConnecting = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Server") {
                    TextField("Name (optional)", text: $serverName)
                        .textContentType(.organizationName)
                    TextField("IP Address", text: $host)
                        .keyboardType(.decimalPad)
                        .textContentType(.URL)
                        .autocorrectionDisabled()
                    TextField("Port", text: $port)
                        .keyboardType(.numberPad)
                }

                Section("Authentication") {
                    SecureField("API Token", text: $token)
                        .textContentType(.password)
                        .autocorrectionDisabled()
                    Text("Find the token in your desktop app under Settings, or in ~/.openwork/api-token.txt")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Section {
                    Button {
                        showQRScanner = true
                        HapticManager.impact(.medium)
                    } label: {
                        Label("Scan QR Code", systemImage: "qrcode.viewfinder")
                    }
                }

                if let error = errorMessage {
                    Section {
                        Text(error)
                            .foregroundStyle(.red)
                            .font(.callout)
                    }
                }

                Section {
                    Button {
                        Task { await connect() }
                    } label: {
                        HStack {
                            Spacer()
                            if isConnecting {
                                ProgressView()
                            } else {
                                Text("Connect")
                                    .fontWeight(.semibold)
                            }
                            Spacer()
                        }
                    }
                    .disabled(host.isEmpty || token.isEmpty || isConnecting)
                }
            }
            .navigationTitle("Add Server")
            .sheet(isPresented: $showQRScanner) {
                QRScannerView { result in
                    parseQRResult(result)
                    showQRScanner = false
                }
            }
        }
    }

    private func connect() async {
        isConnecting = true
        errorMessage = nil

        let portInt = Int(port) ?? 3002
        let connection = ServerConnection(
            name: serverName.isEmpty ? host : serverName,
            host: host,
            port: portInt,
            token: token.trimmingCharacters(in: .whitespacesAndNewlines)
        )

        do {
            try await viewModel.validateAndSave(connection)
            HapticManager.notification(.success)
        } catch APIError.unauthorized {
            errorMessage = "Invalid token. Check the token on your desktop app."
            HapticManager.notification(.error)
        } catch {
            errorMessage = "Cannot reach server: \(error.localizedDescription)"
            HapticManager.notification(.error)
        }

        isConnecting = false
    }

    private func parseQRResult(_ string: String) {
        guard let data = string.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            errorMessage = "Invalid QR code format"
            return
        }
        if let h = json["host"] as? String { host = h }
        if let p = json["port"] as? Int { port = String(p) }
        if let t = json["token"] as? String { token = t }
    }
}
```

### 8.4 ConnectionViewModel

```swift
import Foundation

@Observable
final class ConnectionViewModel {
    var connections: [ServerConnection] = []
    var activeConnection: ServerConnection?
    var isConnected = false

    private let apiClient = OpenWorkAPIClient()

    init() {
        connections = TokenStorage.loadConnections()
        if let first = connections.first {
            activateConnection(first)
        }
    }

    func validateAndSave(_ connection: ServerConnection) async throws {
        // Step 1: Health check (no auth)
        apiClient.connection = connection
        _ = try await apiClient.health()

        // Step 2: Authenticated request to verify token
        _ = try await apiClient.listActiveSessions()

        // Success — persist
        var updated = connections
        if let idx = updated.firstIndex(where: { $0.id == connection.id }) {
            updated[idx] = connection
        } else {
            updated.append(connection)
        }
        connections = updated
        TokenStorage.saveConnections(updated)
        activateConnection(connection)
    }

    func activateConnection(_ connection: ServerConnection) {
        activeConnection = connection
        apiClient.connection = connection
        isConnected = true
    }

    func disconnect() {
        activeConnection = nil
        apiClient.connection = nil
        isConnected = false
    }

    func removeConnection(_ connection: ServerConnection) {
        connections.removeAll { $0.id == connection.id }
        TokenStorage.saveConnections(connections)
        if activeConnection?.id == connection.id {
            disconnect()
        }
    }

    func reconnectIfNeeded() {
        // Called when app returns to foreground
        // Re-validate the connection asynchronously
        guard let conn = activeConnection else { return }
        Task {
            do {
                apiClient.connection = conn
                _ = try await apiClient.health()
                isConnected = true
            } catch {
                isConnected = false
            }
        }
    }

    func disconnectSessions() {
        // Called when app goes to background
        // WebSocket disconnection is handled by individual PTY sessions
    }

    var currentAPIClient: OpenWorkAPIClient { apiClient }
}
```

### 8.5 ProjectsListView

```swift
import SwiftUI

struct ProjectsListView: View {
    @Environment(ConnectionViewModel.self) private var connectionVM
    @State private var projects: [Project] = []
    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        List {
            ForEach(projects) { project in
                NavigationLink(value: project) {
                    ProjectRow(project: project)
                }
            }
        }
        .navigationTitle("Projects")
        .navigationDestination(for: Project.self) { project in
            SessionsListView(project: project)
        }
        .refreshable {
            await loadProjects()
        }
        .overlay {
            if isLoading && projects.isEmpty {
                ProgressView("Loading projects…")
            } else if let error = errorMessage, projects.isEmpty {
                ContentUnavailableView {
                    Label("Error", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(error)
                }
            } else if projects.isEmpty && !isLoading {
                ContentUnavailableView {
                    Label("No Projects", systemImage: "folder")
                } description: {
                    Text("No projects registered on the server.")
                }
            }
        }
        .task {
            await loadProjects()
        }
    }

    private func loadProjects() async {
        isLoading = true
        errorMessage = nil
        do {
            projects = try await connectionVM.currentAPIClient.listProjects()
        } catch APIError.unauthorized {
            errorMessage = "Token invalid — re-pair required"
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }
}

struct ProjectRow: View {
    let project: Project

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(project.name)
                .font(.headline)
            Text(project.path)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            if !project.sessions.isEmpty {
                Text("\(project.sessions.count) session\(project.sessions.count == 1 ? "" : "s")")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 4)
    }
}
```

### 8.6 SessionsListView

```swift
import SwiftUI

struct SessionsListView: View {
    let project: Project
    @Environment(ConnectionViewModel.self) private var connectionVM
    @State private var activeSessions: [ActiveSessionInfo] = []
    @State private var historySessions: [SessionSummary] = []
    @State private var showNewSession = false
    @State private var selectedPtyId: String?
    @State private var isLoading = false

    var body: some View {
        List {
            // Active sessions section
            if !activeSessions.isEmpty {
                Section("Active") {
                    ForEach(activeSessions) { session in
                        NavigationLink(value: session.id) {
                            ActiveSessionRow(session: session)
                        }
                    }
                    .onDelete { indexSet in
                        killSessions(at: indexSet)
                    }
                }
            }

            // Project's known sessions (from disk)
            if !project.sessions.isEmpty {
                Section("Recent Sessions") {
                    ForEach(project.sessions) { session in
                        SessionRow(session: session)
                    }
                }
            }

            // History section
            if !historySessions.isEmpty {
                Section("History") {
                    ForEach(historySessions) { summary in
                        NavigationLink(value: summary) {
                            HistorySessionRow(summary: summary)
                        }
                    }
                }
            }
        }
        .navigationTitle(project.name)
        .navigationDestination(for: String.self) { ptyId in
            SessionView(
                ptyId: ptyId,
                projectPath: project.path,
                connection: connectionVM.activeConnection!
            )
        }
        .navigationDestination(for: SessionSummary.self) { summary in
            HistoryView(summary: summary)
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    showNewSession = true
                } label: {
                    Image(systemName: "plus")
                }
            }
        }
        .sheet(isPresented: $showNewSession) {
            NewSessionSheet(project: project) { ptyId in
                selectedPtyId = ptyId
                showNewSession = false
            }
        }
        .refreshable {
            await loadSessions()
        }
        .task {
            await loadSessions()
        }
    }

    private func loadSessions() async {
        isLoading = true
        let client = connectionVM.currentAPIClient

        // Fetch active sessions + history in parallel
        async let activeTask = client.listActiveSessions()
        async let historyTask = client.sessionHistory(
            projectPath: project.path,
            provider: "claude"
        )
        do {
            let allActive = try await activeTask
            historySessions = try await historyTask

            // Three-step resolution: match active sessions to this project
            let historyIds = Set(historySessions.map(\.sessionId))
            let projectSessionIds = Set(project.sessions.map(\.id))

            activeSessions = allActive.filter { session in
                // Step A: Use project_path from backend (requires enhancement)
                if let pp = session.projectPath, pp == project.path {
                    return true
                }
                // Step B: Cross-reference with project's known sessions
                if projectSessionIds.contains(session.id) {
                    return true
                }
                // Step B (cont): Cross-reference with history
                if historyIds.contains(session.id) {
                    return true
                }
                // Step C: Session is unattributed — shown elsewhere in ProjectsListView
                return false
            }
        } catch {
            // Handle error
        }
        isLoading = false
    }

    private func killSessions(at offsets: IndexSet) {
        let client = connectionVM.currentAPIClient
        for index in offsets {
            let session = activeSessions[index]
            Task {
                try? await client.killSession(ptyId: session.id)
                await loadSessions()
            }
        }
        HapticManager.notification(.warning)
    }
}

struct ActiveSessionRow: View {
    let session: ActiveSessionInfo

    var body: some View {
        HStack {
            VStack(alignment: .leading) {
                Text(session.id.prefix(8) + "…")
                    .font(.headline.monospaced())
                if let provider = session.provider {
                    Text(provider)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            SessionStateBadge(state: session.state)
        }
    }
}

struct SessionStateBadge: View {
    let state: String

    var body: some View {
        Text(state)
            .font(.caption2)
            .fontWeight(.medium)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(backgroundColor.opacity(0.15))
            .foregroundStyle(backgroundColor)
            .clipShape(Capsule())
    }

    private var backgroundColor: Color {
        switch state {
        case "Running": return .green
        case "WaitingForInput": return .orange
        case "Completed": return .blue
        case "Failed": return .red
        default: return .gray
        }
    }
}

struct SessionRow: View {
    let session: Session

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(session.id.prefix(8) + "…")
                    .font(.subheadline.monospaced())
                Spacer()
                Text(session.provider)
                    .font(.caption)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(.quaternary)
                    .clipShape(Capsule())
            }
            if let msg = session.lastMessage {
                Text(msg)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            HStack {
                Text("\(session.messageCount) messages")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                if let date = session.createdAt {
                    Text("· \(date)")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .padding(.vertical, 2)
    }
}

struct HistorySessionRow: View {
    let summary: SessionSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(summary.sessionId.prefix(8) + "…")
                    .font(.subheadline.monospaced())
                Spacer()
                Text(summary.provider)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let msg = summary.lastMessage {
                Text(msg)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Text("\(summary.messageCount) messages")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 2)
    }
}
```

### 8.7 NewSessionSheet

```swift
import SwiftUI

struct NewSessionSheet: View {
    let project: Project
    let onCreated: (String) -> Void

    @Environment(ConnectionViewModel.self) private var connectionVM
    @Environment(\.dismiss) private var dismiss
    @State private var provider = "claude"
    @State private var resumeSessionId: String?
    @State private var isCreating = false
    @State private var errorMessage: String?

    private let providers = ["claude", "codex", "cursor"]

    var body: some View {
        NavigationStack {
            Form {
                Section("Provider") {
                    Picker("Provider", selection: $provider) {
                        ForEach(providers, id: \.self) { p in
                            Text(p.capitalized).tag(p)
                        }
                    }
                    .pickerStyle(.segmented)
                }

                if !project.sessions.isEmpty {
                    Section("Resume Session (optional)") {
                        ForEach(project.sessions.prefix(5)) { session in
                            Button {
                                resumeSessionId = session.id
                            } label: {
                                HStack {
                                    VStack(alignment: .leading) {
                                        Text(session.id.prefix(12) + "…")
                                            .font(.caption.monospaced())
                                        if let msg = session.lastMessage {
                                            Text(msg)
                                                .font(.caption2)
                                                .foregroundStyle(.secondary)
                                                .lineLimit(1)
                                        }
                                    }
                                    Spacer()
                                    if resumeSessionId == session.id {
                                        Image(systemName: "checkmark")
                                            .foregroundStyle(.blue)
                                    }
                                }
                            }
                            .tint(.primary)
                        }
                    }
                }

                if let error = errorMessage {
                    Section {
                        Text(error).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("New Session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") {
                        Task { await createSession() }
                    }
                    .disabled(isCreating)
                }
            }
        }
    }

    private func createSession() async {
        isCreating = true
        errorMessage = nil
        do {
            let ptyId = try await connectionVM.currentAPIClient.createSession(
                projectPath: project.path,
                provider: provider,
                resumeSessionId: resumeSessionId
            )
            HapticManager.notification(.success)
            onCreated(ptyId)
        } catch {
            errorMessage = error.localizedDescription
            HapticManager.notification(.error)
        }
        isCreating = false
    }
}
```

### 8.8 SessionView (The Core PTY Screen)

```swift
import SwiftUI

struct SessionView: View {
    let ptyId: String
    let projectPath: String
    let connection: ServerConnection
    @Environment(ConnectionViewModel.self) private var connectionVM

    @State private var ptySession: OpenWorkPTYSession
    @State private var inputText = ""
    @State private var autoScroll = true
    @State private var showCommands = false

    init(ptyId: String, projectPath: String, connection: ServerConnection) {
        self.ptyId = ptyId
        self.projectPath = projectPath
        self.connection = connection
        self._ptySession = State(initialValue: OpenWorkPTYSession(
            ptyId: ptyId,
            connection: connection
        ))
    }

    var body: some View {
        VStack(spacing: 0) {
            // PTY Output
            PTYOutputView(
                lines: ptySession.outputLines,
                autoScroll: $autoScroll
            )

            // Connection status bar
            if ptySession.isConnecting {
                HStack {
                    ProgressView()
                        .controlSize(.small)
                    Text("Connecting…")
                        .font(.caption)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
                .background(.ultraThinMaterial)
            } else if !ptySession.isConnected && !ptySession.hasExited {
                HStack {
                    ProgressView()
                        .controlSize(.small)
                    Text("Reconnecting…")
                        .font(.caption)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
                .background(.ultraThinMaterial)
            }

            // Exit banner
            if ptySession.hasExited {
                HStack {
                    Image(systemName: "checkmark.circle")
                    Text("Session ended (exit code: \(ptySession.exitCode.map(String.init) ?? "unknown"))")
                        .font(.callout)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
                .background(ptySession.exitCode == 0 ? Color.green.opacity(0.1) : Color.red.opacity(0.1))
            }

            // Input bar
            if !ptySession.hasExited {
                HStack(spacing: 8) {
                    Button {
                        showCommands = true
                    } label: {
                        Image(systemName: "slash.circle")
                            .font(.title3)
                    }

                    TextField("Type message…", text: $inputText, axis: .vertical)
                        .textFieldStyle(.plain)
                        .lineLimit(1...5)
                        .onSubmit { sendInput() }

                    Button {
                        sendInput()
                    } label: {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.title2)
                    }
                    .disabled(inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(.bar)
            }
        }
        .navigationTitle(ptyId.prefix(8) + "…")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showCommands) {
            CommandPickerSheet(projectPath: projectPath) { command in
                inputText = "/\(command)"
                showCommands = false
            }
        }
        .overlay(alignment: .bottomTrailing) {
            if !autoScroll && !ptySession.hasExited {
                Button {
                    autoScroll = true
                    HapticManager.impact(.light)
                } label: {
                    Image(systemName: "arrow.down.circle.fill")
                        .font(.title)
                        .symbolRenderingMode(.hierarchical)
                        .padding(12)
                }
            }
        }
        .onAppear {
            ptySession.connect()
        }
        .onDisappear {
            ptySession.disconnect()
        }
    }

    private func sendInput() {
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        // Send via REST for reliability — use connectionVM's API client (single owner)
        Task {
            try? await connectionVM.currentAPIClient.sendToSession(ptyId: ptyId, text: text + "\n")
        }
        inputText = ""
        autoScroll = true
        HapticManager.impact(.light)
    }
}
```

### 8.9 PTYOutputView

A `UITextView` wrapper that renders PTY output with basic ANSI color support. **Uses incremental rendering** — only new output is parsed and appended, avoiding quadratic re-parse of the entire buffer.

```swift
import SwiftUI
import UIKit

struct PTYOutputView: UIViewRepresentable {
    let lines: [String]
    @Binding var autoScroll: Bool

    func makeUIView(context: Context) -> UITextView {
        let textView = UITextView()
        textView.isEditable = false
        textView.backgroundColor = UIColor(red: 0.12, green: 0.12, blue: 0.14, alpha: 1)
        textView.textContainerInset = UIEdgeInsets(top: 8, left: 8, bottom: 8, right: 8)
        textView.font = UIFont.monospacedSystemFont(ofSize: 13, weight: .regular)
        textView.textColor = .white
        textView.delegate = context.coordinator
        textView.indicatorStyle = .white
        // Initialize the incremental attributed string
        context.coordinator.renderedOutput = NSMutableAttributedString()
        context.coordinator.renderedLineCount = 0
        return textView
    }

    func updateUIView(_ textView: UITextView, context: Context) {
        let coordinator = context.coordinator
        let currentCount = lines.count

        if currentCount < coordinator.renderedLineCount {
            // Buffer was trimmed from the front or cleared — re-render
            let fullText = lines.joined(separator: "\n")
            coordinator.renderedOutput = NSMutableAttributedString(attributedString: ANSIParser.parse(fullText))
            coordinator.renderedLineCount = currentCount
        } else if currentCount > coordinator.renderedLineCount {
            // Incremental: parse ONLY the new lines and append
            let newLines = lines[coordinator.renderedLineCount...]
            let newText = newLines.joined(separator: "\n")
            if coordinator.renderedLineCount > 0 {
                // Add separator between old and new content
                coordinator.renderedOutput.append(NSAttributedString(string: "\n", attributes: [
                    .font: UIFont.monospacedSystemFont(ofSize: 13, weight: .regular),
                    .foregroundColor: UIColor.white,
                ]))
            }
            coordinator.renderedOutput.append(ANSIParser.parse(newText))
            coordinator.renderedLineCount = currentCount

            // Enforce buffer limit by trimming the FRONT of the attributed string
            let maxChars = 500_000  // ~5000 lines at ~100 chars each
            if coordinator.renderedOutput.length > maxChars {
                let trimCount = coordinator.renderedOutput.length - maxChars
                coordinator.renderedOutput.deleteCharacters(in: NSRange(location: 0, length: trimCount))
            }
        }
        // else: no change

        textView.attributedText = coordinator.renderedOutput

        if autoScroll {
            let bottom = NSRange(location: textView.text.count, length: 0)
            textView.scrollRangeToVisible(bottom)
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(autoScroll: $autoScroll)
    }

    class Coordinator: NSObject, UITextViewDelegate {
        @Binding var autoScroll: Bool
        var renderedOutput = NSMutableAttributedString()
        var renderedLineCount = 0

        init(autoScroll: Binding<Bool>) {
            self._autoScroll = autoScroll
        }

        func scrollViewDidScroll(_ scrollView: UIScrollView) {
            let atBottom = scrollView.contentOffset.y >=
                (scrollView.contentSize.height - scrollView.frame.height - 50)
            if !atBottom && autoScroll {
                autoScroll = false
            }
        }
    }
}
```

### 8.10 ANSIParser

Parses SGR escape codes (colors, bold, italic, underline) into `NSAttributedString`. **Does NOT handle cursor movement sequences** — those are stripped. See §5.6 for the full VT100 support matrix.

> **Limitation:** This parser is designed for incremental use — call it on new output chunks only and append the result to the existing `NSMutableAttributedString`. Do NOT concatenate all output and re-parse from scratch, as that causes quadratic CPU/memory growth on long sessions. The 5000-line buffer limit is enforced by trimming the FRONT of the attributed string in `PTYOutputView` (see §8.9).

```swift
import UIKit

enum ANSIParser {
    /// Parse a string with ANSI escape codes into an NSAttributedString.
    /// Handles SGR (Select Graphic Rendition) codes for color/style.
    /// Strips all other escape sequences (cursor movement, etc.).
    static func parse(_ input: String) -> NSAttributedString {
        let result = NSMutableAttributedString()
        let defaultAttrs: [NSAttributedString.Key: Any] = [
            .font: UIFont.monospacedSystemFont(ofSize: 13, weight: .regular),
            .foregroundColor: UIColor.white,
        ]

        var currentAttrs = defaultAttrs
        var scanner = input[...]

        // Regex to match any ANSI escape sequence
        let ansiPattern = /\x1b\[([0-9;]*)([a-zA-Z])/

        var remaining = input
        while let match = remaining.firstMatch(of: ansiPattern) {
            // Append text before the escape sequence
            let prefix = remaining[remaining.startIndex..<match.range.lowerBound]
            if !prefix.isEmpty {
                result.append(NSAttributedString(string: String(prefix), attributes: currentAttrs))
            }

            // Process the escape sequence
            let params = String(match.1)
            let command = String(match.2)

            if command == "m" {
                // SGR — update current attributes
                currentAttrs = applySGR(params: params, current: currentAttrs, defaults: defaultAttrs)
            }
            // All other commands (cursor movement, erase, etc.) are silently stripped

            remaining = String(remaining[match.range.upperBound...])
        }

        // Append any remaining text
        if !remaining.isEmpty {
            result.append(NSAttributedString(string: remaining, attributes: currentAttrs))
        }

        return result
    }

    private static func applySGR(
        params: String,
        current: [NSAttributedString.Key: Any],
        defaults: [NSAttributedString.Key: Any]
    ) -> [NSAttributedString.Key: Any] {
        var attrs = current
        let codes = params.split(separator: ";").compactMap { Int($0) }

        // Empty or "0" → reset
        if codes.isEmpty {
            return defaults
        }

        for code in codes {
            switch code {
            case 0:
                attrs = defaults
            case 1:
                attrs[.font] = UIFont.monospacedSystemFont(ofSize: 13, weight: .bold)
            case 3:
                // Italic — monospace doesn't have true italic; use oblique trait
                if let font = attrs[.font] as? UIFont {
                    let descriptor = font.fontDescriptor.withSymbolicTraits(.traitItalic)
                    attrs[.font] = descriptor.map { UIFont(descriptor: $0, size: 0) } ?? font
                }
            case 4:
                attrs[.underlineStyle] = NSUnderlineStyle.single.rawValue
            case 22:
                attrs[.font] = UIFont.monospacedSystemFont(ofSize: 13, weight: .regular)
            case 24:
                attrs.removeValue(forKey: .underlineStyle)
            // Standard foreground colors (30-37)
            case 30: attrs[.foregroundColor] = UIColor.black
            case 31: attrs[.foregroundColor] = UIColor.systemRed
            case 32: attrs[.foregroundColor] = UIColor.systemGreen
            case 33: attrs[.foregroundColor] = UIColor.systemYellow
            case 34: attrs[.foregroundColor] = UIColor.systemBlue
            case 35: attrs[.foregroundColor] = UIColor.systemPurple
            case 36: attrs[.foregroundColor] = UIColor.systemCyan
            case 37: attrs[.foregroundColor] = UIColor.white
            case 39: attrs[.foregroundColor] = UIColor.white  // default fg
            // Bright foreground colors (90-97)
            case 90: attrs[.foregroundColor] = UIColor.darkGray
            case 91: attrs[.foregroundColor] = UIColor.systemRed
            case 92: attrs[.foregroundColor] = UIColor.systemGreen
            case 93: attrs[.foregroundColor] = UIColor.systemYellow
            case 94: attrs[.foregroundColor] = UIColor.systemBlue
            case 95: attrs[.foregroundColor] = UIColor.systemPurple
            case 96: attrs[.foregroundColor] = UIColor.systemCyan
            case 97: attrs[.foregroundColor] = UIColor.white
            // Background colors (40-47) — less important but included
            case 40...47:
                let fgColors: [UIColor] = [.black, .systemRed, .systemGreen, .systemYellow,
                                            .systemBlue, .systemPurple, .systemCyan, .white]
                attrs[.backgroundColor] = fgColors[code - 40]
            case 49:
                attrs.removeValue(forKey: .backgroundColor)
            default:
                break // 256-color and truecolor (38;5;N, 38;2;R;G;B) — ignore for now
            }
        }

        return attrs
    }
}
```

### 8.11 HistoryView

```swift
import SwiftUI

struct HistoryView: View {
    let summary: SessionSummary
    @Environment(ConnectionViewModel.self) private var connectionVM
    @State private var messages: [SessionMessage] = []
    @State private var isLoading = true

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                ForEach(messages) { message in
                    if message.isSidechain == true { /* skip sidechains */ }
                    else {
                        HistoryMessageBubble(message: message)
                    }
                }
            }
            .padding()
        }
        .navigationTitle("Session History")
        .navigationBarTitleDisplayMode(.inline)
        .overlay {
            if isLoading {
                ProgressView("Loading messages…")
            }
        }
        .task {
            await loadMessages()
        }
    }

    private func loadMessages() async {
        isLoading = true
        do {
            messages = try await connectionVM.currentAPIClient.sessionMessages(
                sessionId: summary.sessionId,
                projectPath: summary.projectPath,
                provider: summary.provider
            )
        } catch {
            // Handle error
        }
        isLoading = false
    }
}

struct HistoryMessageBubble: View {
    let message: SessionMessage

    var body: some View {
        VStack(alignment: message.role == "user" ? .trailing : .leading, spacing: 4) {
            HStack {
                if message.role == "user" { Spacer() }
                Text(message.textContent)
                    .font(.body)
                    .padding(12)
                    .background(
                        message.role == "user"
                            ? Color.blue.opacity(0.15)
                            : Color(.systemGray6)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                if message.role != "user" { Spacer() }
            }

            if let ts = message.timestamp {
                Text(ts)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
    }
}
```

### 8.12 CommandPickerSheet

```swift
import SwiftUI

struct CommandPickerSheet: View {
    let projectPath: String
    let onSelect: (String) -> Void

    @Environment(ConnectionViewModel.self) private var connectionVM
    @Environment(\.dismiss) private var dismiss
    @State private var commands: [DiscoveredCommand] = []
    @State private var skills: [DiscoveredSkill] = []
    @State private var isLoading = true

    var body: some View {
        NavigationStack {
            List {
                if !commands.isEmpty {
                    Section("Commands") {
                        ForEach(commands) { cmd in
                            Button {
                                onSelect(cmd.name)
                                dismiss()
                            } label: {
                                VStack(alignment: .leading) {
                                    Text("/\(cmd.name)")
                                        .font(.headline.monospaced())
                                    Text(cmd.description)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                    Text("\(cmd.scope)")
                                        .font(.caption2)
                                        .foregroundStyle(.tertiary)
                                }
                            }
                            .tint(.primary)
                        }
                    }
                }

                if !skills.isEmpty {
                    Section("Skills") {
                        ForEach(skills) { skill in
                            VStack(alignment: .leading) {
                                Text(skill.displayName)
                                    .font(.headline)
                                Text(skill.description)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                Text("\(skill.provider) · \(skill.scope)")
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                            }
                        }
                    }
                }
            }
            .navigationTitle("Commands & Skills")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .overlay {
                if isLoading {
                    ProgressView()
                }
            }
            .task {
                await loadCommands()
            }
        }
    }

    private func loadCommands() async {
        isLoading = true
        do {
            let result = try await connectionVM.currentAPIClient.discoverCommands(
                provider: "claude",
                projectPath: projectPath
            )
            commands = result.commands
            skills = result.skills
        } catch {
            // Show error
        }
        isLoading = false
    }
}
```


---


## 9. Xcode Project Setup

### 9.1 Capabilities & Info.plist

| Capability | Reason |
|------------|--------|
| **Keychain Sharing** | Store API tokens securely (group: `com.openwork.mobile`) |
| **Camera Usage** | QR code scanning for token pairing (`NSCameraUsageDescription`) |
| **Local Network Usage** | LAN communication with desktop app (`NSLocalNetworkUsageDescription`) |
| **Bonjour Services** (optional) | Auto-discover OpenWork servers on LAN |

### 9.2 Info.plist Keys

```xml
<key>NSCameraUsageDescription</key>
<string>OpenWork needs camera access to scan QR codes for server pairing.</string>
<key>NSLocalNetworkUsageDescription</key>
<string>OpenWork connects to your desktop app over your local network.</string>
<key>NSBonjourServices</key>
<array>
    <string>_openwork._tcp</string>
</array>
```

### 9.3 Build Settings

| Setting | Value |
|---------|-------|
| Deployment Target | iOS 17.0 |
| Swift Language Version | 6.0 |
| Supported Destinations | iPhone, iPad |
| Device Orientation (iPhone) | Portrait, Landscape |
| Device Orientation (iPad) | All |

### 9.4 Dependencies

**None.** The app uses only Apple frameworks:

- `Foundation` — networking, JSON, dates
- `SwiftUI` — UI
- `UIKit` — `UITextView` for PTY output, haptics
- `Security` — Keychain
- `AVFoundation` — QR code scanning


---


## 10. Implementation Phases

### Phase 1: Foundation (Week 1-2)

**Goal:** Connect to server, browse projects, view session history.

- [ ] `TokenStorage` — Keychain save/load
- [ ] `OpenWorkAPIClient` — health, localIP, tokenInfo, listProjects, sessionHistory, sessionMessages
- [ ] `ServerConnection` model
- [ ] `ConnectionSetupView` — manual IP/port/token entry + validation
- [ ] `ProjectsListView` — display projects from `GET /api/projects`
- [ ] `SessionsListView` — display project sessions + history
- [ ] `HistoryView` — read-only past session messages via history API
- [ ] Basic error handling (401 → re-pair prompt)

**Verification:**
- Can pair with desktop app via token entry
- Can browse projects and view session history
- Token persists across app launches

### Phase 2: Live Sessions (Week 3-4)

**Goal:** Create and interact with PTY sessions.

- [ ] `OpenWorkPTYSession` — WebSocket connection to `/api/pty/{id}/ws`
- [ ] `SessionView` — PTY output display + input bar
- [ ] `PTYOutputView` — `UITextView` wrapper with plain text (ANSI stripped)
- [ ] `ANSIParser` — basic strip-only parser (no color yet)
- [ ] `NewSessionSheet` — provider picker + session creation
- [ ] `POST /api/sessions` integration
- [ ] `POST /api/sessions/{id}/send` for input delivery
- [ ] Session state badges (Running, WaitingForInput, Completed, Failed)
- [ ] Foreground/background reconnection (`scenePhase`)

**Verification:**
- Can create a new Claude/Codex session
- Can see real-time PTY output
- Can send text input and see response
- Can background/foreground without losing session

### Phase 3: Polish (Week 5-6)

**Goal:** ANSI colors, commands, iPad, gestures.

- [ ] `ANSIParser` upgrade — SGR colors, bold, underline
- [ ] `CommandPickerSheet` — slash commands and skills discovery
- [ ] iPad `NavigationSplitView` three-column layout
- [ ] Haptic feedback on all gestures
- [ ] Pull-to-refresh on all lists
- [ ] Swipe-to-kill active sessions
- [ ] "Jump to bottom" FAB on PTY output
- [ ] Auto-scroll pause/resume
- [ ] Connection error recovery UI
- [ ] `SettingsView` — server management, token display

**Verification:**
- ANSI colored output renders correctly
- Commands discovery works
- iPad split view provides good experience
- All gestures feel responsive with haptics

### Phase 4: Advanced (Week 7-8)

**Goal:** QR pairing, multi-server, Bonjour, notifications.

- [ ] QR code scanning for token pairing
- [ ] QR code generation on desktop (Tauri command)
- [ ] Multi-server support (switch between servers)
- [ ] Bonjour/mDNS auto-discovery (optional)
- [ ] Local notifications when session needs attention (WaitingForInput detection)
- [ ] Session resume support (pass `resume_session_id`)
- [ ] Dark/Light mode theme with OpenWork brand colors
- [ ] Accessibility: Dynamic Type, VoiceOver labels
- [ ] App icon and launch screen


---


## 11. Appendix: Real API Reference

### 11.1 Complete Endpoint Table

All endpoints are on `http://{host}:3002`. Auth = `Authorization: Bearer {token}` header.

| Method | Path | Auth | Request Body | Response |
|--------|------|------|--------------|----------|
| `GET` | `/health` | No | — | `{"status":"ok","app":"openwork","lanUrl":"http://x:3002"}` |
| `GET` | `/api/local-ip` | No | — | `{"ip":"192.168.x.x","url":"http://x:3002"}` |
| `GET` | `/api/auth/token-info` | No | — | `{"hint":"Token is stored at ~/.openwork/api-token.txt"}` |
| `GET` | `/api/projects` | Yes | — | `[Project]` (bare array) |
| `POST` | `/api/projects` | Yes | `{"name":"N","path":"P"}` | `Project` |
| `POST` | `/api/projects/remove` | Yes | `{"path":"P"}` | `{"ok":true}` |
| `GET` | `/api/sessions` | Yes | — | `{"sessions":[SessionInfo]}` — see note ¹ |
| `POST` | `/api/sessions` | Yes | `{"project_path":"P","provider":"claude","resume_session_id":null}` | `{"ok":true,"ptyId":"id"}` |
| `POST` | `/api/sessions/{id}/send` | Yes | `{"text":"hello\n"}` | `{"ok":true}` |
| `POST` | `/api/sessions/{id}/kill` | Yes | — | `{"ok":true}` |
| `GET` | `/api/session-history` | Yes | Query: `project_path`, `provider`, `limit`, `offset` | `[SessionSummary]` (bare array) |
| `GET` | `/api/session-history/{id}/messages` | Yes | Query: `project_path`, `provider`, `limit`, `offset` | `[SessionMessage]` (bare array) |
| `GET` | `/api/commands/discover` | Yes | Query: `provider`, `project_path` | `{"ok":true,"data":{"commands":[…],"skills":[…]}}` — see note ² |
| `WS` | `/api/pty/{id}/ws` | Yes* | — | PTY stream (see §5) |
| `WS` | `/ws` | Yes** | — | General WS (ping/pong, list_sessions) |

\* Auth via `?token=` query param (required for WS upgrade under `/api/` path).
\** Auth via `?token=` query param or `Authorization` header (checked before WS upgrade).

**Endpoint notes:**

¹ **`GET /api/sessions`**: Currently returns `{id, state, provider}` where `provider` is always `null`. Proposed enhancement: add `project_path` field to the response (see §3.4). iOS should treat `provider` as optional and default to `"claude"` when nil.

² **`GET /api/commands/discover`**: Only returns meaningful data for `provider=claude` (commands + skills). For `provider=codex`, returns skills only (no commands). For `provider=cursor` and other providers, returns empty `{commands: [], skills: []}`. See §3.11 Provider Capability Matrix.

### 11.2 WebSocket Message Reference

#### PTY WebSocket (`/api/pty/{id}/ws`)

**Server → Client:**

| Type | Fields | When |
|------|--------|------|
| `pty-history` | `id: String`, `data: String` | On connect (last 200 lines joined by `\n`) |
| `pty-output` | `id: String`, `data: String` | Each output chunk (may contain ANSI) |
| `pty-exit` | `id: String`, `code: UInt32?` | Session ended |

**Client → Server:**

| Type | Fields | Effect |
|------|--------|--------|
| `pty-input` | `data: String` | Writes to PTY stdin |

#### General WebSocket (`/ws`)

**Server → Client:**

| Type | Fields | When |
|------|--------|------|
| `connected` | `app: "openwork"`, `version: "1.0"` | On connect |
| `pong` | — | Response to ping |
| `sessions` | `data: [{id, state}]` | Response to list_sessions |

**Client → Server:**

| Type | Effect |
|------|--------|
| `ping` | Server responds with `pong` |
| `list_sessions` | Server responds with `sessions` |

### 11.3 JSON Field Name Conventions

| Rust Struct | serde Attribute | JSON Keys |
|-------------|-----------------|-----------|
| `Project` | default | `name`, `path`, `full_path`, `description`, `sessions`, `created_at`, `last_accessed`, `config` |
| `Session` | default | `id`, `project_path`, `provider`, `name`, `created_at`, `last_message`, `message_count` |
| `SessionSummary` | default | `session_id`, `project_path`, `provider`, `name`, `message_count`, `last_message`, `created_at` |
| `SessionMessage` | default | `uuid`, `role`, `content`, `timestamp`, `is_sidechain` |
| `DiscoveredCommand` | `rename_all = "camelCase"` | `name`, `description`, `provider`, `scope`, `filePath` |
| `DiscoveredSkill` | `rename_all = "camelCase"` | `name`, `displayName`, `description`, `provider`, `scope` |
| `CommandDiscoveryResult` | `rename_all = "camelCase"` | `commands`, `skills` |
| `ActiveSessionInfo` | default | `id`, `state`, `provider`, `project_path` (proposed) |

### 11.4 Session States

The PTY session state machine (from `pty.rs`):

```
     ┌─── Idle ───┐
     │             │
     ▼             │
  Running ◄────────┘
     │    ▲
     │    │ (user sends input)
     ▼    │
  WaitingForInput
     │
     ▼
  Completed  (exit code 0)
  Failed     (exit code ≠ 0 or error)
```

State values as strings (from `format!("{:?}", state)` in Rust):
- `"Idle"`
- `"Running"`
- `"WaitingForInput"`
- `"Completed"`
- `"Failed"`

### 11.5 Error Response Formats

**401 Unauthorized** (from auth middleware):
```json
{ "error": "unauthorized" }
```

**Operation failure** (from session/project handlers):
```json
{ "ok": false, "error": "Session abc not found" }
```

**Project list error** (from list_projects):
```json
{ "error": "Failed to read projects.json: ..." }
```

### 11.6 Important Implementation Notes

1. **Port 3002 is hardcoded** in the Tauri backend. It does not use environment variables for the HTTP server port.

2. **Token regenerates on each app restart.** When the Tauri desktop app restarts, a new UUID is generated and written to `~/.openwork/api-token.txt`. The iOS app will need to re-pair.

3. **`POST /api/sessions/{id}/send` does NOT append `\n` automatically.** If you want the CLI to process the input as a submitted line, include `\n` in the text. Example: `{"text": "fix the bug\n"}`.

4. **`GET /api/projects` returns a bare JSON array**, not `{"projects":[]}`. Similarly, session history endpoints return bare arrays.

5. **`SessionMessage.content` is a JSON value, not a string.** The iOS decoder must use a type-erasing wrapper (like `AnyCodableValue`) to handle it. The content structure varies by provider.

6. **PTY output may contain any terminal escape sequence.** The ANSI parser should be defensive — strip sequences it doesn't understand rather than crashing.

7. **The WebSocket at `/api/pty/{id}/ws` is under the `/api/` path**, so it IS covered by the auth middleware. Pass the token via `?token=` query parameter in the WebSocket URL.

8. **The general WebSocket at `/ws` is NOT under `/api/`**, but it has its own auth check in `ws_handler` that validates the token from query params or headers before upgrading.

9. **The output buffer on the server holds the last 200 lines.** When the iOS app connects to a PTY WebSocket, it receives these as a `pty-history` message. This is the only history available for live sessions — for full history, use the session history API after the session ends.

10. **Claude CLI expects two newlines to submit input** in some modes. The iOS app should send the text as-is with a single `\n` — the user can send additional newlines if needed.


---

*End of document. This document is the single source of truth for the iOS app implementation and matches the actual Tauri/Rust backend as of v2.0.*
