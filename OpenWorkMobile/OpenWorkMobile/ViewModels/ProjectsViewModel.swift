import Foundation

@Observable
class ProjectsViewModel {
    private(set) var projects: [Project] = []
    private(set) var activeSessions: [ActiveSessionInfo] = []
    private(set) var isLoading = false
    private(set) var error: String?

    /// Fetches projects and active sessions in parallel, then merges.
    func refresh(using client: OpenWorkAPIClient) async {
        await MainActor.run {
            isLoading = true
            error = nil
        }
        do {
            async let fetchedProjects = client.fetchProjects()
            async let fetchedSessions = client.fetchActiveSessions()
            let (p, s) = try await (fetchedProjects, fetchedSessions)
            await MainActor.run {
                projects = p
                activeSessions = s
                isLoading = false
            }
        } catch {
            await MainActor.run {
                self.error = error.localizedDescription
                isLoading = false
            }
        }
    }

    /// Returns active sessions whose projectPath matches the project's fullPath.
    func activeSessionsForProject(_ project: Project) -> [ActiveSessionInfo] {
        activeSessions.filter { $0.projectPath == project.fullPath }
    }
}
