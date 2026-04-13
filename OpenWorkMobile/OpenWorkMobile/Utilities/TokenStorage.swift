import Foundation
import Security

// MARK: - TokenStorage (Keychain)

/// Keychain-based storage for API tokens, keyed by host:port.
struct TokenStorage {
    static let service = "com.openwork.ios"

    @discardableResult
    static func save(token: String, for host: String, port: Int) -> Bool {
        guard let data = token.data(using: .utf8) else { return false }
        let key = "\(host):\(port)"

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        // Delete existing before adding
        SecItemDelete(query as CFDictionary)

        var add = query
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock

        let status = SecItemAdd(add as CFDictionary, nil)
        return status == errSecSuccess
    }

    static func load(for host: String, port: Int) -> String? {
        let key = "\(host):\(port)"
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    @discardableResult
    static func delete(for host: String, port: Int) -> Bool {
        let key = "\(host):\(port)"
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        let status = SecItemDelete(query as CFDictionary)
        return status == errSecSuccess
    }
}

// MARK: - ConnectionStorage (UserDefaults)

/// Saves and loads [ServerConnection] to UserDefaults as JSON.
struct ConnectionStorage {
    private static let key = "saved_connections"

    static func saveConnections(_ connections: [ServerConnection]) {
        guard let data = try? JSONEncoder().encode(connections) else { return }
        UserDefaults.standard.set(data, forKey: key)
    }

    static func loadConnections() -> [ServerConnection] {
        guard let data = UserDefaults.standard.data(forKey: key),
              let connections = try? JSONDecoder().decode([ServerConnection].self, from: data) else {
            return []
        }
        return connections
    }
}
