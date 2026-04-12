import Foundation

@Observable @MainActor
final class ProjectsViewModel {
    var projects: [Project] = []
}
