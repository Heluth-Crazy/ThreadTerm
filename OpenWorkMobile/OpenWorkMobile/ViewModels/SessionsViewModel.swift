import Foundation

// DEPRECATED — not used. All session state is managed by ProjectsViewModel.
@Observable @MainActor
final class SessionsViewModel {
    var activeSessions: [ActiveSessionInfo] = []
}
