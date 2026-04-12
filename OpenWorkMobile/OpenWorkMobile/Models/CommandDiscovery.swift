import Foundation
struct CommandDiscoveryResponse: Codable {
    let ok: Bool
}
struct CommandDiscoveryResult: Codable {
    let commands: [DiscoveredCommand]
    let skills: [DiscoveredSkill]
}
struct DiscoveredCommand: Codable, Identifiable {
    let name: String
    var id: String { name }
}
struct DiscoveredSkill: Codable, Identifiable {
    let name: String
    var id: String { name }
}
