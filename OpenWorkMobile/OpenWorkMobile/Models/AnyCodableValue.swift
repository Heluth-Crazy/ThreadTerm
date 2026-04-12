import Foundation

/// Type-erasing Codable wrapper for arbitrary JSON values.
/// Used for SessionMessage.content and Project.config which are serde_json::Value in Rust.
enum AnyCodableValue: Codable, Hashable, Sendable {
    case null
    case bool(Bool)
    case int(Int)
    case double(Double)
    case string(String)
    case array([AnyCodableValue])
    case object([String: AnyCodableValue])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let b = try? container.decode(Bool.self) {
            self = .bool(b)
        } else if let i = try? container.decode(Int.self) {
            self = .int(i)
        } else if let d = try? container.decode(Double.self) {
            self = .double(d)
        } else if let s = try? container.decode(String.self) {
            self = .string(s)
        } else if let arr = try? container.decode([AnyCodableValue].self) {
            self = .array(arr)
        } else if let obj = try? container.decode([String: AnyCodableValue].self) {
            self = .object(obj)
        } else {
            throw DecodingError.typeMismatch(
                AnyCodableValue.self,
                DecodingError.Context(
                    codingPath: decoder.codingPath,
                    debugDescription: "Unsupported JSON value"
                )
            )
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null:         try container.encodeNil()
        case .bool(let b):  try container.encode(b)
        case .int(let i):   try container.encode(i)
        case .double(let d): try container.encode(d)
        case .string(let s): try container.encode(s)
        case .array(let a):  try container.encode(a)
        case .object(let o): try container.encode(o)
        }
    }

    /// Extract the first human-readable text from a JSON content value.
    /// Handles Claude content blocks `[{"type":"text","text":"..."}]` and plain strings.
    var textContent: String? {
        switch self {
        case .string(let s):
            return s.isEmpty ? nil : s
        case .array(let arr):
            for item in arr {
                if case .object(let d) = item,
                   case .string(let text) = d["text"] {
                    return text
                }
            }
            return arr.compactMap(\.textContent).first
        case .object(let d):
            if case .string(let text) = d["text"] { return text }
            if case .string(let msg) = d["message"] { return msg }
            return nil
        default:
            return nil
        }
    }

    var description: String {
        switch self {
        case .null:         return ""
        case .bool(let b):  return String(b)
        case .int(let i):   return String(i)
        case .double(let d): return String(d)
        case .string(let s): return s
        case .array(let a):  return a.map(\.description).joined(separator: " ")
        case .object(let o): return o.values.map(\.description).joined(separator: " ")
        }
    }
}
