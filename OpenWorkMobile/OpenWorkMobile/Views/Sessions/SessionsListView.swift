import SwiftUI

struct SessionsListView: View {
    let project: Project
    @Environment(ConnectionViewModel.self) private var connectionVM
    @State private var projectsVM = ProjectsViewModel()
    @State private var isLoading = false

    var body: some View {
        List {
            if !activeSessions.isEmpty {
                Section("Active Sessions") {
                    ForEach(activeSessions) { session in
                        NavigationLink(value: sessionFromActive(session)) {
                            ActiveSessionRow(session: session)
                        }
                    }
                }
            }

            if !project.sessions.isEmpty {
                Section("Session History") {
                    ForEach(project.sessions) { session in
                        NavigationLink(value: session) {
                            SessionHistoryRow(session: session)
                        }
                    }
                }
            }

            if activeSessions.isEmpty && project.sessions.isEmpty {
                ContentUnavailableView {
                    Label("No Sessions", systemImage: "bubble.left.and.bubble.right")
                } description: {
                    Text("Start a new session from the desktop app.")
                }
            }
        }
        .navigationTitle(project.name)
        .refreshable { await refresh() }
        .task { await refresh() }
    }

    private var activeSessions: [ActiveSessionInfo] {
        projectsVM.activeSessionsForProject(project)
    }

    private func sessionFromActive(_ active: ActiveSessionInfo) -> Session {
        if let existing = project.sessions.first(where: { $0.id == active.id }) {
            return existing
        }
        return Session(
            id: active.id,
            projectPath: project.fullPath,
            provider: active.effectiveProvider,
            name: nil,
            createdAt: nil,
            lastMessage: nil,
            messageCount: 0
        )
    }

    private func refresh() async {
        guard let client = connectionVM.currentAPIClient else { return }
        isLoading = true
        await projectsVM.refresh(using: client)
        isLoading = false
    }
}

// MARK: - Row Views

private struct ActiveSessionRow: View {
    let session: ActiveSessionInfo

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text("Active Session")
                    .font(.headline)
                Text(session.id.prefix(8) + "…")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            ProviderBadge(provider: session.effectiveProvider)
            Circle()
                .fill(.green)
                .frame(width: 8, height: 8)
        }
    }
}

private struct SessionHistoryRow: View {
    let session: Session

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text(session.name ?? "Session")
                    .font(.headline)
                if let lastMsg = session.lastMessage {
                    Text(lastMsg)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 4) {
                ProviderBadge(provider: session.provider)
                if let date = session.createdAt {
                    Text(date.prefix(10))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 2)
    }
}

// MARK: - Provider Badge

struct ProviderBadge: View {
    let provider: String

    var body: some View {
        Text(provider)
            .font(.caption2.bold())
            .foregroundStyle(.white)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color, in: Capsule())
    }

    private var color: Color {
        switch provider.lowercased() {
        case "claude": return .orange
        case "codex":  return .blue
        case "cursor": return .purple
        default:       return .gray
        }
    }
}
