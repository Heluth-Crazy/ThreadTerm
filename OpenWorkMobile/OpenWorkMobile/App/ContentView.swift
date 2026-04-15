import SwiftUI

struct ContentView: View {
    @Environment(ConnectionViewModel.self) private var connectionVM

    var body: some View {
        switch connectionVM.state {
        case .disconnected, .failed:
            ConnectionSetupView()
        case .connecting:
            LoadingView(message: "Connecting…")
        case .connected:
            MainNavigationView()
        }
    }
}

// MARK: - Main Navigation

struct MainNavigationView: View {
    @Environment(ConnectionViewModel.self) private var connectionVM
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var path = NavigationPath()
    @State private var showSettings = false

    var body: some View {
        NavigationStack(path: $path) {
            ProjectsListView()
                .navigationTitle("OpenWork")
                .navigationDestination(for: Project.self) { project in
                    SessionsListView(project: project)
                }
                .navigationDestination(for: SessionDestination.self) { dest in
                    SessionDetailView(destination: dest)
                }
                .toolbar {
                    ToolbarItem(placement: .navigationBarTrailing) {
                        Button { showSettings = true } label: {
                            Image(systemName: "gear")
                        }
                    }
                }
        }
        .sheet(isPresented: $showSettings) {
            SettingsView()
        }
    }
}

// MARK: - Session Detail (Tab View for Chat / Terminal / History)

struct SessionDetailView: View {
    enum Tab: Int {
        case chat
        case terminal
        case history
    }

    let destination: SessionDestination
    @State private var selectedTab: Tab = .chat

    var body: some View {
        TabView(selection: $selectedTab) {
            tabContent(for: .chat)
                .tabItem {
                    Label("Chat", systemImage: "bubble.left.and.bubble.right")
                }
                .tag(Tab.chat)

            tabContent(for: .terminal)
                .tabItem {
                    Label("Terminal", systemImage: "terminal")
                }
                .tag(Tab.terminal)

            tabContent(for: .history)
                .tabItem {
                    Label("History", systemImage: "clock")
                }
                .tag(Tab.history)
        }
        .navigationTitle(destination.session.name ?? "Session")
        .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder
    private func tabContent(for tab: Tab) -> some View {
        if selectedTab == tab {
            switch tab {
            case .chat:
                SessionView(
                    session: destination.session,
                    isActiveSession: destination.isActive
                )
            case .terminal:
                if let ptyId = destination.terminalPTYId {
                    PTYOutputView(ptyId: ptyId)
                } else {
                    ContentUnavailableView {
                        Label("Terminal Unavailable", systemImage: "terminal")
                    } description: {
                        Text("This item is saved session history, not a live PTY session.")
                    }
                }
            case .history:
                HistoryView(session: destination.session)
            }
        } else {
            Color.clear
        }
    }
}
