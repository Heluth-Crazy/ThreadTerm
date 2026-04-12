import SwiftUI

@main
struct OpenWorkMobileApp: App {
    @State private var connectionVM = ConnectionViewModel()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(connectionVM)
        }
    }
}
