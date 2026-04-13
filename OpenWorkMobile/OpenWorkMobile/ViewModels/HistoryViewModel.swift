import Foundation

@Observable
class HistoryViewModel {
    private(set) var messages: [SessionMessage] = []
    private(set) var isLoading = false
    private(set) var error: String?

    func fetchHistory(session: Session, using client: OpenWorkAPIClient) async {
        await MainActor.run {
            isLoading = true
            error = nil
        }
        do {
            let result = try await client.fetchSessionMessages(
                sessionId: session.id,
                projectPath: session.projectPath,
                provider: session.provider
            )
            await MainActor.run {
                messages = result
                isLoading = false
            }
        } catch {
            await MainActor.run {
                self.error = error.localizedDescription
                isLoading = false
            }
        }
    }

    /// Extract display text from AnyCodableValue content.
    func displayText(for message: SessionMessage) -> String {
        message.textContent
    }
}
