import SwiftUI

struct PTYOutputView: View {
    let session: Session
    @Environment(ConnectionViewModel.self) private var connectionVM
    @State private var viewModel = TerminalViewModel()
    @State private var inputText = ""
    @State private var fontSize: CGFloat = 12

    var body: some View {
        VStack(spacing: 0) {
            terminalOutput
            Divider()
            terminalInput
        }
        .background(Color(red: 0.12, green: 0.12, blue: 0.12))
        .navigationTitle("Terminal")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                connectionDot
            }
            ToolbarItem(placement: .navigationBarTrailing) {
                Button {
                    viewModel.disconnect()
                } label: {
                    Image(systemName: "xmark.circle")
                }
                .disabled(!viewModel.isConnected)
            }
        }
        .task { await connectTerminal() }
        .onDisappear { viewModel.disconnect() }
        .gesture(
            MagnifyGesture()
                .onChanged { value in
                    let newSize = fontSize * value.magnification
                    fontSize = min(max(newSize, 8), 24)
                }
        )
    }

    // MARK: - Terminal Output

    private var terminalOutput: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 1) {
                    ForEach(viewModel.outputLines) { line in
                        Text(line.text)
                            .font(.system(size: fontSize, design: .monospaced))
                            .foregroundStyle(
                                line.isError ? .red :
                                line.isHistory ? .secondary : .primary
                            )
                            .textSelection(.enabled)
                            .id(line.id)
                    }
                }
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .onChange(of: viewModel.outputLines.count) { _, _ in
                withAnimation {
                    if let last = viewModel.outputLines.last {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
            }
            .overlay(alignment: .top) {
                if let error = viewModel.connectionError {
                    Text(error)
                        .font(.caption.bold())
                        .foregroundStyle(.white)
                        .padding(8)
                        .background(.red.opacity(0.8), in: RoundedRectangle(cornerRadius: 8))
                        .padding()
                }
            }
            .overlay(alignment: .bottom) {
                if let code = viewModel.exitCode {
                    Text("Process exited with code \(code)")
                        .font(.caption.bold())
                        .foregroundStyle(.white)
                        .padding(8)
                        .background(.red.opacity(0.8), in: RoundedRectangle(cornerRadius: 8))
                        .padding()
                }
            }
        }
    }

    // MARK: - Terminal Input

    private var terminalInput: some View {
        HStack(spacing: 8) {
            TextField("$", text: $inputText)
                .font(.system(.body, design: .monospaced))
                .textFieldStyle(.roundedBorder)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .onSubmit { sendInput() }

            Button { sendInput() } label: {
                Image(systemName: "return")
                    .foregroundStyle(inputText.isEmpty ? .gray : .accentColor)
            }
            .disabled(inputText.isEmpty)
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(.bar)
    }

    private var connectionDot: some View {
        Circle()
            .fill(viewModel.isConnected ? .green : .red)
            .frame(width: 10, height: 10)
    }

    // MARK: - Actions

    private func connectTerminal() async {
        guard let connection = connectionVM.currentAPIClient?.connection else { return }
        await viewModel.connect(sessionId: session.id, using: connection)
    }

    private func sendInput() {
        let text = inputText
        guard !text.isEmpty else { return }
        inputText = ""
        Task {
            do {
                try await viewModel.sendInput(text + "\n")
            } catch {
                viewModel.appendError("Input error: \(error.localizedDescription)")
            }
        }
    }
}
