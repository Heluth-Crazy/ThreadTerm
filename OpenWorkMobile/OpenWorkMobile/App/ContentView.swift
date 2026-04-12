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
                .navigationDestination(for: Session.self) { session in
                    SessionDetailView(session: session)
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
    let session: Session
    @State private var selectedTab = 0

    var body: some View {
        TabView(selection: $selectedTab) {
            SessionView(session: session)
                .tabItem {
                    Label("Chat", systemImage: "bubble.left.and.bubble.right")
                }
                .tag(0)

            PTYOutputView(session: session)
                .tabItem {
                    Label("Terminal", systemImage: "terminal")
                }
                .tag(1)

            HistoryView(session: session)
                .tabItem {
                    Label("History", systemImage: "clock")
                }
                .tag(2)
        }
        .navigationTitle(session.name ?? "Session")
        .navigationBarTitleDisplayMode(.inline)
    }
}
