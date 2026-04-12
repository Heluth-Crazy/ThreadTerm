import Foundation

@Observable @MainActor
final class SessionsViewModel {
    var activeSessions: [ActiveSessionInfo] = []
}
