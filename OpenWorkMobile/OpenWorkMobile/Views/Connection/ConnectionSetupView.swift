import SwiftUI

struct ConnectionSetupView: View {
    @Environment(ConnectionViewModel.self) private var connectionVM
    @State private var host = ""
    @State private var port = "3002"
    @State private var token = ""
    @State private var connectionName = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Server") {
                    TextField("192.168.1.x", text: $host)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)

                    TextField("Port", text: $port)
                        .keyboardType(.numberPad)

                    SecureField("Paste token from desktop app", text: $token)
                        .textContentType(.password)

                    TextField("My Mac (optional)", text: $connectionName)
                }

                Section {
                    connectButton
                }

                if !connectionVM.savedConnections.isEmpty {
                    Section("Saved Connections") {
                        ForEach(connectionVM.savedConnections) { conn in
                            savedConnectionRow(conn)
                        }
                        .onDelete(perform: deleteSavedConnections)
                    }
                }
            }
            .navigationTitle("Connect to OpenWork")
            .overlay { stateOverlay }
        }
        .onTapGesture { hideKeyboard() }
    }

    // MARK: - Subviews

    @ViewBuilder
    private var connectButton: some View {
        if case .connecting = connectionVM.state {
            HStack {
                Spacer()
                ProgressView("Connecting…")
                Spacer()
            }
        } else {
            Button {
                let conn = ServerConnection(
                    name: connectionName.isEmpty ? host : connectionName,
                    host: host,
                    port: Int(port) ?? 3002,
                    token: token
                )
                Task { await connectionVM.connect(to: conn) }
            } label: {
                HStack {
                    Spacer()
                    Label("Connect", systemImage: "link")
                        .bold()
                    Spacer()
                }
            }
            .disabled(host.isEmpty || token.isEmpty)
        }
    }

    @ViewBuilder
    private var stateOverlay: some View {
        if case .failed(let message) = connectionVM.state {
            VStack {
                HStack {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.yellow)
                    Text(message)
                        .font(.subheadline)
                    Spacer()
                    Button { connectionVM.disconnect() } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.secondary)
                    }
                }
                .padding()
                .background(.red.opacity(0.15), in: RoundedRectangle(cornerRadius: 10))
                .padding()
                Spacer()
            }
        }
    }

    private func savedConnectionRow(_ conn: ServerConnection) -> some View {
        Button {
            host = conn.host
            port = String(conn.port)
            token = conn.token
            connectionName = conn.name
            Task { await connectionVM.connect(to: conn) }
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                Text(conn.name.isEmpty ? conn.host : conn.name)
                    .font(.headline)
                Text("\(conn.host):\(conn.port)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func deleteSavedConnections(at offsets: IndexSet) {
        for index in offsets {
            connectionVM.deleteConnection(connectionVM.savedConnections[index])
        }
    }
}

// MARK: - Keyboard Dismissal

extension View {
    func hideKeyboard() {
        UIApplication.shared.sendAction(
            #selector(UIResponder.resignFirstResponder),
            to: nil, from: nil, for: nil
        )
    }
}
