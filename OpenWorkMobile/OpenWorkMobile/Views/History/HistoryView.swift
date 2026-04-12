import SwiftUI

struct HistoryView: View {
    let session: Session
    @Environment(ConnectionViewModel.self) private var connectionVM
    @State private var viewModel = HistoryViewModel()

    var body: some View {
        Group {
            if viewModel.isLoading && viewModel.messages.isEmpty {
                LoadingView(message: "Loading history…")
            } else if let error = viewModel.error, viewModel.messages.isEmpty {
                ErrorView(message: error)
            } else if viewModel.messages.isEmpty {
                ContentUnavailableView {
                    Label("No Messages", systemImage: "bubble.left")
                } description: {
                    Text("This session has no messages yet.")
                }
            } else {
                messageList
            }
        }
        .navigationTitle(session.name ?? "Session History")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                ProviderBadge(provider: session.provider)
            }
        }
        .task { await loadHistory() }
    }

    private var messageList: some View {
        ScrollView {
            LazyVStack(spacing: 12) {
                ForEach(viewModel.messages) { message in
                    HistoryMessageBubble(message: message)
                }
            }
            .padding()
        }
    }

    private func loadHistory() async {
        guard let client = connectionVM.currentAPIClient else { return }
        await viewModel.fetchHistory(session: session, using: client)
    }
}
