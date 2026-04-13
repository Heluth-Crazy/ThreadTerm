import SwiftUI

struct ProjectsListView: View {
    @Environment(ConnectionViewModel.self) private var connectionVM
    @State private var viewModel = ProjectsViewModel()

    var body: some View {
        Group {
            if let error = viewModel.error, viewModel.projects.isEmpty {
                ContentUnavailableView {
                    Label("Connection Error", systemImage: "wifi.slash")
                } description: {
                    Text(error)
                } actions: {
                    Button("Retry") {
                        Task { await refresh() }
                    }
                    .buttonStyle(.bordered)
                }
            } else if viewModel.projects.isEmpty && !viewModel.isLoading {
                emptyState
            } else {
                projectList
            }
        }
        .overlay {
            if viewModel.isLoading && viewModel.projects.isEmpty {
                LoadingView(message: "Loading projects…")
            }
        }
        .refreshable { await refresh() }
        .task { await refresh() }
    }

    private var projectList: some View {
        List(viewModel.projects) { project in
            NavigationLink(value: project) {
                ProjectRow(
                    project: project,
                    activeCount: viewModel.activeSessionsForProject(project).count
                )
            }
        }
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label("No Projects", systemImage: "folder")
        } description: {
            Text("No projects found. Open a project in Claude Code on your Mac first.")
        }
    }

    private func refresh() async {
        guard let client = connectionVM.currentAPIClient else { return }
        await viewModel.refresh(using: client)
    }
}
