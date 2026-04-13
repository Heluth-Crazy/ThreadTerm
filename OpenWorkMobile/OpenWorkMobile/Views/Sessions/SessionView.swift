import SwiftUI

struct SessionView: View {
    let session: Session
    let isActiveSession: Bool
    @Environment(ConnectionViewModel.self) private var connectionVM
    @State private var viewModel: SessionViewModel
    @State private var inputText = ""
    @State private var showCommandPicker = false
    @State private var commandSearchText = ""
    @State private var commands: [DiscoveredCommand] = []

    init(session: Session, isActiveSession: Bool = false) {
        self.session = session
        self.isActiveSession = isActiveSession
        self._viewModel = State(initialValue: SessionViewModel(session: session))
    }

    var body: some View {
        VStack(spacing: 0) {
            // Error banner
            if let error = viewModel.errorMessage {
                HStack {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red)
                    Text(error).font(.caption).foregroundStyle(.red)
                    Spacer()
                    Button("Retry") {
                        Task {
                            guard let client = connectionVM.currentAPIClient else { return }
                            viewModel.errorMessage = nil
                            if isActiveSession {
                                await viewModel.attachToExisting(ptyId: session.id, using: client)
                            } else {
                                await viewModel.connect(using: client)
                            }
                        }
                    }
                    .font(.caption.bold())
                    Button("✕") { viewModel.errorMessage = nil }
                        .font(.caption)
                }
                .padding(.horizontal)
                .padding(.vertical, 6)
                .background(Color.red.opacity(0.1))
            }

            if !viewModel.isConnected && viewModel.errorMessage == nil {
                HStack(spacing: 8) {
                    ProgressView().scaleEffect(0.8)
                    Text("Connecting…").font(.caption).foregroundStyle(.secondary)
                }
                .padding(.vertical, 8)
            }

            messagesList
            Divider()
            inputBar
        }
        .navigationTitle(session.name ?? "Chat")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                ProviderBadge(provider: session.provider)
            }
        }
        .task {
            guard let client = connectionVM.currentAPIClient else { return }
            if isActiveSession, !session.id.isEmpty {
                await viewModel.attachToExisting(ptyId: session.id, using: client)
            } else {
                await viewModel.connect(using: client)
            }
        }
        .onDisappear { viewModel.disconnect() }
        .sheet(isPresented: $showCommandPicker) {
            CommandPickerView(
                commands: commands,
                onSelect: { cmd in
                    inputText += "/\(cmd.name) "
                    showCommandPicker = false
                },
                searchText: $commandSearchText
            )
            .presentationDetents([.medium, .large])
        }
    }

    // MARK: - Messages List

    private var messagesList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 12) {
                    ForEach(viewModel.messages) { msg in
                        ChatBubble(message: msg)
                            .id(msg.id)
                    }
                }
                .padding()
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: viewModel.messages.count) { _, _ in
                withAnimation {
                    if let last = viewModel.messages.last {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
            }
        }
    }

    // MARK: - Input Bar

    private var inputBar: some View {
        HStack(alignment: .bottom, spacing: 8) {
            Button {
                Task { await loadCommands() }
                showCommandPicker = true
            } label: {
                Image(systemName: "slash.circle")
                    .font(.title3)
                    .foregroundStyle(.secondary)
            }

            TextField("Message…", text: $inputText, axis: .vertical)
                .lineLimit(1...5)
                .textFieldStyle(.roundedBorder)

            if viewModel.isStreaming {
                Button {
                    Task { await viewModel.abort() }
                } label: {
                    Image(systemName: "stop.circle.fill")
                        .font(.title2)
                        .foregroundStyle(.red)
                }
            } else {
                Button { sendMessage() } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.title2)
                        .foregroundStyle(inputText.isEmpty ? .gray : .accentColor)
                }
                .disabled(inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !viewModel.isConnected)
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(.bar)
    }

    // MARK: - Helpers

    private func sendMessage() {
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        inputText = ""
        Task {
            await viewModel.sendMessage(text)
        }
    }

    private func loadCommands() async {
        guard let client = connectionVM.currentAPIClient else { return }
        commands = (try? await client.discoverCommands()) ?? []
    }
}

// MARK: - Chat Bubble

private struct ChatBubble: View {
    let message: SessionViewModel.ChatMessage

    var body: some View {
        HStack {
            if message.role == "user" { Spacer(minLength: 60) }

            VStack(alignment: message.role == "user" ? .trailing : .leading, spacing: 4) {
                Text(message.content.isEmpty && message.isStreaming ? "…" : message.content)
                    .padding(12)
                    .background(
                        message.role == "user"
                            ? Color.accentColor.opacity(0.15)
                            : Color(.systemGray6)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 16))
                    .contextMenu {
                        Button {
                            UIPasteboard.general.string = message.content
                        } label: {
                            Label("Copy", systemImage: "doc.on.doc")
                        }
                    }

                if message.isStreaming {
                    HStack(spacing: 4) {
                        ProgressView()
                            .scaleEffect(0.7)
                        Text("Streaming…")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            if message.role != "user" { Spacer(minLength: 60) }
        }
    }
}
