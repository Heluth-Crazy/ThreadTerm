import SwiftUI

struct HistoryMessageBubble: View {
    let message: SessionMessage

    var body: some View {
        HStack(alignment: .top) {
            if message.role == "user" { Spacer(minLength: 60) }

            HStack(alignment: .top, spacing: 8) {
                if message.role != "user" {
                    Image(systemName: "brain.head.profile")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.top, 4)
                }

                VStack(alignment: message.role == "user" ? .trailing : .leading, spacing: 4) {
                    Text(message.textContent)
                        .padding(12)
                        .background(
                            message.role == "user"
                                ? Color.accentColor.opacity(0.15)
                                : Color(.systemGray6)
                        )
                        .clipShape(RoundedRectangle(cornerRadius: 16))
                        .contextMenu {
                            Button {
                                UIPasteboard.general.string = message.textContent
                            } label: {
                                Label("Copy", systemImage: "doc.on.doc")
                            }
                        }

                    if let ts = message.timestamp {
                        Text(ts.prefix(16).replacingOccurrences(of: "T", with: " "))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }

                if message.role == "user" {
                    Image(systemName: "person.fill")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.top, 4)
                }
            }

            if message.role != "user" { Spacer(minLength: 60) }
        }
    }
}
