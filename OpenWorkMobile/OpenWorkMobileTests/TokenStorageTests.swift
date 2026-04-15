import XCTest
@testable import OpenWorkMobile

final class TokenStorageTests: XCTestCase {
    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: "saved_connections")
        super.tearDown()
    }

    func testServerConnectionEncodingOmitsToken() throws {
        let connection = ServerConnection(
            name: "My Mac",
            host: "192.168.1.118",
            port: 3002,
            token: "secret-token"
        )

        let data = try JSONEncoder().encode(connection)
        let json = try XCTUnwrap(String(data: data, encoding: .utf8))

        XCTAssertFalse(json.contains("secret-token"))
        XCTAssertFalse(json.contains("\"token\""))

        let decoded = try JSONDecoder().decode(ServerConnection.self, from: data)
        XCTAssertEqual(decoded.host, connection.host)
        XCTAssertEqual(decoded.port, connection.port)
        XCTAssertEqual(decoded.token, "")
    }

    @MainActor
    func testResolvedSavedConnectionPrefersKeychainToken() {
        let host = "token-storage-tests.local"
        let port = 33002
        defer {
            TokenStorage.delete(for: host, port: port)
        }

        XCTAssertTrue(TokenStorage.save(token: "fresh-token", for: host, port: port))

        let viewModel = ConnectionViewModel()
        let saved = ServerConnection(
            name: "Saved",
            host: host,
            port: port,
            token: "stale-token"
        )

        let resolved = viewModel.resolvedSavedConnection(saved)
        XCTAssertEqual(resolved.token, "fresh-token")
    }

    func testActiveSessionDestinationExposesTerminalPTYId() {
        let destination = SessionDestination(
            session: Session(
                id: "pty-123",
                projectPath: "/tmp/project",
                provider: "claude",
                name: nil,
                createdAt: nil,
                lastMessage: nil,
                messageCount: 0
            ),
            isActive: true
        )

        XCTAssertEqual(destination.terminalPTYId, "pty-123")
    }

    func testHistorySessionDestinationDoesNotExposeTerminalPTYId() {
        let destination = SessionDestination(
            session: Session(
                id: "history-123",
                projectPath: "/tmp/project",
                provider: "codex",
                name: nil,
                createdAt: nil,
                lastMessage: nil,
                messageCount: 0
            ),
            isActive: false
        )

        XCTAssertNil(destination.terminalPTYId)
    }
}
