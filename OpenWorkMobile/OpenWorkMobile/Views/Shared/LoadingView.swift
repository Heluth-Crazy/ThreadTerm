import SwiftUI
struct LoadingView: View {
    var message: String = "Loading..."
    var body: some View {
        ProgressView(message)
    }
}
