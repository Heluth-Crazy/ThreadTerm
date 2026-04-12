import Foundation
import Security

final class TokenStorage {
    static func saveConnections(_ connections: [ServerConnection]) {}
    static func loadConnections() -> [ServerConnection] { [] }
    static func deleteAll() {}
}
