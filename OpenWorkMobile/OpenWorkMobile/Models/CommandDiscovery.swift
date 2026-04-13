import Foundation

/// GET /api/commands/discover → { commands: [...] }
/// NOTE: The response is { commands: [...] }, decoded via CommandsWrapper in OpenWorkAPIClient.

/// A slash command. Uses camelCase JSON keys (Rust `rename_all = "camelCase"`).
struct DiscoveredCommand: Codable, Identifiable, Sendable {
    let name: String
    let description: String
    let provider: String
    let scope: String
    let filePath: String

    var id: String { "\(provider)-\(scope)-\(name)" }
}

/// A skill. Uses camelCase JSON keys.
struct DiscoveredSkill: Codable, Identifiable, Sendable {
    let name: String
    let displayName: String
    let description: String
    let provider: String
    let scope: String

    var id: String { "\(provider)-\(scope)-\(name)" }
}
