import SwiftUI

struct SettingsView: View {
    @Environment(ConnectionViewModel.self) private var connectionVM
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                currentConnectionSection
                savedConnectionsSection
                aboutSection
                debugSection
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    // MARK: - Sections

    private var currentConnectionSection: some View {
        Section("Current Connection") {
            if let client = connectionVM.currentAPIClient {
                LabeledContent("Host", value: client.connection.host)
                LabeledContent("Port", value: String(client.connection.port))
                LabeledContent("Status") {
                    HStack {
                        Circle().fill(.green).frame(width: 8, height: 8)
                        Text("Connected")
                    }
                }
                Button(role: .destructive) {
                    connectionVM.disconnect()
                    dismiss()
                } label: {
                    Label("Disconnect", systemImage: "wifi.slash")
                }
            } else {
                Text("Not connected")
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private var savedConnectionsSection: some View {
        if !connectionVM.savedConnections.isEmpty {
            Section("Saved Connections") {
                ForEach(connectionVM.savedConnections) { conn in
                    VStack(alignment: .leading) {
                        Text(conn.name.isEmpty ? conn.host : conn.name)
                            .font(.headline)
                        Text("\(conn.host):\(conn.port)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .onDelete { offsets in
                    for index in offsets {
                        connectionVM.deleteConnection(connectionVM.savedConnections[index])
                    }
                }
            }
        }
    }

    private var aboutSection: some View {
        Section("About") {
            LabeledContent("App Version", value: appVersion)
            LabeledContent("Build", value: buildNumber)
            Link(destination: URL(string: "https://github.com/OpenWork-app/OpenWork")!) {
                Label("GitHub Repository", systemImage: "link")
            }
        }
    }

    private var debugSection: some View {
        Section("Debug") {
            if let client = connectionVM.currentAPIClient {
                Button {
                    UIPasteboard.general.string = client.connection.token
                } label: {
                    Label("Copy API Token", systemImage: "key")
                }
            }
        }
    }

    // MARK: - Helpers

    private var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0"
    }

    private var buildNumber: String {
        Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "1"
    }
}
