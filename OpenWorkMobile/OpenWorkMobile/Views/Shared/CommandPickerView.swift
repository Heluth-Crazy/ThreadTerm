import SwiftUI

struct CommandPickerView: View {
    let commands: [DiscoveredCommand]
    let onSelect: (DiscoveredCommand) -> Void
    @Binding var searchText: String

    var filtered: [DiscoveredCommand] {
        if searchText.isEmpty { return commands }
        return commands.filter { $0.name.localizedCaseInsensitiveContains(searchText) }
    }

    var body: some View {
        NavigationStack {
            Group {
                if commands.isEmpty {
                    ContentUnavailableView {
                        Label("No Commands", systemImage: "terminal")
                    } description: {
                        Text("No commands discovered from the server.")
                    }
                } else if filtered.isEmpty {
                    ContentUnavailableView.search(text: searchText)
                } else {
                    List(filtered) { cmd in
                        Button { onSelect(cmd) } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                HStack {
                                    Text(cmd.name).bold()
                                    Spacer()
                                    Text(cmd.provider)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Text(cmd.description)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(2)
                            }
                        }
                    }
                }
            }
            .searchable(text: $searchText, prompt: "Search commands")
            .navigationTitle("Commands")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}
