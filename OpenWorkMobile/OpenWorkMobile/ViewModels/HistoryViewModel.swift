import Foundation

@Observable @MainActor
final class HistoryViewModel {
    var messages: [SessionMessage] = []
}
