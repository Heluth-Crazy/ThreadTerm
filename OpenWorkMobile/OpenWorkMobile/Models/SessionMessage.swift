import Foundation

/// A message from `GET /api/session-history/{id}/messages`.
/// The `content` field is a raw JSON value (varies by provider).
struct SessionMessage: Codable, Identifiable, Sendable {
    let uuid: String
    let role: String
    let content: AnyCodableValue
    let timestamp: String?
    let isSidechain: Bool?

    var id: String { uuid }

    enum CodingKeys: String, CodingKey {
        case uuid, role, content, timestamp
        case isSidechain = "is_sidechain"
    }

    /// Extract human-readable text from the JSON content.
    /// Handles multiple provider formats: plain string, Claude content blocks, Codex messages.
    var textContent: String {
        switch content {
        case .string(let s):
            return s
        case .object(let dict):
            if case .string(let text) = dict["text"] {
                return text
            }
            if case .string(let msg) = dict["message"] {
                return msg
            }
            return String(describing: dict)
        case .array(let blocks):
            return blocks.compactMap { block in
                if case .object(let obj) = block,
                   case .string(let text) = obj["text"] {
                    return text
                }
                return nil
            }.joined(separator: "\n")
        default:
            return String(describing: content)
        }
    }
}
