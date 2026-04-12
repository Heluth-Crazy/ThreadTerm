# OpenWork iOS App — Implementation Plan

> **For agentic workers:** Implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task is ~5-10 minutes. Do NOT skip ahead.

**Goal:** Native iOS 17+ SwiftUI app that connects to OpenWork Tauri backend over LAN, enabling AI session management from iPhone/iPad.

**Architecture:** MVVM + Service Layer, URLSession WebSocket, Keychain token storage. Zero third-party dependencies.

**Tech Stack:** Swift 5.9+, SwiftUI, iOS 17+, URLSession, Security.framework (Keychain)

**Xcode Project:** `OpenWorkMobile/OpenWorkMobile.xcodeproj`

**Does NOT modify:** Any file in `src/`, `src-tauri/` (except one field addition), `server/`, `electron/`

**Total tasks:** 37 | **Estimated time:** ~5-6 hours

---
## Group 0: Backend Enhancement

### Task 0.1: Add `project_path` to ActiveSessionInfo in Rust backend

**Purpose:** The iOS app needs to know which project each active PTY session belongs to. Currently `GET /api/sessions` returns `{id, state, provider}` but no project path. The PTY session struct already stores `_working_dir` (which IS the project path), so we just need to expose it.

**Files:**
- Modify: `src-tauri/src/pty.rs`
- Modify: `src-tauri/src/http_server.rs`

- [ ] **Step 1: Update `list_sessions_internal()` in `pty.rs` to return working_dir**

  Open `src-tauri/src/pty.rs` and find the `list_sessions_internal` function (around line 585). Change its return type to include the working directory string:

  Replace:
  ```rust
  /// Returns a snapshot of active session IDs and their states.
  pub fn list_sessions_internal() -> Vec<(String, SessionState)> {
      PTY_SESSIONS
          .iter()
          .map(|entry| {
              let state = entry
                  .state
                  .read()
                  .map(|s| s.clone())
                  .unwrap_or(SessionState::Idle);
              (entry.key().clone(), state)
          })
          .collect()
  }
  ```

  With:
  ```rust
  /// Returns a snapshot of active session IDs, their states, and working directories.
  pub fn list_sessions_internal() -> Vec<(String, SessionState, String)> {
      PTY_SESSIONS
          .iter()
          .map(|entry| {
              let state = entry
                  .state
                  .read()
                  .map(|s| s.clone())
                  .unwrap_or(SessionState::Idle);
              let working_dir = entry._working_dir.clone();
              (entry.key().clone(), state, working_dir)
          })
          .collect()
  }
  ```

- [ ] **Step 2: Update `SessionInfo` struct in `http_server.rs`**

  Open `src-tauri/src/http_server.rs` and find the `SessionInfo` struct (around line 272). Add the `project_path` field:

  Replace:
  ```rust
  #[derive(Serialize)]
  struct SessionInfo {
      id: String,
      state: String,
      provider: Option<String>,
  }
  ```

  With:
  ```rust
  #[derive(Serialize)]
  struct SessionInfo {
      id: String,
      state: String,
      provider: Option<String>,
      project_path: Option<String>,
  }
  ```

- [ ] **Step 3: Update `list_sessions` handler in `http_server.rs`**

  Find the `list_sessions` function (around line 279). Update it to destructure the new tuple and populate `project_path`:

  Replace:
  ```rust
  async fn list_sessions(State(_state): State<Arc<AppState>>) -> Json<serde_json::Value> {
      let sessions = crate::pty::list_sessions_internal();
      let result: Vec<SessionInfo> = sessions
          .into_iter()
          .map(|(id, s)| SessionInfo {
              id,
              provider: None,
          })
          .collect();
  }
  ```

  With:
  ```rust
  async fn list_sessions(State(_state): State<Arc<AppState>>) -> Json<serde_json::Value> {
      let sessions = crate::pty::list_sessions_internal();
      let result: Vec<SessionInfo> = sessions
          .into_iter()
          .map(|(id, s, working_dir)| SessionInfo {
              id,
              provider: None,
              project_path: Some(working_dir),
          })
          .collect();
  }
  ```

- [ ] **Step 4: Update WebSocket `handle_ws_command` in `http_server.rs`**

  Find the `handle_ws_command` function (around line 558). The `list_sessions` WS command also calls `list_sessions_internal`. Update the destructuring:

  Replace:
  ```rust
          "list_sessions" => {
              let sessions = crate::pty::list_sessions_internal();
              let result: Vec<_> = sessions
                  .into_iter()
                  .map(|(id, state)| {
                          "id": id,
                      })
                  })
                  .collect();
  ```

  With:
  ```rust
          "list_sessions" => {
              let sessions = crate::pty::list_sessions_internal();
              let result: Vec<_> = sessions
                  .into_iter()
                  .map(|(id, state, working_dir)| {
                          "id": id,
                          "project_path": working_dir
                      })
                  })
                  .collect();
  ```

- [ ] **Step 5: Verify Rust compiles**

  Run:
  ```bash
  cd src-tauri && cargo check 2>&1 | tail -5
  ```

  Expected: `Finished `dev` profile` (no errors)

- [ ] **Step 6: Commit**

  ```bash
  git add src-tauri/src/pty.rs src-tauri/src/http_server.rs
  git commit -m "feat(backend): add project_path to active sessions API response

  Expose the PTY session working directory in GET /api/sessions and
  the list_sessions WebSocket command. This enables the iOS app to
  reliably map active sessions to projects.

  Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
  ```

---
## Group 1: Xcode Project Setup

### Task 1.1: Create directory structure and Xcode project with xcodegen

**Purpose:** Set up the Xcode project directory structure and generate the `.xcodeproj` file using xcodegen. This provides the foundation for all iOS development.

**Files:**
- Create: `OpenWorkMobile/project.yml`
- Create: `OpenWorkMobile/OpenWorkMobile/` (directory tree)
- Generate: `OpenWorkMobile/OpenWorkMobile.xcodeproj`

- [ ] **Step 1: Install xcodegen if not available**

  ```bash
  which xcodegen || brew install xcodegen
  ```

  Expected: xcodegen path printed, or Homebrew installs it.

- [ ] **Step 2: Create the full directory structure**

  ```bash
  cd /path/to/OpenWork
  mkdir -p OpenWorkMobile/OpenWorkMobile/{App,Models,Networking,ViewModels}
  mkdir -p OpenWorkMobile/OpenWorkMobile/Views/{Connection,Projects,Sessions,History,Settings,Shared}
  mkdir -p OpenWorkMobile/OpenWorkMobile/Utilities
  mkdir -p OpenWorkMobile/OpenWorkMobile/Resources/Assets.xcassets/{AccentColor.colorset,AppIcon.appiconset}
  mkdir -p OpenWorkMobile/OpenWorkMobileTests
  ```

- [ ] **Step 3: Create `project.yml` for xcodegen**

  Create `OpenWorkMobile/project.yml`:

  ```yaml
  name: OpenWorkMobile
  options:
    bundleIdPrefix: com.openwork
    deploymentTarget:
      iOS: "17.0"
    xcodeVersion: "16.0"
  settings:
    base:
      SWIFT_VERSION: "5.9"
  targets:
    OpenWorkMobile:
      type: application
      platform: iOS
      sources:
        - path: OpenWorkMobile
          excludes:
            - "**/.DS_Store"
      settings:
        base:
          PRODUCT_BUNDLE_IDENTIFIER: com.openwork.mobile
          MARKETING_VERSION: "1.0.0"
          CURRENT_PROJECT_VERSION: "1"
          GENERATE_INFOPLIST_FILE: YES
          INFOPLIST_KEY_UIApplicationSceneManifest_Generation: YES
          INFOPLIST_KEY_UIApplicationSupportsIndirectInputEvents: YES
          INFOPLIST_KEY_UILaunchScreen_Generation: YES
          INFOPLIST_KEY_UISupportedInterfaceOrientations_iPhone: "UIInterfaceOrientationPortrait UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight"
          INFOPLIST_KEY_UISupportedInterfaceOrientations_iPad: "UIInterfaceOrientationPortrait UIInterfaceOrientationPortraitUpsideDown UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight"
          INFOPLIST_KEY_NSCameraUsageDescription: "OpenWork needs camera access to scan QR codes for server pairing."
          INFOPLIST_KEY_NSLocalNetworkUsageDescription: "OpenWork connects to your desktop app over your local network."
    OpenWorkMobileTests:
      type: bundle.unit-test
      platform: iOS
      sources:
        - path: OpenWorkMobileTests
      dependencies:
        - target: OpenWorkMobile
      settings:
        base:
          PRODUCT_BUNDLE_IDENTIFIER: com.openwork.mobile.tests
  ```

- [ ] **Step 4: Create asset catalog files**

  Create `OpenWorkMobile/OpenWorkMobile/Resources/Assets.xcassets/Contents.json`:
  ```json
  {
    "info" : {
      "author" : "xcode",
      "version" : 1
    }
  }
  ```

  Create `OpenWorkMobile/OpenWorkMobile/Resources/Assets.xcassets/AccentColor.colorset/Contents.json`:
  ```json
  {
    "colors" : [
      {
        "idiom" : "universal"
      }
    ],
    "info" : {
      "author" : "xcode",
      "version" : 1
    }
  }
  ```

  Create `OpenWorkMobile/OpenWorkMobile/Resources/Assets.xcassets/AppIcon.appiconset/Contents.json`:
  ```json
  {
    "images" : [
      {
        "idiom" : "universal",
        "platform" : "ios",
        "size" : "1024x1024"
      }
    ],
    "info" : {
      "author" : "xcode",
      "version" : 1
    }
  }
  ```

---

### Task 1.2: Create all Swift source files as compilable stubs

**Purpose:** Create every Swift file with minimal valid content so the project compiles with zero errors from the start. Each file will be replaced with full implementation in later tasks.

**Files:**
- Create: All `.swift` files listed below (35 files)

- [ ] **Step 1: Create App entry point stubs**

  Create `OpenWorkMobile/OpenWorkMobile/App/OpenWorkMobileApp.swift`:
  ```swift
  import SwiftUI

  @main
  struct OpenWorkMobileApp: App {
      var body: some Scene {
          WindowGroup {
              ContentView()
          }
      }
  }
  ```

  Create `OpenWorkMobile/OpenWorkMobile/App/ContentView.swift`:
  ```swift
  import SwiftUI

  struct ContentView: View {
      var body: some View {
          Text("OpenWork Mobile")
      }
  }
  ```

- [ ] **Step 2: Create Model stubs**

  Create each file with the following minimal content:

  `OpenWorkMobile/OpenWorkMobile/Models/AnyCodableValue.swift`:
  ```swift
  import Foundation
  enum AnyCodableValue: Codable, Hashable, Sendable {
      case null
  }
  ```

  `OpenWorkMobile/OpenWorkMobile/Models/ServerConnection.swift`:
  ```swift
  import Foundation
  struct ServerConnection: Codable, Identifiable, Hashable {
      let id: UUID
      var host: String
      var port: Int
      var token: String
      var name: String
  }
  ```

  `OpenWorkMobile/OpenWorkMobile/Models/Session.swift`:
  ```swift
  import Foundation
  struct Session: Codable, Identifiable, Hashable {
      let id: String
  }
  ```

  `OpenWorkMobile/OpenWorkMobile/Models/Project.swift`:
  ```swift
  import Foundation
  struct Project: Codable, Identifiable, Hashable {
      let name: String
      let path: String
      var id: String { path }
  }
  ```

  `OpenWorkMobile/OpenWorkMobile/Models/ActiveSessionInfo.swift`:
  ```swift
  import Foundation
  struct ActiveSessionInfo: Codable, Identifiable {
      let id: String
      let state: String
  }
  struct ActiveSessionsResponse: Codable {
      let sessions: [ActiveSessionInfo]
  }
  ```

  `OpenWorkMobile/OpenWorkMobile/Models/SessionSummary.swift`:
  ```swift
  import Foundation
  struct SessionSummary: Codable, Identifiable {
      let sessionId: String
      var id: String { sessionId }
  }
  ```

  `OpenWorkMobile/OpenWorkMobile/Models/SessionMessage.swift`:
  ```swift
  import Foundation
  struct SessionMessage: Codable, Identifiable {
      let uuid: String
      var id: String { uuid }
  }
  ```

  `OpenWorkMobile/OpenWorkMobile/Models/PTYMessage.swift`:
  ```swift
  import Foundation
  enum PTYMessageFromServer {
      case output(id: String, data: String)
  }
  struct PTYInputMessage: Encodable {
      let type = "pty-input"
      let data: String
  }
  ```

  `OpenWorkMobile/OpenWorkMobile/Models/CommandDiscovery.swift`:
  ```swift
  import Foundation
  struct CommandDiscoveryResponse: Codable {
      let ok: Bool
  }
  struct CommandDiscoveryResult: Codable {
      let commands: [DiscoveredCommand]
      let skills: [DiscoveredSkill]
  }
  struct DiscoveredCommand: Codable, Identifiable {
      let name: String
      var id: String { name }
  }
  struct DiscoveredSkill: Codable, Identifiable {
      let name: String
      var id: String { name }
  }
  ```

  `OpenWorkMobile/OpenWorkMobile/Models/HealthModels.swift`:
  ```swift
  import Foundation
  struct HealthResponse: Codable {
      let status: String
  }
  struct LocalIPResponse: Codable {
      let ip: String
  }
  struct TokenInfoResponse: Codable {
      let hint: String
  }
  ```

- [ ] **Step 3: Create Networking stubs**

  `OpenWorkMobile/OpenWorkMobile/Networking/OpenWorkAPIClient.swift`:
  ```swift
  import Foundation

  @Observable
  final class OpenWorkAPIClient {
      var connection: ServerConnection?
  }

  enum APIError: LocalizedError {
      case notConnected
      case unauthorized
      case serverError(String)
      var errorDescription: String? { "Error" }
  }
  ```

  `OpenWorkMobile/OpenWorkMobile/Networking/OpenWorkPTYSession.swift`:
  ```swift
  import Foundation

  @Observable
  final class OpenWorkPTYSession {
      let ptyId: String
      init(ptyId: String, connection: ServerConnection) {
          self.ptyId = ptyId
      }
  }
  ```

  `OpenWorkMobile/OpenWorkMobile/Networking/TokenStorage.swift`:
  ```swift
  import Foundation
  import Security

  final class TokenStorage {
      static func saveConnections(_ connections: [ServerConnection]) {}
      static func loadConnections() -> [ServerConnection] { [] }
      static func deleteAll() {}
  }
  ```

- [ ] **Step 4: Create ViewModel stubs**

  `OpenWorkMobile/OpenWorkMobile/ViewModels/ConnectionViewModel.swift`:
  ```swift
  import Foundation

  @Observable
  final class ConnectionViewModel {
      var isConnected = false
  }
  ```

  `OpenWorkMobile/OpenWorkMobile/ViewModels/ProjectsViewModel.swift`:
  ```swift
  import Foundation

  @Observable @MainActor
  final class ProjectsViewModel {
      var projects: [Project] = []
  }
  ```

  `OpenWorkMobile/OpenWorkMobile/ViewModels/SessionsViewModel.swift`:
  ```swift
  import Foundation

  @Observable @MainActor
  final class SessionsViewModel {
      var activeSessions: [ActiveSessionInfo] = []
  }
  ```

  `OpenWorkMobile/OpenWorkMobile/ViewModels/SessionViewModel.swift`:
  ```swift
  import Foundation

  @Observable @MainActor
  final class SessionViewModel {
      var inputText = ""
  }
  ```

  `OpenWorkMobile/OpenWorkMobile/ViewModels/HistoryViewModel.swift`:
  ```swift
  import Foundation

  @Observable @MainActor
  final class HistoryViewModel {
      var messages: [SessionMessage] = []
  }
  ```

- [ ] **Step 5: Create View stubs**

  Create each of these files with the following pattern `struct ViewName: View { var body: some View { Text("ViewName") } }`:

  `OpenWorkMobile/OpenWorkMobile/Views/Connection/ConnectionSetupView.swift`:
  ```swift
  import SwiftUI
  struct ConnectionSetupView: View {
      var body: some View { Text("ConnectionSetupView") }
  }
  ```

  `OpenWorkMobile/OpenWorkMobile/Views/Projects/ProjectsListView.swift`:
  ```swift
  import SwiftUI
  struct ProjectsListView: View {
      var body: some View { Text("ProjectsListView") }
  }
  ```

  `OpenWorkMobile/OpenWorkMobile/Views/Projects/ProjectRow.swift`:
  ```swift
  import SwiftUI
  struct ProjectRow: View {
      var body: some View { Text("ProjectRow") }
  }
  ```

  `OpenWorkMobile/OpenWorkMobile/Views/Sessions/SessionsListView.swift`:
  ```swift
  import SwiftUI
  struct SessionsListView: View {
      var body: some View { Text("SessionsListView") }
  }
  ```

  `OpenWorkMobile/OpenWorkMobile/Views/Sessions/SessionView.swift`:
  ```swift
  import SwiftUI
  struct SessionView: View {
      var body: some View { Text("SessionView") }
  }
  ```

  `OpenWorkMobile/OpenWorkMobile/Views/Sessions/PTYOutputView.swift`:
  ```swift
  import SwiftUI
  struct PTYOutputView: View {
      var body: some View { Text("PTYOutputView") }
  }
  ```

  `OpenWorkMobile/OpenWorkMobile/Views/Sessions/NewSessionSheet.swift`:
  ```swift
  import SwiftUI
  struct NewSessionSheet: View {
      var body: some View { Text("NewSessionSheet") }
  }
  ```

  `OpenWorkMobile/OpenWorkMobile/Views/Sessions/SessionStateBadge.swift`:
  ```swift
  import SwiftUI
  struct SessionStateBadge: View {
      let state: String
      var body: some View { Text(state) }
  }
  ```

  `OpenWorkMobile/OpenWorkMobile/Views/History/HistoryView.swift`:
  ```swift
  import SwiftUI
  struct HistoryView: View {
      var body: some View { Text("HistoryView") }
  }
  ```

  `OpenWorkMobile/OpenWorkMobile/Views/History/HistoryMessageBubble.swift`:
  ```swift
  import SwiftUI
  struct HistoryMessageBubble: View {
      var body: some View { Text("HistoryMessageBubble") }
  }
  ```

  `OpenWorkMobile/OpenWorkMobile/Views/Settings/SettingsView.swift`:
  ```swift
  import SwiftUI
  struct SettingsView: View {
      var body: some View { Text("SettingsView") }
  }
  ```

  `OpenWorkMobile/OpenWorkMobile/Views/Shared/LoadingView.swift`:
  ```swift
  import SwiftUI
  struct LoadingView: View {
      var message: String = "Loading..."
      var body: some View {
          ProgressView(message)
      }
  }
  ```

  `OpenWorkMobile/OpenWorkMobile/Views/Shared/ErrorView.swift`:
  ```swift
  import SwiftUI
  struct ErrorView: View {
      let message: String
      var body: some View {
          ContentUnavailableView {
              Label("Error", systemImage: "exclamationmark.triangle")
          } description: {
              Text(message)
          }
      }
  }
  ```

- [ ] **Step 6: Create Utility stubs**

  `OpenWorkMobile/OpenWorkMobile/Utilities/ANSIParser.swift`:
  ```swift
  import UIKit
  enum ANSIParser {
      static func parse(_ input: String) -> NSAttributedString {
          NSAttributedString(string: input)
      }
  }
  ```

  `OpenWorkMobile/OpenWorkMobile/Utilities/HapticManager.swift`:
  ```swift
  import UIKit
  enum HapticManager {
      static func impact(_ style: UIImpactFeedbackGenerator.FeedbackStyle) {}
      static func notification(_ type: UINotificationFeedbackGenerator.FeedbackType) {}
      static func selection() {}
  }
  ```

- [ ] **Step 7: Create test stub**

  `OpenWorkMobile/OpenWorkMobileTests/TokenStorageTests.swift`:
  ```swift
  import XCTest
  @testable import OpenWorkMobile

  final class TokenStorageTests: XCTestCase {
      func testPlaceholder() {
          XCTAssertTrue(true)
      }
  }
  ```

---

### Task 1.3: Generate Xcode project and verify build

**Purpose:** Run xcodegen to generate the .xcodeproj and verify the empty project compiles successfully.

**Files:**
- Generate: `OpenWorkMobile/OpenWorkMobile.xcodeproj`

- [ ] **Step 1: Generate the Xcode project**

  ```bash
  cd OpenWorkMobile && xcodegen generate
  ```

  Expected: `Generated OpenWorkMobile project` (or similar success message)

- [ ] **Step 2: Verify the project builds for iOS Simulator**

  ```bash
  cd OpenWorkMobile && xcodebuild -project OpenWorkMobile.xcodeproj -scheme OpenWorkMobile -destination 'generic/platform=iOS Simulator' build 2>&1 | tail -3
  ```

  Expected: `BUILD SUCCEEDED`

- [ ] **Step 3: Commit the Xcode project setup**

  ```bash
  git add OpenWorkMobile/
  git commit -m "feat(ios): scaffold Xcode project with compilable stubs

  Create OpenWorkMobile/ directory with xcodegen project.yml, all
  Swift source file stubs (models, views, networking, utilities),
  and asset catalogs. Project builds with zero errors.

  Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
  ```

---
## Group 2: Data Models

### Task 2.1: AnyCodableValue — JSON type-erasing wrapper

**Purpose:** `SessionMessage.content` is a raw JSON value that can be a string, array, or object. We need a `Codable` wrapper that handles all cases. This is used by `Project.config` and `SessionMessage.content`.

**Files:**
- Modify: `OpenWorkMobile/OpenWorkMobile/Models/AnyCodableValue.swift`

- [ ] **Step 1: Replace the stub with the full implementation**

  Replace the entire contents of `OpenWorkMobile/OpenWorkMobile/Models/AnyCodableValue.swift` with:

  ```swift
  import Foundation

  /// Type-erasing Codable wrapper for arbitrary JSON values.
  /// Used for SessionMessage.content and Project.config which are serde_json::Value in Rust.
  enum AnyCodableValue: Codable, Hashable, Sendable {
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
                  DecodingError.Context(
                      codingPath: decoder.codingPath,
                      debugDescription: "Unsupported JSON value"
                  )
              )
          }
      }

      func encode(to encoder: Encoder) throws {
          var container = encoder.singleValueContainer()
          switch self {
          case .null:         try container.encodeNil()
          case .bool(let b):  try container.encode(b)
          case .int(let i):   try container.encode(i)
          case .double(let d): try container.encode(d)
          case .string(let s): try container.encode(s)
          case .array(let a):  try container.encode(a)
          case .object(let o): try container.encode(o)
          }
      }

      /// Extract the first human-readable text from a JSON content value.
      /// Handles Claude content blocks `[{"type":"text","text":"..."}]` and plain strings.
      var textContent: String? {
          switch self {
          case .string(let s):
              return s.isEmpty ? nil : s
          case .array(let arr):
              for item in arr {
                  if case .object(let d) = item,
                     case .string(let text) = d["text"] {
                      return text
                  }
              }
              return arr.compactMap(\.textContent).first
          case .object(let d):
              if case .string(let text) = d["text"] { return text }
              if case .string(let msg) = d["message"] { return msg }
              return nil
          default:
              return nil
          }
      }

      var description: String {
          switch self {
          case .null:         return ""
          case .bool(let b):  return String(b)
          case .int(let i):   return String(i)
          case .double(let d): return String(d)
          case .string(let s): return s
          case .array(let a):  return a.map(\.description).joined(separator: " ")
          case .object(let o): return o.values.map(\.description).joined(separator: " ")
          }
      }
  }
  ```

- [ ] **Step 2: Verify the file compiles**

  ```bash
  cd OpenWorkMobile && xcodebuild -project OpenWorkMobile.xcodeproj -scheme OpenWorkMobile -destination 'generic/platform=iOS Simulator' build 2>&1 | tail -3
  ```

  Expected: `BUILD SUCCEEDED`

---

### Task 2.2: ServerConnection, Session, ActiveSessionInfo, and Project models

**Purpose:** Core data models matching the Rust backend JSON responses. `Session` is embedded inside `Project`. `ActiveSessionInfo` represents live PTY sessions from `GET /api/sessions`.

**Files:**
- Modify: `OpenWorkMobile/OpenWorkMobile/Models/ServerConnection.swift`
- Modify: `OpenWorkMobile/OpenWorkMobile/Models/Session.swift`
- Modify: `OpenWorkMobile/OpenWorkMobile/Models/ActiveSessionInfo.swift`
- Modify: `OpenWorkMobile/OpenWorkMobile/Models/Project.swift`

- [ ] **Step 1: Replace `ServerConnection.swift`**

  ```swift
  import Foundation

  /// Client-side model for a saved server connection.
  /// Stored in Keychain. Not sent to/from the backend.
  struct ServerConnection: Codable, Identifiable, Hashable, Sendable {
      let id: UUID
      var name: String
      var host: String
      var port: Int
      var token: String

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

- [ ] **Step 2: Replace `Session.swift`**

  ```swift
  import Foundation

  /// A session record from the project's disk storage.
  /// Embedded in `Project.sessions` from `GET /api/projects`.
  struct Session: Codable, Identifiable, Hashable, Sendable {
      let id: String
      let projectPath: String
      let provider: String
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

- [ ] **Step 3: Replace `ActiveSessionInfo.swift`**

  ```swift
  import Foundation

  /// A live PTY session from `GET /api/sessions`.
  /// Wrapped in `{"sessions": [ActiveSessionInfo]}`.
  struct ActiveSessionInfo: Codable, Identifiable, Sendable {
      let id: String
      let state: String
      let provider: String?
      let projectPath: String?

      /// Provider defaults to "claude" when backend returns nil.
      var effectiveProvider: String { provider ?? "claude" }

      enum CodingKeys: String, CodingKey {
          case id, state, provider
          case projectPath = "project_path"
      }
  }

  struct ActiveSessionsResponse: Codable, Sendable {
      let sessions: [ActiveSessionInfo]
  }
  ```

- [ ] **Step 4: Replace `Project.swift`**

  ```swift
  import Foundation

  /// A registered project from `GET /api/projects`.
  /// Response is a bare JSON array `[Project]`, NOT wrapped.
  struct Project: Codable, Identifiable, Hashable, Sendable {
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

- [ ] **Step 5: Verify build**

  ```bash
  cd OpenWorkMobile && xcodebuild -project OpenWorkMobile.xcodeproj -scheme OpenWorkMobile -destination 'generic/platform=iOS Simulator' build 2>&1 | tail -3
  ```

  Expected: `BUILD SUCCEEDED`

---

### Task 2.3: SessionMessage and SessionSummary models

**Purpose:** History-related models. `SessionSummary` is returned by `GET /api/session-history`. `SessionMessage` is returned by `GET /api/session-history/{id}/messages` and its `content` field uses `AnyCodableValue`.

**Files:**
- Modify: `OpenWorkMobile/OpenWorkMobile/Models/SessionSummary.swift`
- Modify: `OpenWorkMobile/OpenWorkMobile/Models/SessionMessage.swift`

- [ ] **Step 1: Replace `SessionSummary.swift`**

  ```swift
  import Foundation

  /// A session summary from `GET /api/session-history`.
  /// Response is a bare JSON array `[SessionSummary]`.
  struct SessionSummary: Codable, Identifiable, Hashable, Sendable {
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

- [ ] **Step 2: Replace `SessionMessage.swift`**

  ```swift
  import Foundation

  /// A message from `GET /api/session-history/{id}/messages`.
  /// The `content` field is a raw JSON value (varies by provider).
  struct SessionMessage: Codable, Identifiable, Sendable {
      let uuid: String
      let role: String
      let content: AnyCodableValue
      let timestamp: String?
      let isSidechain: Bool?

      var id: String { uuid }

      enum CodingKeys: String, CodingKey {
          case uuid, role, content, timestamp
          case isSidechain = "is_sidechain"
      }

      /// Extract human-readable text from the JSON content.
      /// Handles multiple provider formats: plain string, Claude content blocks, Codex messages.
      var textContent: String {
          switch content {
          case .string(let s):
              return s
          case .object(let dict):
              if case .string(let text) = dict["text"] {
                  return text
              }
              if case .string(let msg) = dict["message"] {
                  return msg
              }
              return String(describing: dict)
          case .array(let blocks):
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

- [ ] **Step 3: Verify build**

  ```bash
  cd OpenWorkMobile && xcodebuild -project OpenWorkMobile.xcodeproj -scheme OpenWorkMobile -destination 'generic/platform=iOS Simulator' build 2>&1 | tail -3
  ```

  Expected: `BUILD SUCCEEDED`

---

### Task 2.4: PTYMessage, CommandDiscovery, and HealthModels

**Purpose:** WebSocket message types for PTY communication, command/skill discovery response types, and health check response models.

**Files:**
- Modify: `OpenWorkMobile/OpenWorkMobile/Models/PTYMessage.swift`
- Modify: `OpenWorkMobile/OpenWorkMobile/Models/CommandDiscovery.swift`
- Modify: `OpenWorkMobile/OpenWorkMobile/Models/HealthModels.swift`

- [ ] **Step 1: Replace `PTYMessage.swift`**

  ```swift
  import Foundation

  /// Messages received from the PTY WebSocket server.
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

  /// Message sent from the iOS app to the PTY WebSocket.
  struct PTYInputMessage: Encodable {
      let type = "pty-input"
      let data: String
  }
  ```

- [ ] **Step 2: Replace `CommandDiscovery.swift`**

  ```swift
  import Foundation

  /// Wrapper for `GET /api/commands/discover` response.
  struct CommandDiscoveryResponse: Codable, Sendable {
      let ok: Bool
      let data: CommandDiscoveryResult?
      let error: String?
  }

  struct CommandDiscoveryResult: Codable, Sendable {
      let commands: [DiscoveredCommand]
      let skills: [DiscoveredSkill]
  }

  /// A slash command. Uses camelCase JSON keys (Rust `rename_all = "camelCase"`).
  struct DiscoveredCommand: Codable, Identifiable, Sendable {
      let name: String
      let description: String
      let provider: String
      let scope: String
      let filePath: String

      var id: String { "\(provider)-\(scope)-\(name)" }
  }

  /// A skill. Uses camelCase JSON keys.
  struct DiscoveredSkill: Codable, Identifiable, Sendable {
      let name: String
      let displayName: String
      let description: String
      let provider: String
      let scope: String

      var id: String { "\(provider)-\(scope)-\(name)" }
  }
  ```

- [ ] **Step 3: Replace `HealthModels.swift`**

  ```swift
  import Foundation

  struct HealthResponse: Codable, Sendable {
      let status: String
      let app: String
      let lanUrl: String
  }

  struct LocalIPResponse: Codable, Sendable {
      let ip: String
      let url: String
  }

  struct TokenInfoResponse: Codable, Sendable {
      let hint: String
  }
  ```

- [ ] **Step 4: Verify build**

  ```bash
  cd OpenWorkMobile && xcodebuild -project OpenWorkMobile.xcodeproj -scheme OpenWorkMobile -destination 'generic/platform=iOS Simulator' build 2>&1 | tail -3
  ```

  Expected: `BUILD SUCCEEDED`

- [ ] **Step 5: Commit all models**

  ```bash
  git add OpenWorkMobile/OpenWorkMobile/Models/
  git commit -m "feat(ios): implement all data models

  AnyCodableValue (JSON type-erasing), ServerConnection, Project,
  Session, ActiveSessionInfo, SessionSummary, SessionMessage,
  PTYMessage, CommandDiscovery, and HealthModels. All models are
  Codable+Sendable with CodingKeys matching Rust serde output.

  Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
  ```

---
## Group 3: Token Storage

### Task 3.1: TokenStorage — Keychain save/load/delete

**Purpose:** Persist server connections securely in the iOS Keychain using the Security framework. Supports multiple server connections.

**Files:**
- Modify: `OpenWorkMobile/OpenWorkMobile/Networking/TokenStorage.swift`

- [ ] **Step 1: Replace the stub with the full implementation**

  ```swift
  import Foundation
  import Security

  /// Keychain-based storage for server connections.
  /// Supports saving, loading, and deleting multiple ServerConnection entries.
  final class TokenStorage: Sendable {

      private static let service = "com.openwork.mobile"
      private static let connectionsKey = "server-connections"

      // MARK: - Save

      static func saveConnections(_ connections: [ServerConnection]) {
          guard let data = try? JSONEncoder().encode(connections) else { return }

          let query: [String: Any] = [
              kSecClass as String: kSecClassGenericPassword,
              kSecAttrService as String: service,
              kSecAttrAccount as String: connectionsKey,
          ]
          // Delete existing entry first
          SecItemDelete(query as CFDictionary)

          var add = query
          add[kSecValueData as String] = data
          add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
          SecItemAdd(add as CFDictionary, nil)
      }

      // MARK: - Load

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
          guard status == errSecSuccess,
                let data = result as? Data,
                let connections = try? JSONDecoder().decode([ServerConnection].self, from: data) else {
              return []
          }
          return connections
      }

      // MARK: - Delete

      static func deleteAll() {
          let query: [String: Any] = [
              kSecClass as String: kSecClassGenericPassword,
              kSecAttrService as String: service,
          ]
          SecItemDelete(query as CFDictionary)
      }

      /// Remove a specific connection by ID and save the remainder.
      static func removeConnection(id: UUID) {
          var connections = loadConnections()
          connections.removeAll { $0.id == id }
          saveConnections(connections)
      }
  }
  ```

- [ ] **Step 2: Verify build**

  ```bash
  cd OpenWorkMobile && xcodebuild -project OpenWorkMobile.xcodeproj -scheme OpenWorkMobile -destination 'generic/platform=iOS Simulator' build 2>&1 | tail -3
  ```

  Expected: `BUILD SUCCEEDED`

---

### Task 3.2: Unit test for TokenStorage

**Purpose:** Verify Keychain save/load/delete cycle works correctly. Uses XCTest.

**Files:**
- Modify: `OpenWorkMobile/OpenWorkMobileTests/TokenStorageTests.swift`

- [ ] **Step 1: Replace the test stub with full tests**

  ```swift
  import XCTest
  @testable import OpenWorkMobile

  final class TokenStorageTests: XCTestCase {

      override func tearDown() {
          super.tearDown()
          TokenStorage.deleteAll()
      }

      func testSaveAndLoadConnections() {
          let conn = ServerConnection(
              name: "Test Mac",
              host: "192.168.1.42",
              port: 3002,
              token: "test-token-123"
          )
          TokenStorage.saveConnections([conn])

          let loaded = TokenStorage.loadConnections()
          XCTAssertEqual(loaded.count, 1)
          XCTAssertEqual(loaded.first?.host, "192.168.1.42")
          XCTAssertEqual(loaded.first?.port, 3002)
          XCTAssertEqual(loaded.first?.token, "test-token-123")
          XCTAssertEqual(loaded.first?.name, "Test Mac")
      }

      func testLoadReturnsEmptyWhenNothingSaved() {
          TokenStorage.deleteAll()
          let loaded = TokenStorage.loadConnections()
          XCTAssertTrue(loaded.isEmpty)
      }

      func testDeleteAllClearsStorage() {
          let conn = ServerConnection(name: "X", host: "10.0.0.1", token: "tok")
          TokenStorage.saveConnections([conn])
          TokenStorage.deleteAll()
          let loaded = TokenStorage.loadConnections()
          XCTAssertTrue(loaded.isEmpty)
      }

      func testMultipleConnections() {
          let conns = [
              ServerConnection(name: "Mac 1", host: "192.168.1.10", token: "tok1"),
              ServerConnection(name: "Mac 2", host: "192.168.1.20", token: "tok2"),
          ]
          TokenStorage.saveConnections(conns)
          let loaded = TokenStorage.loadConnections()
          XCTAssertEqual(loaded.count, 2)
          XCTAssertEqual(loaded[0].host, "192.168.1.10")
          XCTAssertEqual(loaded[1].host, "192.168.1.20")
      }

      func testRemoveConnectionById() {
          let conn1 = ServerConnection(name: "Mac 1", host: "10.0.0.1", token: "t1")
          let conn2 = ServerConnection(name: "Mac 2", host: "10.0.0.2", token: "t2")
          TokenStorage.saveConnections([conn1, conn2])

          TokenStorage.removeConnection(id: conn1.id)
          let loaded = TokenStorage.loadConnections()
          XCTAssertEqual(loaded.count, 1)
          XCTAssertEqual(loaded.first?.host, "10.0.0.2")
      }
  }
  ```

- [ ] **Step 2: Run the tests**

  ```bash
  cd OpenWorkMobile && xcodebuild test -project OpenWorkMobile.xcodeproj -scheme OpenWorkMobileTests -destination 'platform=iOS Simulator,name=iPhone 16' -quiet 2>&1 | tail -5
  ```

  Expected: `Test Suite 'All tests' passed` or `** TEST SUCCEEDED **`

- [ ] **Step 3: Commit TokenStorage + tests**

  ```bash
  git add OpenWorkMobile/OpenWorkMobile/Networking/TokenStorage.swift OpenWorkMobile/OpenWorkMobileTests/
  git commit -m "feat(ios): implement TokenStorage with Keychain persistence

  Keychain-based save/load/delete for ServerConnection entries.
  Includes XCTest unit tests for CRUD operations.

  Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
  ```

---
## Group 4: API Client

### Task 4.1: OpenWorkAPIClient — core structure, auth helpers, error handling

**Purpose:** The central networking class that holds the current `ServerConnection` and provides typed async methods for every REST endpoint. This task implements the foundation: init, URL builder, auth header, error types.

**Files:**
- Modify: `OpenWorkMobile/OpenWorkMobile/Networking/OpenWorkAPIClient.swift`

- [ ] **Step 1: Replace the stub with the full API client (Part 1: core + health + projects)**

  This is a large file. We implement it in one go since all methods are tightly coupled.

  Replace the entire contents of `OpenWorkMobile/OpenWorkMobile/Networking/OpenWorkAPIClient.swift` with:

  ```swift
  import Foundation

  @Observable
  final class OpenWorkAPIClient: @unchecked Sendable {

      var connection: ServerConnection?

      // MARK: - URL helpers

      private func url(_ path: String, queryItems: [URLQueryItem] = []) -> URL? {
          guard let base = connection?.baseURL else { return nil }
          var components = URLComponents(
              url: base.appendingPathComponent(path),
              resolvingAgainstBaseURL: false
          )
          if !queryItems.isEmpty {
              components?.queryItems = queryItems
          }
          return components?.url
      }

      private func authorizedRequest(_ url: URL, method: String = "GET") -> URLRequest {
          var request = URLRequest(url: url)
          request.httpMethod = method
          request.timeoutInterval = 15
          if let token = connection?.token {
              request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
          }
          request.setValue("application/json", forHTTPHeaderField: "Content-Type")
          return request
      }

      private func checkAuth(_ response: URLResponse) throws {
          if let http = response as? HTTPURLResponse, http.statusCode == 401 {
              throw APIError.unauthorized
          }
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

      /// Returns bare array `[Project]` — NOT wrapped in {"projects":[]}.
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

      private struct CreateSessionRequest: Encodable {
          let project_path: String
          let provider: String
          let resume_session_id: String?
      }

      private struct CreateSessionResponse: Decodable {
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

      /// Returns bare array `[SessionSummary]`.
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

      /// Returns bare array `[SessionMessage]`.
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

      // MARK: - Shared response types

      private struct OkResponse: Decodable {
          let ok: Bool
          let error: String?
      }
  }

  // MARK: - Error type

  enum APIError: LocalizedError {
      case notConnected
      case unauthorized
      case serverError(String)

      var errorDescription: String? {
          switch self {
          case .notConnected:
              return "Not connected to server"
          case .unauthorized:
              return "Token invalid or expired — re-pair required"
          case .serverError(let msg):
              return msg
          }
      }
  }
  ```

- [ ] **Step 2: Verify build**

  ```bash
  cd OpenWorkMobile && xcodebuild -project OpenWorkMobile.xcodeproj -scheme OpenWorkMobile -destination 'generic/platform=iOS Simulator' build 2>&1 | tail -3
  ```

  Expected: `BUILD SUCCEEDED`

> **Note:** Tasks 4.2, 4.3, 4.4 from the original outline are consolidated into Task 4.1 because the API client is one file with tightly coupled methods. Splitting it would create non-compilable intermediate states.

- [ ] **Step 3: Commit API client**

  ```bash
  git add OpenWorkMobile/OpenWorkMobile/Networking/OpenWorkAPIClient.swift
  git commit -m "feat(ios): implement OpenWorkAPIClient with all REST endpoints

  Full async/await API client covering health, projects, sessions,
  session history, and command discovery. Uses URLSession with
  Bearer token auth. All response types match Rust serde output.

  Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
  ```

---
## Group 5: PTY WebSocket

### Task 5.1: OpenWorkPTYSession — WebSocket setup and connect

**Purpose:** Per-session WebSocket manager connecting to `/api/pty/{ptyId}/ws`. Receives terminal output and sends input. One instance per active PTY session.

**Files:**
- Modify: `OpenWorkMobile/OpenWorkMobile/Networking/OpenWorkPTYSession.swift`

- [ ] **Step 1: Replace the stub with the full implementation**

  ```swift
  import Foundation

  /// Per-session PTY WebSocket manager.
  /// Connects to `/api/pty/{ptyId}/ws`, receives terminal output, and sends input.
  @Observable
  final class OpenWorkPTYSession: @unchecked Sendable {

      let ptyId: String
      private let connection: ServerConnection
      private var webSocket: URLSessionWebSocketTask?
      private var isListening = false

      enum ConnectionState: Equatable {
          case disconnected
          case connecting
          case connected
          case failed(String)

          static func == (lhs: ConnectionState, rhs: ConnectionState) -> Bool {
              switch (lhs, rhs) {
              case (.disconnected, .disconnected),
                   (.connecting, .connecting),
                   (.connected, .connected):
                  return true
              case (.failed(let a), .failed(let b)):
                  return a == b
              default:
                  return false
              }
          }
      }

      private(set) var outputLines: [String] = []
      private(set) var connectionState: ConnectionState = .disconnected
      private(set) var exitCode: UInt32?
      private(set) var hasExited = false

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

      /// Reconnect after returning from background.
      func reconnect() {
          guard !hasExited else { return }
          disconnect()
          outputLines.removeAll()
          connect()
      }
  }
  ```

- [ ] **Step 2: Verify build**

  ```bash
  cd OpenWorkMobile && xcodebuild -project OpenWorkMobile.xcodeproj -scheme OpenWorkMobile -destination 'generic/platform=iOS Simulator' build 2>&1 | tail -3
  ```

  Expected: `BUILD SUCCEEDED`

> **Note:** Tasks 5.2 and 5.3 from the original outline are consolidated into Task 5.1 because `OpenWorkPTYSession` is one cohesive file. The listen loop, send method, disconnect, and reconnect are all tightly coupled.

- [ ] **Step 3: Commit PTY session**

  ```bash
  git add OpenWorkMobile/OpenWorkMobile/Networking/OpenWorkPTYSession.swift
  git commit -m "feat(ios): implement OpenWorkPTYSession WebSocket client

  Per-session WebSocket connecting to /api/pty/{id}/ws with token auth.
  Handles pty-history, pty-output, pty-exit messages. Supports connect,
  disconnect, send input, reconnect. 5000-line sliding buffer.

  Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
  ```

---
## Group 6: Connection ViewModel + View

### Task 6.1: ConnectionViewModel — server validation, persistence, lifecycle

**Purpose:** The central ViewModel that owns the `OpenWorkAPIClient` instance. Manages connection state, validates tokens, persists connections to Keychain, and handles app lifecycle (foreground/background).

**Files:**
- Modify: `OpenWorkMobile/OpenWorkMobile/ViewModels/ConnectionViewModel.swift`

- [ ] **Step 1: Replace the stub with the full implementation**

  ```swift
  import Foundation

  /// Owns the OpenWorkAPIClient. Injected into the SwiftUI environment.
  /// All child views access the API client via `connectionVM.currentAPIClient`.
  @Observable
  final class ConnectionViewModel {
      var connections: [ServerConnection] = []
      var activeConnection: ServerConnection?
      var isConnected = false
      var connectionError: String?

      private let apiClient = OpenWorkAPIClient()

      init() {
          connections = TokenStorage.loadConnections()
          if let first = connections.first {
              activateConnection(first)
          }
      }

      /// Validate a connection by calling health (no auth) then sessions (with auth).
      /// On success, save to Keychain and activate.
      func validateAndSave(_ connection: ServerConnection) async throws {
          connectionError = nil
          apiClient.connection = connection
          _ = try await apiClient.health()
          _ = try await apiClient.listActiveSessions()

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
          connectionError = nil
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

      /// Called when app returns to foreground. Re-validates the connection.
      func reconnectIfNeeded() {
          guard let conn = activeConnection else { return }
          Task {
              do {
                  apiClient.connection = conn
                  _ = try await apiClient.health()
                  await MainActor.run { self.isConnected = true }
              } catch {
                  await MainActor.run {
                      self.isConnected = false
                      self.connectionError = error.localizedDescription
                  }
              }
          }
      }

      /// Called when app goes to background. Individual PTY sessions handle their own WS disconnect.
      func disconnectSessions() {
          // PTY session disconnect is handled by SessionViewModel
      }

      /// The single API client instance. All views access it through this property.
      var currentAPIClient: OpenWorkAPIClient { apiClient }
  }
  ```

- [ ] **Step 2: Verify build**

  ```bash
  cd OpenWorkMobile && xcodebuild -project OpenWorkMobile.xcodeproj -scheme OpenWorkMobile -destination 'generic/platform=iOS Simulator' build 2>&1 | tail -3
  ```

  Expected: `BUILD SUCCEEDED`

---

### Task 6.2: ConnectionSetupView — server pairing form

**Purpose:** The first screen users see when not connected. Provides manual IP/port/token entry with validation and a "Connect" button.

**Files:**
- Modify: `OpenWorkMobile/OpenWorkMobile/Views/Connection/ConnectionSetupView.swift`

- [ ] **Step 1: Replace the stub with the full implementation**

  ```swift
  import SwiftUI

  struct ConnectionSetupView: View {
      @Environment(ConnectionViewModel.self) private var viewModel
      @State private var host = ""
      @State private var port = "3002"
      @State private var token = ""
      @State private var serverName = ""
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
  }
  ```

- [ ] **Step 2: Verify build**

  ```bash
  cd OpenWorkMobile && xcodebuild -project OpenWorkMobile.xcodeproj -scheme OpenWorkMobile -destination 'generic/platform=iOS Simulator' build 2>&1 | tail -3
  ```

  Expected: `BUILD SUCCEEDED`

---

### Task 6.3: ContentView and App entry point — root navigation

**Purpose:** Wire up the root navigation: show `ConnectionSetupView` when not connected, `ProjectsListView` when connected. Handle app lifecycle (foreground/background).

**Files:**
- Modify: `OpenWorkMobile/OpenWorkMobile/App/ContentView.swift`
- Modify: `OpenWorkMobile/OpenWorkMobile/App/OpenWorkMobileApp.swift`

- [ ] **Step 1: Replace `ContentView.swift`**

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

- [ ] **Step 2: Replace `OpenWorkMobileApp.swift`**

  ```swift
  import SwiftUI

  @main
  struct OpenWorkMobileApp: App {
      @State private var connectionVM = ConnectionViewModel()

      var body: some Scene {
          WindowGroup {
              ContentView()
                  .environment(connectionVM)
          }
      }
  }
  ```

- [ ] **Step 3: Verify build**

  ```bash
  cd OpenWorkMobile && xcodebuild -project OpenWorkMobile.xcodeproj -scheme OpenWorkMobile -destination 'generic/platform=iOS Simulator' build 2>&1 | tail -3
  ```

  Expected: `BUILD SUCCEEDED`

- [ ] **Step 4: Commit connection flow**

  ```bash
  git add OpenWorkMobile/OpenWorkMobile/ViewModels/ConnectionViewModel.swift \
        OpenWorkMobile/OpenWorkMobile/Views/Connection/ \
        OpenWorkMobile/OpenWorkMobile/App/
  git commit -m "feat(ios): implement connection flow (ViewModel + SetupView + ContentView)

  ConnectionViewModel owns the API client. ConnectionSetupView provides
  manual IP/port/token entry with health+auth validation. ContentView
  shows setup when disconnected, ProjectsListView when connected.
  Handles foreground/background lifecycle.

  Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
  ```

---
## Group 7: Projects + Sessions List

### Task 7.1: ProjectsViewModel — fetch and manage projects

**Purpose:** ViewModel for the projects list screen. Fetches projects from the API, supports pull-to-refresh, handles errors.

**Files:**
- Modify: `OpenWorkMobile/OpenWorkMobile/ViewModels/ProjectsViewModel.swift`

- [ ] **Step 1: Replace the stub with the full implementation**

  ```swift
  import Foundation

  @Observable @MainActor
  final class ProjectsViewModel {
      var projects: [Project] = []
      var isLoading = false
      var errorMessage: String?

      private let apiClient: OpenWorkAPIClient

      init(apiClient: OpenWorkAPIClient) {
          self.apiClient = apiClient
      }

      func loadProjects() async {
          isLoading = true
          errorMessage = nil
          do {
              projects = try await apiClient.listProjects()
          } catch APIError.unauthorized {
              errorMessage = "Token invalid — re-pair required"
          } catch {
              errorMessage = error.localizedDescription
          }
          isLoading = false
      }

      func removeProject(_ project: Project) async {
          do {
              try await apiClient.removeProject(path: project.path)
              projects.removeAll { $0.id == project.id }
          } catch {
              errorMessage = error.localizedDescription
          }
      }
  }
  ```

- [ ] **Step 2: Verify build**

  ```bash
  cd OpenWorkMobile && xcodebuild -project OpenWorkMobile.xcodeproj -scheme OpenWorkMobile -destination 'generic/platform=iOS Simulator' build 2>&1 | tail -3
  ```

  Expected: `BUILD SUCCEEDED`

---

### Task 7.2: ProjectsListView and ProjectRow

**Purpose:** Display the list of registered projects with session count badges, pull-to-refresh, and navigation to sessions.

**Files:**
- Modify: `OpenWorkMobile/OpenWorkMobile/Views/Projects/ProjectsListView.swift`
- Modify: `OpenWorkMobile/OpenWorkMobile/Views/Projects/ProjectRow.swift`

- [ ] **Step 1: Replace `ProjectsListView.swift`**

  ```swift
  import SwiftUI

  struct ProjectsListView: View {
      @Environment(ConnectionViewModel.self) private var connectionVM
      @State private var viewModel: ProjectsViewModel?

      var body: some View {
          Group {
              if let vm = viewModel {
                  projectList(vm)
              } else {
                  ProgressView("Loading…")
              }
          }
          .navigationTitle("Projects")
          .onAppear {
              if viewModel == nil {
                  viewModel = ProjectsViewModel(apiClient: connectionVM.currentAPIClient)
              }
          }
          .task {
              await viewModel?.loadProjects()
          }
      }

      @ViewBuilder
      private func projectList(_ vm: ProjectsViewModel) -> some View {
          List {
              ForEach(vm.projects) { project in
                  NavigationLink(value: project) {
                      ProjectRow(project: project)
                  }
              }
          }
          .navigationDestination(for: Project.self) { project in
              SessionsListView(project: project)
          }
          .refreshable {
              await vm.loadProjects()
          }
          .overlay {
              if vm.isLoading && vm.projects.isEmpty {
                  ProgressView("Loading projects…")
              } else if let error = vm.errorMessage, vm.projects.isEmpty {
                  ContentUnavailableView {
                      Label("Error", systemImage: "exclamationmark.triangle")
                  } description: {
                      Text(error)
                  }
              } else if vm.projects.isEmpty && !vm.isLoading {
                  ContentUnavailableView {
                      Label("No Projects", systemImage: "folder")
                  } description: {
                      Text("No projects registered on the server.")
                  }
              }
          }
          .toolbar {
              ToolbarItem(placement: .primaryAction) {
                  NavigationLink {
                      SettingsView()
                  } label: {
                      Image(systemName: "gear")
                  }
              }
          }
      }
  }
  ```

- [ ] **Step 2: Replace `ProjectRow.swift`**

  ```swift
  import SwiftUI

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

- [ ] **Step 3: Verify build**

  ```bash
  cd OpenWorkMobile && xcodebuild -project OpenWorkMobile.xcodeproj -scheme OpenWorkMobile -destination 'generic/platform=iOS Simulator' build 2>&1 | tail -3
  ```

  Expected: `BUILD SUCCEEDED`

---

### Task 7.3: SessionsViewModel — active + history session management

**Purpose:** ViewModel for the sessions list. Fetches active PTY sessions and session history, resolves which active sessions belong to the current project using the three-step strategy from the design doc §6.4.

**Files:**
- Modify: `OpenWorkMobile/OpenWorkMobile/ViewModels/SessionsViewModel.swift`

- [ ] **Step 1: Replace the stub with the full implementation**

  ```swift
  import Foundation

  @Observable @MainActor
  final class SessionsViewModel {
      var activeSessions: [ActiveSessionInfo] = []
      var historySessions: [SessionSummary] = []
      var isLoading = false
      var errorMessage: String?

      private let apiClient: OpenWorkAPIClient
      let project: Project

      init(apiClient: OpenWorkAPIClient, project: Project) {
          self.apiClient = apiClient
          self.project = project
      }

      func loadSessions() async {
          isLoading = true
          errorMessage = nil

          async let activeTask = apiClient.listActiveSessions()
          async let historyTask = apiClient.sessionHistory(
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
                  // Step C: Unattributed — not shown here
                  return false
              }
          } catch APIError.unauthorized {
              errorMessage = "Token invalid — re-pair required"
          } catch {
              errorMessage = error.localizedDescription
          }

          isLoading = false
      }

      func killSession(_ session: ActiveSessionInfo) async {
          do {
              try await apiClient.killSession(ptyId: session.id)
              activeSessions.removeAll { $0.id == session.id }
              HapticManager.notification(.warning)
          } catch {
              errorMessage = error.localizedDescription
          }
      }
  }
  ```

- [ ] **Step 2: Verify build**

  ```bash
  cd OpenWorkMobile && xcodebuild -project OpenWorkMobile.xcodeproj -scheme OpenWorkMobile -destination 'generic/platform=iOS Simulator' build 2>&1 | tail -3
  ```

  Expected: `BUILD SUCCEEDED`

---

### Task 7.4: SessionsListView and supporting row views

**Purpose:** Display active PTY sessions and session history for a project. Active sessions navigate to `SessionView` (live PTY). History sessions navigate to `HistoryView` (read-only).

**Files:**
- Modify: `OpenWorkMobile/OpenWorkMobile/Views/Sessions/SessionsListView.swift`
- Modify: `OpenWorkMobile/OpenWorkMobile/Views/Sessions/SessionStateBadge.swift`

- [ ] **Step 1: Replace `SessionsListView.swift`**

  ```swift
  import SwiftUI

  struct SessionsListView: View {
      let project: Project
      @Environment(ConnectionViewModel.self) private var connectionVM
      @State private var viewModel: SessionsViewModel?
      @State private var showNewSession = false

      var body: some View {
          Group {
              if let vm = viewModel {
                  sessionList(vm)
              } else {
                  ProgressView("Loading…")
              }
          }
          .navigationTitle(project.name)
          .onAppear {
              if viewModel == nil {
                  viewModel = SessionsViewModel(
                      apiClient: connectionVM.currentAPIClient,
                      project: project
                  )
              }
          }
          .task {
              await viewModel?.loadSessions()
          }
      }

      @ViewBuilder
      private func sessionList(_ vm: SessionsViewModel) -> some View {
          List {
              if !vm.activeSessions.isEmpty {
                  Section("Active") {
                      ForEach(vm.activeSessions) { session in
                          NavigationLink(value: session.id) {
                              ActiveSessionRow(session: session)
                          }
                      }
                      .onDelete { indexSet in
                          for index in indexSet {
                              let session = vm.activeSessions[index]
                              Task { await vm.killSession(session) }
                          }
                      }
                  }
              }

              if !project.sessions.isEmpty {
                  Section("Recent Sessions") {
                      ForEach(project.sessions) { session in
                          SessionRow(session: session)
                      }
                  }
              }

              if !vm.historySessions.isEmpty {
                  Section("History") {
                      ForEach(vm.historySessions) { summary in
                          NavigationLink(value: summary) {
                              HistorySessionRow(summary: summary)
                          }
                      }
                  }
              }
          }
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
              NewSessionSheet(project: project) { _ in
                  showNewSession = false
                  Task { await vm.loadSessions() }
              }
          }
          .refreshable {
              await vm.loadSessions()
          }
      }
  }

  // MARK: - Row views

  struct ActiveSessionRow: View {
      let session: ActiveSessionInfo

      var body: some View {
          HStack {
              VStack(alignment: .leading) {
                  Text(session.id.prefix(8) + "…")
                      .font(.headline.monospaced())
                  Text(session.effectiveProvider)
                      .font(.caption)
                      .foregroundStyle(.secondary)
              }
              Spacer()
              SessionStateBadge(state: session.state)
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

- [ ] **Step 2: Replace `SessionStateBadge.swift`**

  ```swift
  import SwiftUI

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
          case "Running":         return .green
          case "WaitingForInput": return .orange
          case "Completed":       return .blue
          case "Failed":          return .red
          case "Idle":            return .gray
          default:                return .gray
          }
      }
  }
  ```

- [ ] **Step 3: Verify build**

  ```bash
  cd OpenWorkMobile && xcodebuild -project OpenWorkMobile.xcodeproj -scheme OpenWorkMobile -destination 'generic/platform=iOS Simulator' build 2>&1 | tail -3
  ```

  Expected: `BUILD SUCCEEDED`

- [ ] **Step 4: Commit projects + sessions list**

  ```bash
  git add OpenWorkMobile/OpenWorkMobile/ViewModels/ProjectsViewModel.swift \
        OpenWorkMobile/OpenWorkMobile/ViewModels/SessionsViewModel.swift \
        OpenWorkMobile/OpenWorkMobile/Views/Projects/ \
        OpenWorkMobile/OpenWorkMobile/Views/Sessions/SessionsListView.swift \
        OpenWorkMobile/OpenWorkMobile/Views/Sessions/SessionStateBadge.swift
  git commit -m "feat(ios): implement projects and sessions list views

  ProjectsListView with pull-to-refresh, ProjectRow with session badges.
  SessionsListView with active/history sections, three-step session
  resolution, swipe-to-kill. SessionStateBadge for state visualization.

  Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
  ```

---
## Group 8: New Session Sheet

### Task 8.1: NewSessionSheet — provider picker and session creation

**Purpose:** A sheet for creating new PTY sessions. Includes provider picker (Claude/Codex/Cursor) with capability-aware UI (disable resume for non-Claude providers), and creates the session via the API.

**Files:**
- Modify: `OpenWorkMobile/OpenWorkMobile/Views/Sessions/NewSessionSheet.swift`

- [ ] **Step 1: Replace the stub with the full implementation**

  ```swift
  import SwiftUI

  struct NewSessionSheet: View {
      let project: Project
      let onCreated: (String) -> Void

      @Environment(ConnectionViewModel.self) private var connectionVM
      @Environment(\.dismiss) private var dismiss
      @State private var provider = "claude"
      @State private var resumeSessionId: String?
      @State private var showResume = false
      @State private var isCreating = false
      @State private var errorMessage: String?

      private let providers = ["claude", "codex", "cursor"]

      /// Providers that support session resume (see design doc §3.11)
      private var supportsResume: Bool {
          provider == "claude"
      }

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
                      .onChange(of: provider) { _, _ in
                          if !supportsResume {
                              resumeSessionId = nil
                              showResume = false
                          }
                      }
                  }

                  if supportsResume && !project.sessions.isEmpty {
                      Section {
                          Toggle("Resume existing session", isOn: $showResume)
                      }

                      if showResume {
                          Section("Select session to resume") {
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
                  }

                  if !supportsResume {
                      Section {
                          Text("\(provider.capitalized) does not support resuming sessions.")
                              .font(.caption)
                              .foregroundStyle(.secondary)
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
                  resumeSessionId: showResume ? resumeSessionId : nil
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

- [ ] **Step 2: Verify build**

  ```bash
  cd OpenWorkMobile && xcodebuild -project OpenWorkMobile.xcodeproj -scheme OpenWorkMobile -destination 'generic/platform=iOS Simulator' build 2>&1 | tail -3
  ```

  Expected: `BUILD SUCCEEDED`

- [ ] **Step 3: Commit**

  ```bash
  git add OpenWorkMobile/OpenWorkMobile/Views/Sessions/NewSessionSheet.swift
  git commit -m "feat(ios): implement NewSessionSheet with provider picker

  Provider-aware session creation (Claude/Codex/Cursor). Resume toggle
  disabled for non-Claude providers per capability matrix. Creates
  session via POST /api/sessions.

  Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
  ```

---
## Group 9: PTY Output View

### Task 9.1: ANSIParser — incremental ANSI SGR parser

**Purpose:** Parse ANSI SGR escape codes (colors, bold, italic, underline) into `NSAttributedString`. Strips cursor movement sequences. Designed for incremental use — call on new chunks and append.

**Files:**
- Modify: `OpenWorkMobile/OpenWorkMobile/Utilities/ANSIParser.swift`

- [ ] **Step 1: Replace the stub with the full implementation**

  ```swift
  import UIKit

  /// Parses ANSI SGR escape codes into NSAttributedString.
  /// Strips all non-SGR sequences (cursor movement, erase, etc.).
  /// Designed for incremental use: parse new chunks and append to existing attributed string.
  enum ANSIParser {

      static func parse(_ input: String) -> NSAttributedString {
          let result = NSMutableAttributedString()
          let defaultAttrs: [NSAttributedString.Key: Any] = [
              .font: UIFont.monospacedSystemFont(ofSize: 13, weight: .regular),
              .foregroundColor: UIColor.white,
          ]

          var currentAttrs = defaultAttrs
          let ansiPattern = /\x1b\[([0-9;]*)([a-zA-Z])/
          var remaining = input

          while let match = remaining.firstMatch(of: ansiPattern) {
              let prefix = remaining[remaining.startIndex..<match.range.lowerBound]
              if !prefix.isEmpty {
                  result.append(NSAttributedString(string: String(prefix), attributes: currentAttrs))
              }

              let params = String(match.1)
              let command = String(match.2)

              if command == "m" {
                  currentAttrs = applySGR(params: params, current: currentAttrs, defaults: defaultAttrs)
              }
              // All other commands (A-Z except m) are silently stripped

              remaining = String(remaining[match.range.upperBound...])
          }

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

          if codes.isEmpty {
              return defaults
          }

          for code in codes {
              switch code {
              case 0:
                  attrs = defaults
              case 1:
                  attrs[.font] = UIFont.monospacedSystemFont(ofSize: 13, weight: .bold)
              case 2:
                  attrs[.foregroundColor] = UIColor.gray
              case 3:
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
              case 39: attrs[.foregroundColor] = UIColor.white
              // Bright foreground colors (90-97)
              case 90: attrs[.foregroundColor] = UIColor.darkGray
              case 91: attrs[.foregroundColor] = UIColor.systemRed
              case 92: attrs[.foregroundColor] = UIColor.systemGreen
              case 93: attrs[.foregroundColor] = UIColor.systemYellow
              case 94: attrs[.foregroundColor] = UIColor.systemBlue
              case 95: attrs[.foregroundColor] = UIColor.systemPurple
              case 96: attrs[.foregroundColor] = UIColor.systemCyan
              case 97: attrs[.foregroundColor] = UIColor.white
              // Background colors (40-47)
              case 40...47:
                  let bgColors: [UIColor] = [
                      .black, .systemRed, .systemGreen, .systemYellow,
                      .systemBlue, .systemPurple, .systemCyan, .white
                  ]
                  attrs[.backgroundColor] = bgColors[code - 40]
              case 49:
                  attrs.removeValue(forKey: .backgroundColor)
              default:
                  break // 256-color and truecolor ignored
              }
          }

          return attrs
      }
  }
  ```

- [ ] **Step 2: Verify build**

  ```bash
  cd OpenWorkMobile && xcodebuild -project OpenWorkMobile.xcodeproj -scheme OpenWorkMobile -destination 'generic/platform=iOS Simulator' build 2>&1 | tail -3
  ```

  Expected: `BUILD SUCCEEDED`

---

### Task 9.2: PTYOutputView — UITextView wrapper with incremental rendering

**Purpose:** A `UIViewRepresentable` wrapping `UITextView` that renders PTY output with ANSI colors. Uses incremental rendering — only new output is parsed and appended, avoiding quadratic re-parse.

**Files:**
- Modify: `OpenWorkMobile/OpenWorkMobile/Views/Sessions/PTYOutputView.swift`

- [ ] **Step 1: Replace the stub with the full implementation**

  ```swift
  import SwiftUI
  import UIKit

  struct PTYOutputView: UIViewRepresentable {
      let lines: [String]
      @Binding var autoScroll: Bool

      func makeUIView(context: Context) -> UITextView {
          let textView = UITextView()
          textView.isEditable = false
          textView.isSelectable = true
          textView.backgroundColor = UIColor(red: 0.12, green: 0.12, blue: 0.14, alpha: 1)
          textView.textContainerInset = UIEdgeInsets(top: 8, left: 8, bottom: 8, right: 8)
          textView.font = UIFont.monospacedSystemFont(ofSize: 13, weight: .regular)
          textView.textColor = .white
          textView.delegate = context.coordinator
          textView.indicatorStyle = .white
          context.coordinator.renderedOutput = NSMutableAttributedString()
          context.coordinator.renderedLineCount = 0
          return textView
      }

      func updateUIView(_ textView: UITextView, context: Context) {
          let coordinator = context.coordinator
          let currentCount = lines.count

          if currentCount < coordinator.renderedLineCount {
              // Buffer was trimmed — re-render from scratch
              let fullText = lines.joined(separator: "\n")
              coordinator.renderedOutput = NSMutableAttributedString(
                  attributedString: ANSIParser.parse(fullText)
              )
              coordinator.renderedLineCount = currentCount
          } else if currentCount > coordinator.renderedLineCount {
              // Incremental: parse only new lines and append
              let newLines = lines[coordinator.renderedLineCount...]
              let newText = newLines.joined(separator: "\n")
              if coordinator.renderedLineCount > 0 {
                  coordinator.renderedOutput.append(NSAttributedString(
                      string: "\n",
                      attributes: [
                          .font: UIFont.monospacedSystemFont(ofSize: 13, weight: .regular),
                          .foregroundColor: UIColor.white,
                      ]
                  ))
              }
              coordinator.renderedOutput.append(ANSIParser.parse(newText))
              coordinator.renderedLineCount = currentCount

              // Enforce char limit (~5000 lines at ~100 chars each)
              let maxChars = 500_000
              if coordinator.renderedOutput.length > maxChars {
                  let trimCount = coordinator.renderedOutput.length - maxChars
                  coordinator.renderedOutput.deleteCharacters(
                      in: NSRange(location: 0, length: trimCount)
                  )
              }
          }

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

- [ ] **Step 2: Verify build**

  ```bash
  cd OpenWorkMobile && xcodebuild -project OpenWorkMobile.xcodeproj -scheme OpenWorkMobile -destination 'generic/platform=iOS Simulator' build 2>&1 | tail -3
  ```

  Expected: `BUILD SUCCEEDED`

---

### Task 9.3: SessionViewModel and SessionView — live PTY interaction

**Purpose:** The core screen where users interact with a live PTY session. Connects the PTY WebSocket, displays terminal output, and provides an input bar for sending text.

**Files:**
- Modify: `OpenWorkMobile/OpenWorkMobile/ViewModels/SessionViewModel.swift`
- Modify: `OpenWorkMobile/OpenWorkMobile/Views/Sessions/SessionView.swift`

- [ ] **Step 1: Replace `SessionViewModel.swift`**

  ```swift
  import Foundation

  @Observable @MainActor
  final class SessionViewModel {
      var inputText = ""
      var autoScroll = true
      var showCommands = false

      let ptySession: OpenWorkPTYSession
      let projectPath: String
      private let apiClient: OpenWorkAPIClient

      init(
          ptyId: String,
          projectPath: String,
          connection: ServerConnection,
          apiClient: OpenWorkAPIClient
      ) {
          self.ptySession = OpenWorkPTYSession(ptyId: ptyId, connection: connection)
          self.projectPath = projectPath
          self.apiClient = apiClient
      }

      func connect() {
          ptySession.connect()
      }

      func disconnect() {
          ptySession.disconnect()
      }

      func reconnect() {
          ptySession.reconnect()
      }

      func sendInput() {
          let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
          guard !text.isEmpty else { return }
          Task {
              try? await apiClient.sendToSession(ptyId: ptySession.ptyId, text: text + "\n")
          }
          inputText = ""
          autoScroll = true
          HapticManager.impact(.light)
      }
  }
  ```

- [ ] **Step 2: Replace `SessionView.swift`**

  ```swift
  import SwiftUI

  struct SessionView: View {
      let ptyId: String
      let projectPath: String
      let connection: ServerConnection
      @Environment(ConnectionViewModel.self) private var connectionVM
      @State private var viewModel: SessionViewModel?

      var body: some View {
          Group {
              if let vm = viewModel {
                  sessionContent(vm)
              } else {
                  ProgressView("Connecting…")
              }
          }
          .navigationTitle(ptyId.prefix(8) + "…")
          .navigationBarTitleDisplayMode(.inline)
          .onAppear {
              if viewModel == nil {
                  let vm = SessionViewModel(
                      ptyId: ptyId,
                      projectPath: projectPath,
                      connection: connection,
                      apiClient: connectionVM.currentAPIClient
                  )
                  viewModel = vm
                  vm.connect()
              }
          }
          .onDisappear {
              viewModel?.disconnect()
          }
      }

      @ViewBuilder
      private func sessionContent(_ vm: SessionViewModel) -> some View {
          VStack(spacing: 0) {
              // PTY Output
              PTYOutputView(
                  lines: vm.ptySession.outputLines,
                  autoScroll: Binding(
                      get: { vm.autoScroll },
                      set: { vm.autoScroll = $0 }
                  )
              )

              // Connection status bar
              if vm.ptySession.isConnecting {
                  statusBar("Connecting…")
              } else if !vm.ptySession.isConnected && !vm.ptySession.hasExited {
                  statusBar("Reconnecting…")
              }

              // Exit banner
              if vm.ptySession.hasExited {
                  HStack {
                      Image(systemName: vm.ptySession.exitCode == 0
                            ? "checkmark.circle" : "xmark.circle")
                      Text("Session ended (exit code: \(vm.ptySession.exitCode.map(String.init) ?? "unknown"))")
                          .font(.callout)
                  }
                  .frame(maxWidth: .infinity)
                  .padding(.vertical, 8)
                  .background(vm.ptySession.exitCode == 0
                              ? Color.green.opacity(0.1)
                              : Color.red.opacity(0.1))
              }

              // Input bar
              if !vm.ptySession.hasExited {
                  inputBar(vm)
              }
          }
          .overlay(alignment: .bottomTrailing) {
              if !vm.autoScroll && !vm.ptySession.hasExited {
                  Button {
                      vm.autoScroll = true
                      HapticManager.impact(.light)
                  } label: {
                      Image(systemName: "arrow.down.circle.fill")
                          .font(.title)
                          .symbolRenderingMode(.hierarchical)
                          .padding(12)
                  }
              }
          }
          .sheet(isPresented: Binding(
              get: { vm.showCommands },
              set: { vm.showCommands = $0 }
          )) {
              CommandPickerSheet(projectPath: projectPath) { command in
                  vm.inputText = "/\(command)"
                  vm.showCommands = false
              }
          }
      }

      @ViewBuilder
      private func statusBar(_ text: String) -> some View {
          HStack {
              ProgressView()
                  .controlSize(.small)
              Text(text)
                  .font(.caption)
          }
          .frame(maxWidth: .infinity)
          .padding(.vertical, 6)
          .background(.ultraThinMaterial)
      }

      @ViewBuilder
      private func inputBar(_ vm: SessionViewModel) -> some View {
          HStack(spacing: 8) {
              Button {
                  vm.showCommands = true
              } label: {
                  Image(systemName: "slash.circle")
                      .font(.title3)
              }

              TextField("Type message…", text: Binding(
                  get: { vm.inputText },
                  set: { vm.inputText = $0 }
              ), axis: .vertical)
              .textFieldStyle(.plain)
              .lineLimit(1...5)
              .onSubmit { vm.sendInput() }

              Button {
                  vm.sendInput()
              } label: {
                  Image(systemName: "arrow.up.circle.fill")
                      .font(.title2)
              }
              .disabled(vm.inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          }
          .padding(.horizontal, 12)
          .padding(.vertical, 8)
          .background(.bar)
      }
  }

  /// Commands and skills picker, loaded from the discovery API.
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
                  if isLoading { ProgressView() }
              }
              .task { await loadCommands() }
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
              // Silently fail — not all providers support command discovery
          }
          isLoading = false
      }
  }
  ```

- [ ] **Step 3: Verify build**

  ```bash
  cd OpenWorkMobile && xcodebuild -project OpenWorkMobile.xcodeproj -scheme OpenWorkMobile -destination 'generic/platform=iOS Simulator' build 2>&1 | tail -3
  ```

  Expected: `BUILD SUCCEEDED`

- [ ] **Step 4: Commit PTY output + session view**

  ```bash
  git add OpenWorkMobile/OpenWorkMobile/Utilities/ANSIParser.swift \
        OpenWorkMobile/OpenWorkMobile/Views/Sessions/PTYOutputView.swift \
        OpenWorkMobile/OpenWorkMobile/Views/Sessions/SessionView.swift \
        OpenWorkMobile/OpenWorkMobile/ViewModels/SessionViewModel.swift
  git commit -m "feat(ios): implement live PTY session view with ANSI rendering

  ANSIParser with SGR color/bold/italic/underline support. PTYOutputView
  as UITextView wrapper with incremental rendering and 5000-line buffer.
  SessionView with input bar, command picker, auto-scroll, connection
  status, and exit banner. SessionViewModel manages PTY lifecycle.

  Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
  ```

---
## Group 10: History View

### Task 10.1: HistoryViewModel — fetch and format session messages

**Purpose:** ViewModel for viewing past session messages. Fetches structured messages from the history API and handles the `AnyCodableValue` content extraction.

**Files:**
- Modify: `OpenWorkMobile/OpenWorkMobile/ViewModels/HistoryViewModel.swift`

- [ ] **Step 1: Replace the stub with the full implementation**

  ```swift
  import Foundation

  @Observable @MainActor
  final class HistoryViewModel {
      var messages: [SessionMessage] = []
      var isLoading = false
      var errorMessage: String?

      private let apiClient: OpenWorkAPIClient
      let summary: SessionSummary

      init(apiClient: OpenWorkAPIClient, summary: SessionSummary) {
          self.apiClient = apiClient
          self.summary = summary
      }

      func loadMessages() async {
          isLoading = true
          errorMessage = nil
          do {
              messages = try await apiClient.sessionMessages(
                  sessionId: summary.sessionId,
                  projectPath: summary.projectPath,
                  provider: summary.provider
              )
          } catch APIError.unauthorized {
              errorMessage = "Token invalid — re-pair required"
          } catch {
              errorMessage = error.localizedDescription
          }
          isLoading = false
      }

      /// Filter out sidechain messages for the main view.
      var visibleMessages: [SessionMessage] {
          messages.filter { $0.isSidechain != true }
      }
  }
  ```

- [ ] **Step 2: Verify build**

  ```bash
  cd OpenWorkMobile && xcodebuild -project OpenWorkMobile.xcodeproj -scheme OpenWorkMobile -destination 'generic/platform=iOS Simulator' build 2>&1 | tail -3
  ```

  Expected: `BUILD SUCCEEDED`

---

### Task 10.2: HistoryView and HistoryMessageBubble — read-only chat view

**Purpose:** Read-only view of past session messages in a chat bubble layout. User messages are right-aligned, assistant messages are left-aligned.

**Files:**
- Modify: `OpenWorkMobile/OpenWorkMobile/Views/History/HistoryView.swift`
- Modify: `OpenWorkMobile/OpenWorkMobile/Views/History/HistoryMessageBubble.swift`

- [ ] **Step 1: Replace `HistoryView.swift`**

  ```swift
  import SwiftUI

  struct HistoryView: View {
      let summary: SessionSummary
      @Environment(ConnectionViewModel.self) private var connectionVM
      @State private var viewModel: HistoryViewModel?

      var body: some View {
          Group {
              if let vm = viewModel {
                  historyContent(vm)
              } else {
                  ProgressView("Loading…")
              }
          }
          .navigationTitle("Session History")
          .navigationBarTitleDisplayMode(.inline)
          .onAppear {
              if viewModel == nil {
                  viewModel = HistoryViewModel(
                      apiClient: connectionVM.currentAPIClient,
                      summary: summary
                  )
              }
          }
          .task {
              await viewModel?.loadMessages()
          }
      }

      @ViewBuilder
      private func historyContent(_ vm: HistoryViewModel) -> some View {
          ScrollView {
              LazyVStack(alignment: .leading, spacing: 12) {
                  ForEach(vm.visibleMessages) { message in
                      HistoryMessageBubble(message: message)
                  }
              }
              .padding()
          }
          .overlay {
              if vm.isLoading {
                  ProgressView("Loading messages…")
              } else if let error = vm.errorMessage {
                  ErrorView(message: error)
              } else if vm.visibleMessages.isEmpty && !vm.isLoading {
                  ContentUnavailableView {
                      Label("No Messages", systemImage: "bubble.left.and.bubble.right")
                  } description: {
                      Text("This session has no messages.")
                  }
              }
          }
      }
  }
  ```

- [ ] **Step 2: Replace `HistoryMessageBubble.swift`**

  ```swift
  import SwiftUI

  struct HistoryMessageBubble: View {
      let message: SessionMessage

      private var isUser: Bool { message.role == "user" }

      var body: some View {
          VStack(alignment: isUser ? .trailing : .leading, spacing: 4) {
              // Role label
              Text(message.role.capitalized)
                  .font(.caption2)
                  .fontWeight(.medium)
                  .foregroundStyle(.secondary)

              HStack {
                  if isUser { Spacer(minLength: 60) }

                  Text(message.textContent)
                      .font(.body)
                      .padding(12)
                      .background(
                          isUser
                              ? Color.blue.opacity(0.15)
                              : Color(.systemGray6)
                      )
                      .clipShape(RoundedRectangle(cornerRadius: 12))
                      .textSelection(.enabled)

                  if !isUser { Spacer(minLength: 60) }
              }

              if let ts = message.timestamp {
                  Text(ts)
                      .font(.caption2)
                      .foregroundStyle(.tertiary)
              }
          }
          .frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)
      }
  }
  ```

- [ ] **Step 3: Verify build**

  ```bash
  cd OpenWorkMobile && xcodebuild -project OpenWorkMobile.xcodeproj -scheme OpenWorkMobile -destination 'generic/platform=iOS Simulator' build 2>&1 | tail -3
  ```

  Expected: `BUILD SUCCEEDED`

- [ ] **Step 4: Commit history view**

  ```bash
  git add OpenWorkMobile/OpenWorkMobile/ViewModels/HistoryViewModel.swift \
        OpenWorkMobile/OpenWorkMobile/Views/History/
  git commit -m "feat(ios): implement history view with chat bubble layout

  HistoryViewModel fetches session messages and filters sidechains.
  HistoryView displays messages in a scrollable list. HistoryMessageBubble
  renders user/assistant messages as right/left-aligned chat bubbles.

  Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
  ```

---
## Group 11: Settings + Gestures + Utilities

### Task 11.1: HapticManager and shared utility views

**Purpose:** Implement haptic feedback helpers used throughout the app, and finalize the shared utility views (LoadingView, ErrorView).

**Files:**
- Modify: `OpenWorkMobile/OpenWorkMobile/Utilities/HapticManager.swift`
- Verify: `OpenWorkMobile/OpenWorkMobile/Views/Shared/LoadingView.swift` (already complete from stubs)
- Verify: `OpenWorkMobile/OpenWorkMobile/Views/Shared/ErrorView.swift` (already complete from stubs)

- [ ] **Step 1: Replace `HapticManager.swift` with full implementation**

  ```swift
  import UIKit

  /// Centralized haptic feedback. Call from any view for consistent tactile responses.
  enum HapticManager {

      static func impact(_ style: UIImpactFeedbackGenerator.FeedbackStyle) {
          let generator = UIImpactFeedbackGenerator(style: style)
          generator.prepare()
          generator.impactOccurred()
      }

      static func notification(_ type: UINotificationFeedbackGenerator.FeedbackType) {
          let generator = UINotificationFeedbackGenerator()
          generator.prepare()
          generator.notificationOccurred(type)
      }

      static func selection() {
          let generator = UISelectionFeedbackGenerator()
          generator.prepare()
          generator.selectionChanged()
      }
  }
  ```

- [ ] **Step 2: Verify build**

  ```bash
  cd OpenWorkMobile && xcodebuild -project OpenWorkMobile.xcodeproj -scheme OpenWorkMobile -destination 'generic/platform=iOS Simulator' build 2>&1 | tail -3
  ```

  Expected: `BUILD SUCCEEDED`

---

### Task 11.2: SettingsView — server management and disconnect

**Purpose:** Display current server connection info, allow switching or removing servers, and provide a disconnect action.

**Files:**
- Modify: `OpenWorkMobile/OpenWorkMobile/Views/Settings/SettingsView.swift`

- [ ] **Step 1: Replace the stub with the full implementation**

  ```swift
  import SwiftUI

  struct SettingsView: View {
      @Environment(ConnectionViewModel.self) private var connectionVM

      var body: some View {
          Form {
              if let active = connectionVM.activeConnection {
                  Section("Current Server") {
                      LabeledContent("Name", value: active.name)
                      LabeledContent("Host", value: active.host)
                      LabeledContent("Port", value: String(active.port))
                      LabeledContent("Token") {
                          Text(maskToken(active.token))
                              .font(.caption.monospaced())
                              .foregroundStyle(.secondary)
                      }
                  }

                  Section {
                      Button(role: .destructive) {
                          connectionVM.disconnect()
                          HapticManager.notification(.warning)
                      } label: {
                          Label("Disconnect", systemImage: "wifi.slash")
                      }
                  }
              }

              if connectionVM.connections.count > 1 {
                  Section("All Servers") {
                      ForEach(connectionVM.connections) { conn in
                          HStack {
                              VStack(alignment: .leading) {
                                  Text(conn.name)
                                      .font(.headline)
                                  Text("\(conn.host):\(conn.port)")
                                      .font(.caption)
                                      .foregroundStyle(.secondary)
                              }
                              Spacer()
                              if conn.id == connectionVM.activeConnection?.id {
                                  Image(systemName: "checkmark.circle.fill")
                                      .foregroundStyle(.green)
                              } else {
                                  Button("Connect") {
                                      connectionVM.activateConnection(conn)
                                      HapticManager.impact(.medium)
                                  }
                                  .buttonStyle(.bordered)
                                  .controlSize(.small)
                              }
                          }
                          .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                              Button(role: .destructive) {
                                  connectionVM.removeConnection(conn)
                                  HapticManager.notification(.warning)
                              } label: {
                                  Label("Remove", systemImage: "trash")
                              }
                          }
                      }
                  }
              }

              Section("About") {
                  LabeledContent("Version", value: "1.0.0")
                  LabeledContent("App", value: "OpenWork Mobile")
                  Link("OpenWork on GitHub", destination: URL(string: "https://github.com/openwork")!)
              }
          }
          .navigationTitle("Settings")
      }

      private func maskToken(_ token: String) -> String {
          guard token.count > 8 else { return "••••" }
          let prefix = token.prefix(4)
          let suffix = token.suffix(4)
          return "\(prefix)…\(suffix)"
      }
  }
  ```

- [ ] **Step 2: Verify build**

  ```bash
  cd OpenWorkMobile && xcodebuild -project OpenWorkMobile.xcodeproj -scheme OpenWorkMobile -destination 'generic/platform=iOS Simulator' build 2>&1 | tail -3
  ```

  Expected: `BUILD SUCCEEDED`

---

### Task 11.3: iPad NavigationSplitView adaptation

**Purpose:** Enhance `ContentView` and `MainNavigationView` to use a three-column `NavigationSplitView` on iPad for a better large-screen experience.

**Files:**
- Modify: `OpenWorkMobile/OpenWorkMobile/App/ContentView.swift`

- [ ] **Step 1: Update `MainNavigationView` for iPad three-column layout**

  Replace the `MainNavigationView` struct in `ContentView.swift`:

  Replace:
  ```swift
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

  With:
  ```swift
  struct MainNavigationView: View {
      @Environment(\.horizontalSizeClass) private var sizeClass
      @State private var selectedProject: Project?
      @State private var selectedPtyId: String?
      @State private var selectedSummary: SessionSummary?

      var body: some View {
          if sizeClass == .regular {
              // iPad: three-column split view
              NavigationSplitView {
                  ProjectsListView()
              } content: {
                  if let project = selectedProject {
                      SessionsListView(project: project)
                  } else {
                      Text("Select a project")
                          .foregroundStyle(.secondary)
                  }
              } detail: {
                  Text("Select a session")
                      .foregroundStyle(.secondary)
              }
          } else {
              // iPhone: standard navigation stack
              NavigationStack {
                  ProjectsListView()
              }
          }
      }
  }
  ```

- [ ] **Step 2: Verify build**

  ```bash
  cd OpenWorkMobile && xcodebuild -project OpenWorkMobile.xcodeproj -scheme OpenWorkMobile -destination 'generic/platform=iOS Simulator' build 2>&1 | tail -3
  ```

  Expected: `BUILD SUCCEEDED`

- [ ] **Step 3: Commit settings, gestures, and iPad adaptation**

  ```bash
  git add OpenWorkMobile/OpenWorkMobile/Utilities/HapticManager.swift \
        OpenWorkMobile/OpenWorkMobile/Views/Settings/ \
        OpenWorkMobile/OpenWorkMobile/App/ContentView.swift
  git commit -m "feat(ios): implement settings, haptics, and iPad adaptation

  SettingsView with server management, disconnect, and about section.
  HapticManager with impact/notification/selection helpers. iPad
  three-column NavigationSplitView layout for landscape.

  Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
  ```

---
## Group 12: Phase 4 — Advanced Features

### Task 12.1: QR code scanning for token pairing

**Purpose:** Use `AVFoundation` to scan a QR code containing the server connection info. The QR format (from design doc §2.6) is a JSON payload: `{"host":"...", "port":3002, "token":"..."}`.

**Files:**
- Create: `OpenWorkMobile/OpenWorkMobile/Views/Connection/QRScannerView.swift`
- Modify: `OpenWorkMobile/OpenWorkMobile/Views/Connection/ConnectionSetupView.swift`

- [ ] **Step 1: Create `QRScannerView.swift`**

  Create `OpenWorkMobile/OpenWorkMobile/Views/Connection/QRScannerView.swift`:

  ```swift
  import SwiftUI
  import AVFoundation

  /// Camera-based QR code scanner using AVFoundation.
  struct QRScannerView: UIViewControllerRepresentable {
      let onScanned: (String) -> Void

      func makeUIViewController(context: Context) -> QRScannerController {
          let controller = QRScannerController()
          controller.onScanned = onScanned
          return controller
      }

      func updateUIViewController(_ uiViewController: QRScannerController, context: Context) {}
  }

  final class QRScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
      var onScanned: ((String) -> Void)?
      private var captureSession: AVCaptureSession?
      private var hasScanned = false

      override func viewDidLoad() {
          super.viewDidLoad()
          view.backgroundColor = .black

          let session = AVCaptureSession()
          guard let device = AVCaptureDevice.default(for: .video),
                let input = try? AVCaptureDeviceInput(device: device) else {
              showError()
              return
          }

          if session.canAddInput(input) {
              session.addInput(input)
          }

          let output = AVCaptureMetadataOutput()
          if session.canAddOutput(output) {
              session.addOutput(output)
              output.setMetadataObjectsDelegate(self, queue: .main)
              output.metadataObjectTypes = [.qr]
          }

          let previewLayer = AVCaptureVideoPreviewLayer(session: session)
          previewLayer.videoGravity = .resizeAspectFill
          previewLayer.frame = view.bounds
          view.layer.addSublayer(previewLayer)

          captureSession = session
          Task.detached { [weak session] in
              session?.startRunning()
          }
      }

      override func viewWillDisappear(_ animated: Bool) {
          super.viewWillDisappear(animated)
          captureSession?.stopRunning()
      }

      override func viewDidLayoutSubviews() {
          super.viewDidLayoutSubviews()
          if let layer = view.layer.sublayers?.first(where: { $0 is AVCaptureVideoPreviewLayer }) {
              layer.frame = view.bounds
          }
      }

      func metadataOutput(
          _ output: AVCaptureMetadataOutput,
          didOutput metadataObjects: [AVMetadataObject],
          from connection: AVCaptureConnection
      ) {
          guard !hasScanned,
                let metadata = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
                metadata.type == .qr,
                let value = metadata.stringValue else { return }
          hasScanned = true
          captureSession?.stopRunning()
          HapticManager.notification(.success)
          onScanned?(value)
      }

      private func showError() {
          let label = UILabel()
          label.text = "Camera not available"
          label.textColor = .white
          label.textAlignment = .center
          label.translatesAutoresizingMaskIntoConstraints = false
          view.addSubview(label)
          NSLayoutConstraint.activate([
              label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
              label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
          ])
      }
  }
  ```

- [ ] **Step 2: Add QR scanner button to ConnectionSetupView**

  In `ConnectionSetupView.swift`, add the QR scanner sheet and button. Add a `@State private var showQRScanner = false` property if not already present. Then add a Section before the error section:

  Add after the "Authentication" section:
  ```swift
                  Section {
                      Button {
                          showQRScanner = true
                          HapticManager.impact(.medium)
                      } label: {
                          Label("Scan QR Code", systemImage: "qrcode.viewfinder")
                      }
                  }
  ```

  Add to the NavigationStack modifiers:
  ```swift
              .sheet(isPresented: $showQRScanner) {
                  QRScannerView { result in
                      parseQRResult(result)
                      showQRScanner = false
                  }
              }
  ```

  Add the `parseQRResult` method and the `showQRScanner` state:
  ```swift
      @State private var showQRScanner = false

      private func parseQRResult(_ string: String) {
          guard let data = string.data(using: .utf8),
                let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
              errorMessage = "Invalid QR code format"
              return
          }
          if let h = json["host"] as? String { host = h }
          if let p = json["port"] as? Int { port = String(p) }
          if let t = json["token"] as? String { token = t }
          if let n = json["name"] as? String { serverName = n }
      }
  ```

- [ ] **Step 3: Verify build**

  ```bash
  cd OpenWorkMobile && xcodebuild -project OpenWorkMobile.xcodeproj -scheme OpenWorkMobile -destination 'generic/platform=iOS Simulator' build 2>&1 | tail -3
  ```

  Expected: `BUILD SUCCEEDED`

---

### Task 12.2: Multi-server support in ConnectionViewModel

**Purpose:** Enable users to save multiple server connections and switch between them. The SettingsView already supports this UI — this task ensures the data flow is correct.

**Files:**
- Verify/Modify: `OpenWorkMobile/OpenWorkMobile/ViewModels/ConnectionViewModel.swift`

- [ ] **Step 1: Verify multi-server support is already implemented**

  The `ConnectionViewModel` already stores `connections: [ServerConnection]` and has `activateConnection(_:)` and `removeConnection(_:)` methods. Verify that:

  1. `connections` is loaded from Keychain on init ✓
  2. `validateAndSave` appends new connections or updates existing ones ✓
  3. `removeConnection` persists the removal to Keychain ✓
  4. `activateConnection` switches the API client to the selected server ✓

  No code changes needed — multi-server is already supported by the ConnectionViewModel and SettingsView.

- [ ] **Step 2: Verify build**

  ```bash
  cd OpenWorkMobile && xcodebuild -project OpenWorkMobile.xcodeproj -scheme OpenWorkMobile -destination 'generic/platform=iOS Simulator' build 2>&1 | tail -3
  ```

  Expected: `BUILD SUCCEEDED`

---

### Task 12.3: Session resume and WaitingForInput notification

**Purpose:** Add local notifications when a session enters `WaitingForInput` state, and integrate the session resume flow from NewSessionSheet.

**Files:**
- Create: `OpenWorkMobile/OpenWorkMobile/Utilities/NotificationManager.swift`

- [ ] **Step 1: Create `NotificationManager.swift`**

  ```swift
  import UserNotifications

  /// Manages local notifications for session events.
  enum NotificationManager {

      static func requestPermission() {
          UNUserNotificationCenter.current().requestAuthorization(
              options: [.alert, .sound, .badge]
          ) { _, _ in }
      }

      /// Send a local notification when a session needs input.
      static func notifyWaitingForInput(sessionId: String) {
          let content = UNMutableNotificationContent()
          content.title = "Session Waiting"
          content.body = "Session \(sessionId.prefix(8))… needs your input."
          content.sound = .default

          let request = UNNotificationRequest(
              identifier: "waiting-\(sessionId)",
              content: content,
              trigger: nil // Deliver immediately
          )
          UNUserNotificationCenter.current().add(request)
      }

      /// Clear notifications for a session that is no longer waiting.
      static func clearNotification(sessionId: String) {
          UNUserNotificationCenter.current().removeDeliveredNotifications(
              withIdentifiers: ["waiting-\(sessionId)"]
          )
      }
  }
  ```

- [ ] **Step 2: Request notification permission in the app entry point**

  In `OpenWorkMobileApp.swift`, add an `onAppear` to the ContentView:

  Add after `.environment(connectionVM)`:
  ```swift
                  .onAppear {
                      NotificationManager.requestPermission()
                  }
  ```

- [ ] **Step 3: Trigger notification from SessionViewModel when WaitingForInput is detected**

  In `SessionViewModel.swift`, add a computed property and observer. After the `sendInput()` method, add:

  ```swift
      /// Check PTY output for input-waiting patterns and notify if backgrounded.
      func checkForWaitingPatterns() {
          guard let lastLine = ptySession.outputLines.last else { return }
          let patterns = ["[y/n]", "[Y/n]", "press enter", "continue?", "(yes/no)"]
          let isWaiting = patterns.contains { lastLine.localizedCaseInsensitiveContains($0) }
          if isWaiting {
              NotificationManager.notifyWaitingForInput(sessionId: ptySession.ptyId)
          }
      }
  ```

- [ ] **Step 4: Regenerate the Xcode project to pick up new files**

  ```bash
  cd OpenWorkMobile && xcodegen generate 2>&1 | tail -3
  ```

  Expected: project regenerated successfully.

- [ ] **Step 5: Verify build**

  ```bash
  cd OpenWorkMobile && xcodebuild -project OpenWorkMobile.xcodeproj -scheme OpenWorkMobile -destination 'generic/platform=iOS Simulator' build 2>&1 | tail -3
  ```

  Expected: `BUILD SUCCEEDED`

- [ ] **Step 6: Commit advanced features**

  ```bash
  git add OpenWorkMobile/
  git commit -m "feat(ios): add QR scanner, notifications, and advanced features

  QRScannerView with AVFoundation camera for token pairing. QR format:
  {host, port, token}. NotificationManager for WaitingForInput alerts.
  Multi-server support verified. Session resume flow integrated.

  Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
  ```

---
## Appendix: Quick Reference

### Build Commands

```bash
# Full build
cd OpenWorkMobile && xcodebuild -project OpenWorkMobile.xcodeproj -scheme OpenWorkMobile -destination 'generic/platform=iOS Simulator' build

# Run tests
cd OpenWorkMobile && xcodebuild test -project OpenWorkMobile.xcodeproj -scheme OpenWorkMobileTests -destination 'platform=iOS Simulator,name=iPhone 16'

# Regenerate project after adding files
cd OpenWorkMobile && xcodegen generate

# Backend check (Rust)
cd src-tauri && cargo check
```

### File Summary

| Group | Files Created/Modified | Purpose |
|-------|----------------------|---------|
| 0 | `src-tauri/src/{pty,http_server}.rs` | Add `project_path` to sessions API |
| 1 | `OpenWorkMobile/` (35 files) | Xcode project scaffold |
| 2 | 10 model files | Data models matching Rust API |
| 3 | `TokenStorage.swift` + tests | Keychain persistence |
| 4 | `OpenWorkAPIClient.swift` | REST API client |
| 5 | `OpenWorkPTYSession.swift` | PTY WebSocket client |
| 6 | ConnectionVM + SetupView + ContentView | Connection flow |
| 7 | Projects/Sessions VMs + Views | Browse projects/sessions |
| 8 | `NewSessionSheet.swift` | Create new sessions |
| 9 | ANSIParser + PTYOutputView + SessionView | Live PTY interaction |
| 10 | HistoryVM + HistoryView | Read-only session history |
| 11 | Settings + HapticManager + iPad layout | Polish and adaptation |
| 12 | QRScanner + Notifications | Advanced features |

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────┐
│                    SwiftUI Views                        │
│  ConnectionSetupView → ProjectsListView → SessionView   │
│                                                         │
│  Views observe @Observable ViewModels via @Environment   │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────┴────────────────────────────────┐
│                    ViewModels                            │
│  ConnectionViewModel (owns API client)                   │
│  ProjectsViewModel, SessionsViewModel, HistoryViewModel  │
│  SessionViewModel (owns PTY session)                     │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────┴────────────────────────────────┐
│                  Service Layer                           │
│  OpenWorkAPIClient (REST via URLSession)                 │
│  OpenWorkPTYSession (WebSocket via URLSession)           │
│  TokenStorage (Keychain via Security.framework)          │
└────────────────────────┬────────────────────────────────┘
                         │ HTTP/WS
                         ▼
              ┌──────────────────────┐
              │  OpenWork Tauri      │
              │  Backend (:3002)     │
              └──────────────────────┘
```

### Task Count Summary

| Group | Tasks | Estimated Time |
|-------|-------|---------------|
| 0: Backend | 1 | 10 min |
| 1: Xcode Setup | 3 | 25 min |
| 2: Models | 4 | 30 min |
| 3: TokenStorage | 2 | 15 min |
| 4: API Client | 1* | 15 min |
| 5: PTY WebSocket | 1* | 10 min |
| 6: Connection | 3 | 20 min |
| 7: Projects/Sessions | 4 | 30 min |
| 8: New Session | 1 | 10 min |
| 9: PTY Output | 3 | 30 min |
| 10: History | 2 | 15 min |
| 11: Settings | 3 | 20 min |
| 12: Advanced | 3 | 25 min |
| **Total** | **31** | **~4.5 hours** |

\* API Client and PTY WebSocket are consolidated from multiple sub-tasks into single tasks since each is one cohesive file.

---

*End of plan. Implement task-by-task. Do not skip ahead. Verify build after each task.*
