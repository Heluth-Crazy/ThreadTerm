import Foundation

struct StoredMachine: Codable, Equatable {
  let id: String
  var name: String
  var color: String
  let transport: String
  let endpoint: String
  let tlsFingerprint: String
  var permission: String
  var expiresAt: String

  func validate() throws {
    let compactFingerprint = tlsFingerprint
      .replacingOccurrences(of: ":", with: "")
      .replacingOccurrences(of: " ", with: "")
    guard UUID(uuidString: id) != nil,
          !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
          name.count <= 80,
          name.unicodeScalars.allSatisfy({ $0.properties.generalCategory != .control }),
          color.range(of: "^#[0-9A-Fa-f]{6}$", options: .regularExpression) != nil,
          transport == "iroh" || transport == "tls",
          !endpoint.isEmpty,
          compactFingerprint.range(of: "^[0-9A-Fa-f]{64}$", options: .regularExpression) != nil,
          permission == "readonly" || permission == "fullcontrol",
          Self.parseTimestamp(expiresAt) != nil else {
      throw SecureStoreError.invalidRegistry("invalid machine metadata")
    }
  }

  private static func parseTimestamp(_ value: String) -> Date? {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions.insert(.withFractionalSeconds)
    if let date = fractional.date(from: value) {
      return date
    }
    return ISO8601DateFormatter().date(from: value)
  }

  var dictionary: [String: Any] {
    [
      "id": id,
      "name": name,
      "color": color,
      "transport": transport,
      "endpoint": endpoint,
      "tlsFingerprint": tlsFingerprint,
      "permission": permission,
      "expiresAt": expiresAt
    ]
  }
}

final class MachineRegistry {
  static let registryAccount = "machine-registry-v1"
  static let irohSecretAccount = "iroh-secret-v1"
  private static let credentialPrefix = "machine-credential-v1:"

  private let keychain: KeychainStore
  private let encoder = JSONEncoder()
  private let decoder = JSONDecoder()
  private let lock = NSLock()
  private var machines: [StoredMachine]

  init(keychain: KeychainStore) throws {
    self.keychain = keychain
    encoder.outputFormatting = [.sortedKeys]
    guard let data = try keychain.data(for: Self.registryAccount) else {
      machines = []
      return
    }
    do {
      let decoded = try decoder.decode([StoredMachine].self, from: data)
      var ids = Set<String>()
      for machine in decoded {
        try machine.validate()
        guard ids.insert(machine.id).inserted else {
          throw SecureStoreError.invalidRegistry("duplicate machine identity")
        }
      }
      machines = decoded
    } catch {
      // Preserve the bytes for diagnosis but let the app recover and pair again.
      let quarantine = "machine-registry-invalid-\(Int(Date().timeIntervalSince1970))"
      try? keychain.set(data, for: quarantine)
      try keychain.delete(Self.registryAccount)
      machines = []
    }
  }

  func list() -> [StoredMachine] {
    lock.withLock { machines }
  }

  func machine(id: String) -> StoredMachine? {
    lock.withLock { machines.first(where: { $0.id == id }) }
  }

  func credential(id: String) throws -> String {
    guard machine(id: id) != nil,
          let credential = try keychain.string(for: Self.credentialPrefix + id) else {
      throw SecureStoreError.invalidRegistry("machine credential is unavailable")
    }
    return credential
  }

  func add(_ machine: StoredMachine, credential: String) throws {
    try machine.validate()
    guard credential.count >= 32 && credential.count <= 128,
          credential.unicodeScalars.allSatisfy({ $0.properties.generalCategory != .control }) else {
      throw SecureStoreError.invalidRegistry("invalid machine credential")
    }
    try lock.withLock {
      guard !machines.contains(where: { $0.id == machine.id }) else {
        throw SecureStoreError.invalidRegistry("machine already exists")
      }
      try keychain.set(credential, for: Self.credentialPrefix + machine.id)
      do {
        let next = machines + [machine]
        try save(next)
        machines = next
      } catch {
        try? keychain.delete(Self.credentialPrefix + machine.id)
        throw error
      }
    }
  }

  func updateSnapshot(id: String, resultJson: String) throws {
    guard let snapshot = try JSONSerialization.jsonObject(with: Data(resultJson.utf8)) as? [String: Any],
          let permission = snapshot["permission"] as? String else {
      throw SecureStoreError.invalidRegistry("invalid snapshot permission")
    }
    try updateConnection(id: id, permission: permission)
  }

  func updateConnection(id: String, permission: String) throws {
    guard permission == "readonly" || permission == "fullcontrol" else {
      throw SecureStoreError.invalidRegistry("invalid machine permission")
    }
    try lock.withLock {
      guard let index = machines.firstIndex(where: { $0.id == id }) else {
        throw SecureStoreError.invalidRegistry("machine is unavailable")
      }
      var next = machines
      if next[index].permission == permission { return }
      next[index].permission = permission
      try save(next)
      machines = next
    }
  }

  func rename(id: String, name: String, color: String) throws {
    try lock.withLock {
      guard let index = machines.firstIndex(where: { $0.id == id }) else {
        throw SecureStoreError.invalidRegistry("machine is unavailable")
      }
      var next = machines
      next[index].name = name.trimmingCharacters(in: .whitespacesAndNewlines)
      next[index].color = color
      try next[index].validate()
      try save(next)
      machines = next
    }
  }

  func remove(id: String) throws {
    try lock.withLock {
      guard let existing = machines.first(where: { $0.id == id }) else {
        return
      }
      let credential = try keychain.string(for: Self.credentialPrefix + id)
      try keychain.delete(Self.credentialPrefix + id)
      do {
        let next = machines.filter { $0.id != id }
        try save(next)
        machines = next
      } catch {
        if let credential {
          try? keychain.set(credential, for: Self.credentialPrefix + existing.id)
        }
        throw error
      }
    }
  }

  private func save(_ value: [StoredMachine]) throws {
    if value.isEmpty {
      try keychain.delete(Self.registryAccount)
    } else {
      try keychain.set(try encoder.encode(value), for: Self.registryAccount)
    }
  }
}

private extension NSLock {
  func withLock<T>(_ body: () throws -> T) rethrows -> T {
    lock()
    defer { unlock() }
    return try body()
  }
}
