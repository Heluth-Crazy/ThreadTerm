import SwiftUI
struct ErrorView: View {
    let message: String
    var body: some View {
        ContentUnavailableView {
            Label("Error", systemImage: "exclamationmark.triangle")
        } description: {
            Text(message)
        }
    }
}
