import Foundation
import Security

enum SecureStoreError: Error, CustomStringConvertible {
  case keychain(OSStatus)
  case invalidRegistry(String)

  var description: String {
    switch self {
    case .keychain(let status):
      return "keychain_error: \(SecCopyErrorMessageString(status, nil) as String? ?? String(status))"
    case .invalidRegistry(let message):
      return "invalid_registry: \(message)"
    }
  }
}

final class KeychainStore {
  private let service: String

  init(service: String = "com.threadterm.mobile.companion") {
    self.service = service
  }

  func data(for account: String) throws -> Data? {
    var result: CFTypeRef?
    let status = SecItemCopyMatching([
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecAttrSynchronizable as String: kCFBooleanFalse as Any,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne
    ] as CFDictionary, &result)
    if status == errSecItemNotFound {
      return nil
    }
    guard status == errSecSuccess, let data = result as? Data else {
      throw SecureStoreError.keychain(status)
    }
    return data
  }

  func string(for account: String) throws -> String? {
    guard let data = try data(for: account) else {
      return nil
    }
    guard let value = String(data: data, encoding: .utf8) else {
      throw SecureStoreError.invalidRegistry("secure value is not UTF-8")
    }
    return value
  }

  func set(_ data: Data, for account: String) throws {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecAttrSynchronizable as String: kCFBooleanFalse as Any
    ]
    let update = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if update == errSecSuccess {
      return
    }
    guard update == errSecItemNotFound else {
      throw SecureStoreError.keychain(update)
    }
    var item = query
    item[kSecValueData as String] = data
    item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    let add = SecItemAdd(item as CFDictionary, nil)
    guard add == errSecSuccess else {
      throw SecureStoreError.keychain(add)
    }
  }

  func set(_ value: String, for account: String) throws {
    guard let data = value.data(using: .utf8) else {
      throw SecureStoreError.invalidRegistry("secure value is not UTF-8")
    }
    try set(data, for: account)
  }

  func delete(_ account: String) throws {
    let status = SecItemDelete([
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecAttrSynchronizable as String: kCFBooleanFalse as Any
    ] as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw SecureStoreError.keychain(status)
    }
  }
}
