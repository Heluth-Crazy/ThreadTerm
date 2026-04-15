import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

struct ConnectionSetupView: View {
    @Environment(ConnectionViewModel.self) private var connectionVM
    @Environment(\.dismiss) private var dismiss
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
                                Task { await connectionVM.connect(to: connectionVM.draftConnection()) }
                            } label: {
                                Label("Retry", systemImage: "arrow.clockwise")
                                    .font(.subheadline.bold())
                            }
                        }
                    }
                    .listRowBackground(Color.red.opacity(0.1))
                }

                Section("Server") {
                    TextField("192.168.1.x", text: hostBinding)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)

                    TextField("Port", text: portBinding)
                        .keyboardType(.numberPad)

                    // Token field with show/hide + paste
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            TokenTextField(
                                text: tokenBinding,
                                isSecure: !showToken,
                                placeholder: "API Token"
                            )
                            .frame(maxWidth: .infinity)
                            .frame(minHeight: 22)

                            Button {
                                showToken.toggle()
                            } label: {
                                Image(systemName: showToken ? "eye.slash" : "eye")
                                    .foregroundStyle(.secondary)
                            }
                            .buttonStyle(.borderless)

                            Button {
                                #if canImport(UIKit)
                                let str = UIPasteboard.general.string ?? ""
                                let cleaned = str.trimmingCharacters(in: .whitespacesAndNewlines)
                                if !cleaned.isEmpty {
                                    connectionVM.draft.token = cleaned
                                    showToken = true   // show what was pasted
                                }
                                #endif
                            } label: {
                                Label("粘贴", systemImage: "doc.on.clipboard")
                                    .font(.caption)
                                    .foregroundStyle(Color.accentColor)
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.mini)

                            Button {} label: {
                                Image(systemName: "qrcode.viewfinder")
                                    .foregroundStyle(.secondary)
                            }
                            .buttonStyle(.borderless)
                            .disabled(true)
                        }
                    }

                    TextField("My Mac (optional)", text: connectionNameBinding)
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
                        Text("Find your Mac's IP in **System Settings → Network**, or run `ifconfig` in Terminal. Token is in `~/.openwork/api-token.txt`. On a real iPhone, do not use `localhost`.")
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
            .scrollDismissesKeyboard(.interactively)
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
    }

    // MARK: - Subviews

    @ViewBuilder
    private var connectButton: some View {
        if case .connecting = connectionVM.state {
            HStack {
                Spacer()
                ProgressView("Connecting to \(connectionVM.draft.host):\(connectionVM.draft.port)…")
                Spacer()
            }
        } else {
            Button {
                Task { await connectionVM.connect(to: connectionVM.draftConnection()) }
            } label: {
                HStack {
                    Spacer()
                    Label("Connect", systemImage: "link")
                        .bold()
                    Spacer()
                }
            }
            .disabled(connectionVM.draft.host.isEmpty || connectionVM.draft.token.isEmpty)
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
            let resolved = connectionVM.selectSavedConnection(conn)

            guard !resolved.token.isEmpty else { return }
            Task { await connectionVM.connect(to: resolved) }
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

    private var hostBinding: Binding<String> {
        Binding(
            get: { connectionVM.draft.host },
            set: { connectionVM.draft.host = $0 }
        )
    }

    private var portBinding: Binding<String> {
        Binding(
            get: { connectionVM.draft.port },
            set: { connectionVM.draft.port = $0 }
        )
    }

    private var tokenBinding: Binding<String> {
        Binding(
            get: { connectionVM.draft.token },
            set: { connectionVM.draft.token = $0 }
        )
    }

    private var connectionNameBinding: Binding<String> {
        Binding(
            get: { connectionVM.draft.name },
            set: { connectionVM.draft.name = $0 }
        )
    }
}

#if canImport(UIKit)
private struct TokenTextField: UIViewRepresentable {
    @Binding var text: String
    let isSecure: Bool
    let placeholder: String

    func makeCoordinator() -> Coordinator {
        Coordinator(text: $text)
    }

    func makeUIView(context: Context) -> UITextField {
        let textField = UITextField(frame: .zero)
        textField.delegate = context.coordinator
        textField.placeholder = placeholder
        textField.font = UIFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        textField.autocorrectionType = .no
        textField.autocapitalizationType = .none
        textField.smartDashesType = .no
        textField.smartQuotesType = .no
        textField.spellCheckingType = .no
        textField.keyboardType = .asciiCapable
        // API tokens are not account passwords; using one-time-code semantics
        // suppresses iOS password autofill/save prompts that block the flow.
        textField.textContentType = .oneTimeCode
        textField.passwordRules = nil
        textField.clearButtonMode = .whileEditing
        textField.borderStyle = .none
        textField.isSecureTextEntry = isSecure
        textField.addTarget(
            context.coordinator,
            action: #selector(Coordinator.textChanged(_:)),
            for: .editingChanged
        )
        return textField
    }

    func updateUIView(_ textField: UITextField, context: Context) {
        if textField.text != text {
            textField.text = text
        }

        if textField.isSecureTextEntry != isSecure {
            let wasFirstResponder = textField.isFirstResponder
            let currentText = textField.text
            textField.isSecureTextEntry = isSecure

            // Re-assign text after toggling secure entry so iOS keeps the current value
            // and the edit menu remains available.
            textField.text = currentText

            if wasFirstResponder {
                textField.becomeFirstResponder()
            }
        }
    }

    final class Coordinator: NSObject, UITextFieldDelegate {
        private var text: Binding<String>

        init(text: Binding<String>) {
            self.text = text
        }

        @objc func textChanged(_ sender: UITextField) {
            text.wrappedValue = sender.text ?? ""
        }
    }
}
#endif

// MARK: - Keyboard Dismissal

extension View {
    func hideKeyboard() {
        UIApplication.shared.sendAction(
            #selector(UIResponder.resignFirstResponder),
            to: nil, from: nil, for: nil
        )
    }
}
