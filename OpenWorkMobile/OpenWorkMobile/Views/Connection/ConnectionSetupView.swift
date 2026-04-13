import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

struct ConnectionSetupView: View {
    @Environment(ConnectionViewModel.self) private var connectionVM
    @Environment(\.dismiss) private var dismiss
    @State private var host = ""
    @State private var port = "3002"
    @State private var token = ""
    @State private var connectionName = ""
    @State private var showToken = false
    @State private var showSuccessCheck = false

    var body: some View {
        NavigationStack {
            Form {
                // Error banner
                if case .failed(let message) = connectionVM.state {
                    Section {
                        VStack(alignment: .leading, spacing: 8) {
                            HStack(spacing: 8) {
                                Image(systemName: "exclamationmark.triangle.fill")
                                    .foregroundStyle(.red)
                                Text(message)
                                    .font(.subheadline)
                                    .foregroundStyle(.red)
                            }
                            Button {
                                let conn = ServerConnection(
                                    name: connectionName.isEmpty ? host : connectionName,
                                    host: host,
                                    port: Int(port) ?? 3002,
                                    token: token
                                )
                                Task { await connectionVM.connect(to: conn) }
                            } label: {
                                Label("Retry", systemImage: "arrow.clockwise")
                                    .font(.subheadline.bold())
                            }
                        }
                    }
                    .listRowBackground(Color.red.opacity(0.1))
                }

                Section("Server") {
                    TextField("192.168.1.x", text: $host)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)

                    TextField("Port", text: $port)
                        .keyboardType(.numberPad)

                    // Token field with show/hide + paste
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Group {
                                if showToken {
                                    TextField("API Token", text: $token)
                                        .font(.system(.caption, design: .monospaced))
                                } else {
                                    SecureField("API Token", text: $token)
                                }
                            }
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()

                            Button {
                                showToken.toggle()
                            } label: {
                                Image(systemName: showToken ? "eye.slash" : "eye")
                                    .foregroundStyle(.secondary)
                            }
                            .buttonStyle(.borderless)

                            Button {
                                #if canImport(UIKit)
                                if let str = UIPasteboard.general.string {
                                    token = str.trimmingCharacters(in: .whitespacesAndNewlines)
                                }
                                #endif
                            } label: {
                                Image(systemName: "doc.on.clipboard")
                                    .foregroundStyle(.secondary)
                            }
                            .buttonStyle(.borderless)

                            Button {} label: {
                                Image(systemName: "qrcode.viewfinder")
                                    .foregroundStyle(.secondary)
                            }
                            .buttonStyle(.borderless)
                            .disabled(true)
                        }
                    }

                    TextField("My Mac (optional)", text: $connectionName)
                }

                Section {
                    connectButton
                }

                // Connection log (mini terminal)
                if !connectionVM.connectionLog.isEmpty {
                    Section("Log") {
                        ScrollViewReader { proxy in
                            ScrollView {
                                LazyVStack(alignment: .leading, spacing: 2) {
                                    ForEach(Array(connectionVM.connectionLog.enumerated()), id: \.offset) { idx, line in
                                        Text(line)
                                            .font(.system(.caption2, design: .monospaced))
                                            .foregroundStyle(logColor(for: line))
                                            .id(idx)
                                    }
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(8)
                            }
                            .frame(height: 200)
                            .background(Color(white: 0.1))
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                            .onChange(of: connectionVM.connectionLog.count) { _, _ in
                                withAnimation {
                                    proxy.scrollTo(connectionVM.connectionLog.count - 1, anchor: .bottom)
                                }
                            }
                        }
                        .listRowInsets(EdgeInsets(top: 4, leading: 4, bottom: 4, trailing: 4))
                    }
                }

                // Hint
                Section {
                    Label {
                        Text("Find your Mac's IP in **System Settings → Network**, or run `ifconfig` in Terminal. Token is in `~/.openwork/api-token.txt`.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } icon: {
                        Image(systemName: "info.circle")
                            .foregroundStyle(.secondary)
                    }
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
            .overlay {
                if showSuccessCheck {
                    successOverlay
                }
            }
            .onChange(of: connectionVM.didJustConnect) { _, newValue in
                if newValue {
                    showSuccessCheck = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                        showSuccessCheck = false
                        dismiss()
                    }
                }
            }
        }
        .onTapGesture { hideKeyboard() }
    }

    // MARK: - Subviews

    @ViewBuilder
    private var connectButton: some View {
        if case .connecting = connectionVM.state {
            HStack {
                Spacer()
                ProgressView("Connecting to \(host):\(port)…")
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

    private var successOverlay: some View {
        VStack(spacing: 12) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 56))
                .foregroundStyle(.green)
                .symbolEffect(.bounce, value: showSuccessCheck)
            Text("Connected!")
                .font(.title3.bold())
                .foregroundStyle(.primary)
        }
        .padding(32)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
        .transition(.scale.combined(with: .opacity))
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

    private func logColor(for line: String) -> Color {
        if line.contains("✓") { return .green }
        if line.contains("✗") { return .red }
        return .white
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
