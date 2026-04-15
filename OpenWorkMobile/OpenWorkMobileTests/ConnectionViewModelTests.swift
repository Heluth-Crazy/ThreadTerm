import XCTest
@testable import OpenWorkMobile

@MainActor
final class ConnectionViewModelTests: XCTestCase {
    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: "saved_connections")
        super.tearDown()
    }

    func testConnectFailsWhenAuthenticatedValidationRejectsToken() async {
        let connection = ServerConnection(
            name: "Test",
            host: "192.168.1.118",
            port: 3002,
            token: "invalid-token"
        )
        let client = MockOpenWorkAPIClient(connection: connection)
        client.authValidationError = .unauthorized
        let viewModel = ConnectionViewModel { _ in client }

        await viewModel.connect(to: connection)

        guard case .failed(let message) = viewModel.state else {
            return XCTFail("Expected connection failure for invalid token")
        }

        XCTAssertEqual(message, APIError.unauthorized.localizedDescription)
        XCTAssertFalse(viewModel.didJustConnect)
        XCTAssertTrue(viewModel.connectionLog.contains(where: { $0.contains("API token") }))
        XCTAssertEqual(viewModel.draft.host, connection.host)
        XCTAssertEqual(viewModel.draft.port, String(connection.port))
        XCTAssertEqual(viewModel.draft.token, connection.token)
    }

    func testConnectSucceedsAfterAuthenticatedValidationPasses() async {
        let connection = ServerConnection(
            name: "Test",
            host: "192.168.1.118",
            port: 3002,
            token: "valid-token"
        )
        let client = MockOpenWorkAPIClient(connection: connection)
        let viewModel = ConnectionViewModel { _ in client }
        defer {
            TokenStorage.delete(for: connection.host, port: connection.port)
        }

        await viewModel.connect(to: connection)

        guard case .connected(let connectedClient) = viewModel.state else {
            return XCTFail("Expected connection success for valid token")
        }

        XCTAssertTrue(connectedClient === client)
        XCTAssertTrue(viewModel.didJustConnect)
        XCTAssertEqual(TokenStorage.load(for: connection.host, port: connection.port), "valid-token")
        XCTAssertEqual(viewModel.draft.host, connection.host)
        XCTAssertEqual(viewModel.draft.token, connection.token)
    }

    func testSelectSavedConnectionUpdatesDraftWithResolvedToken() {
        let connection = ServerConnection(
            name: "Saved",
            host: "192.168.1.118",
            port: 3002,
            token: ""
        )
        let storedToken = "saved-token"
        TokenStorage.save(token: storedToken, for: connection.host, port: connection.port)
        defer {
            TokenStorage.delete(for: connection.host, port: connection.port)
        }

        let viewModel = ConnectionViewModel()

        let resolved = viewModel.selectSavedConnection(connection)

        XCTAssertEqual(resolved.token, storedToken)
        XCTAssertEqual(viewModel.draft.host, connection.host)
        XCTAssertEqual(viewModel.draft.port, String(connection.port))
        XCTAssertEqual(viewModel.draft.token, storedToken)
        XCTAssertEqual(viewModel.draft.name, connection.name)
    }
}

private final class MockOpenWorkAPIClient: OpenWorkAPIClient {
    var authValidationError: APIError?

    override func healthCheck() async throws -> HealthResponse {
        HealthResponse(
            status: "ok",
            app: "openwork",
            lanUrl: "http://192.168.1.118:3002"
        )
    }

    override func validateAuthentication() async throws {
        if let authValidationError {
            throw authValidationError
        }
    }
}
