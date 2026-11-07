import ExpoModulesCore
import Foundation
import LocalAuthentication
import UIKit

private let readMethods: Set<String> = [
  "runtime.health", "project.catalog.list", "worktree.list", "worktree.branches",
  "session.lookup", "chat.snapshot", "chat.read", "chat.subagent.read", "chat.options",
  "chat.connection", "terminal.read", "filesystem.list", "filesystem.read",
  "filesystem.files", "filesystem.search", "filesystem.image", "git.status", "git.diff",
  "git.log", "git.commit.show", "git.commit.diff", "git.branches", "inbox.read",
  "session.attention.acknowledge", "chat.image.read", "attachment.read", "mobile.snapshot",
  "mobile.events.subscribe"
]

private let controlMethods: Set<String> = [
  "mobile.session.create", "session.stop", "session.resume", "session.claim", "session.renew",
  "session.release", "chat.connect", "chat.send", "chat.cancel", "chat.approve", "chat.answer",
  "terminal.input", "terminal.resize", "attachment.upload"
]

private final class NativeEnvironment {
  let registry: MachineRegistry
  let core: NativeClient
  let listener: NativeEvents

  init(registry: MachineRegistry, core: NativeClient, listener: NativeEvents) {
    self.registry = registry
    self.core = core
    self.listener = listener
  }
}

private final class NativeEvents: ClientEventListener, @unchecked Sendable {
  weak var owner: ThreadTermMobileModule?

  init(owner: ThreadTermMobileModule) {
    self.owner = owner
  }

  func runtimeEvent(machineId: String, eventJson: String) {
    owner?.emitRuntime(machineId: machineId, eventJson: eventJson)
  }

  func connectionState(machineId: String, state: String, message: String?) {
    owner?.emitConnection(machineId: machineId, state: state, message: message)
  }
}

public final class ThreadTermMobileModule: Module {
  private let keychain = KeychainStore()
  private let environmentLock = NSLock()
  private let controlLock = NSLock()
  private let nativeQueue = DispatchQueue(
    label: "com.threadterm.mobile.native",
    qos: .userInitiated,
    attributes: .concurrent
  )
  private let attachmentPicker = AttachmentPicker()
  @MainActor private var storedPreviewManager: PreviewManager?
  private var storedEnvironment: NativeEnvironment?
  private var controlUnlocked = false
  private var controlGeneration: UInt64 = 0

  public func definition() -> ModuleDefinition {
    Name("ThreadTermMobile")
    Events("onRuntimeEvent", "onConnectionState", "onControlLock")

    AsyncFunction("listMachines") { (promise: Promise) in
      self.perform(promise) {
        try self.environment().registry.list().map(\.dictionary)
      }
    }.runOnQueue(nativeQueue)

    AsyncFunction("preparePairing") { (text: String, promise: Promise) in
      self.perform(promise) {
        let prepared = try self.environment().core.preparePairing(text: text)
        return [
          "pendingId": prepared.pendingId,
          "checkCode": prepared.checkCode,
          "endpoint": prepared.endpoint,
          "transport": prepared.transport
        ]
      }
    }.runOnQueue(nativeQueue)

    AsyncFunction("confirmPairing") {
      (pendingId: String, deviceName: String, name: String, color: String, promise: Promise) in
      self.perform(promise) {
        let environment = try self.environment()
        let completed = try environment.core.confirmPairing(pendingId: pendingId, deviceName: deviceName)
        let machine = StoredMachine(
          id: completed.machineId,
          name: name.trimmingCharacters(in: .whitespacesAndNewlines),
          color: color,
          transport: completed.transport,
          endpoint: completed.endpoint,
          tlsFingerprint: completed.tlsFingerprint,
          permission: completed.permission,
          expiresAt: completed.expiresAt
        )
        try environment.registry.add(machine, credential: completed.credential)
        return machine.dictionary
      }
    }.runOnQueue(nativeQueue)

    AsyncFunction("cancelPairing") { (pendingId: String, promise: Promise) in
      self.perform(promise) {
        try self.environment().core.cancelPairing(pendingId: pendingId)
      }
    }.runOnQueue(nativeQueue)

    AsyncFunction("removeMachine") { (machineId: String, promise: Promise) in
      do {
        let environment = try self.environment()
        try environment.core.disconnect(machineId: machineId)
        try environment.registry.remove(id: machineId)
        DispatchQueue.main.async {
          self.previewManager().remove(machineId: machineId, core: environment.core) { error in
            if let error { promise.reject(self.exception(error)) }
            else { promise.resolve() }
          }
        }
      } catch {
        promise.reject(self.exception(error))
      }
    }.runOnQueue(nativeQueue)

    AsyncFunction("renameMachine") { (machineId: String, name: String, color: String, promise: Promise) in
      self.perform(promise) {
        try self.environment().registry.rename(id: machineId, name: name, color: color)
      }
    }.runOnQueue(nativeQueue)

    AsyncFunction("connect") { (machineId: String, promise: Promise) in
      self.perform(promise) {
        let environment = try self.environment()
        guard let machine = environment.registry.machine(id: machineId) else {
          throw SecureStoreError.invalidRegistry("machine is unavailable")
        }
        let connection = try environment.core.connect(machine: MachineCredentials(
          machineId: machine.id,
          endpoint: machine.endpoint,
          tlsFingerprint: machine.tlsFingerprint,
          credential: try environment.registry.credential(id: machine.id)
        ))
        try environment.registry.updateConnection(id: machine.id, permission: connection.permission)
        return ["epoch": connection.epoch, "permission": connection.permission]
      }
    }.runOnQueue(nativeQueue)

    AsyncFunction("disconnect") { (machineId: String, promise: Promise) in
      self.perform(promise) {
        try self.environment().core.disconnect(machineId: machineId)
      }
    }.runOnQueue(nativeQueue)

    AsyncFunction("request") {
      (machineId: String, method: String, paramsJson: String, promise: Promise) in
      self.perform(promise) {
        guard readMethods.contains(method) || controlMethods.contains(method) else {
          throw ModuleError("method_forbidden: this method is outside the mobile contract")
        }
        let environment = try self.environment()
        guard let machine = environment.registry.machine(id: machineId) else {
          throw SecureStoreError.invalidRegistry("machine is unavailable")
        }
        if controlMethods.contains(method) {
          guard machine.permission == "fullcontrol" else {
            throw ModuleError("readonly: this computer granted viewing only")
          }
          guard self.isControlUnlocked() else {
            throw ModuleError("control_locked: unlock control with biometrics")
          }
        }
        return try environment.core.request(machineId: machineId, method: method, paramsJson: paramsJson)
      }
    }.runOnQueue(nativeQueue)

    AsyncFunction("unlockControl") { (promise: Promise) in
      let generation = self.beginControlUnlock()
      let context = LAContext()
      context.localizedCancelTitle = "Cancel"
      var error: NSError?
      guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else {
        promise.resolve(false)
        return
      }
      context.evaluatePolicy(
        .deviceOwnerAuthenticationWithBiometrics,
        localizedReason: "Unlock control of your ThreadTerm sessions"
      ) { success, _ in
        promise.resolve(self.completeControlUnlock(generation: generation, authenticated: success))
      }
    }.runOnQueue(nativeQueue)

    AsyncFunction("lockControl") { (promise: Promise) in
      self.perform(promise) {
        try self.lockAndDisconnect()
      }
    }.runOnQueue(nativeQueue)

    AsyncFunction("openPreview") { (machineId: String, url: String, promise: Promise) in
      DispatchQueue.main.async {
        do {
          let environment = try self.environment()
          guard environment.registry.machine(id: machineId) != nil,
                let presenter = self.appContext?.utilities?.currentViewController() else {
            throw PreviewError.unavailable
          }
          try self.previewManager().open(machineId: machineId, url: url, core: environment.core, presenter: presenter)
          promise.resolve()
        } catch {
          promise.reject(self.exception(error))
        }
      }
    }.runOnQueue(.main)

    AsyncFunction("chooseAttachment") { (promise: Promise) in
      DispatchQueue.main.async {
        guard let presenter = self.appContext?.utilities?.currentViewController() else {
          promise.reject(self.exception(AttachmentError.unavailable))
          return
        }
        self.attachmentPicker.present(from: presenter) { result in
          switch result {
          case .success(let attachment): promise.resolve(attachment?.dictionary)
          case .failure(let error): promise.reject(self.exception(error))
          }
        }
      }
    }.runOnQueue(.main)

    AsyncFunction("readAttachment") {
      (uri: String, offset: Double, length: Int, promise: Promise) in
      self.perform(promise) {
        guard offset.isFinite,
              offset.rounded(.towardZero) == offset,
              offset >= 0,
              offset <= Double(Int64.max) else {
          throw AttachmentError.invalidRead
        }
        return try self.attachmentPicker.read(uri: uri, offset: Int64(offset), length: length)
      }
    }.runOnQueue(nativeQueue)

    OnAppEntersBackground {
      // Close the gate at the lifecycle boundary. Network teardown may wait
      // for the native queue, but a late biometric callback cannot reopen it.
      self.setControlUnlocked(false)
      self.nativeQueue.async {
        try? self.lockAndDisconnect()
        self.attachmentPicker.cleanup()
      }
    }

    OnDestroy {
      self.destroy()
    }
  }

  fileprivate func emitRuntime(machineId: String, eventJson: String) {
    DispatchQueue.main.async { [weak self] in
      self?.sendEvent("onRuntimeEvent", ["machineId": machineId, "eventJson": eventJson])
    }
  }

  fileprivate func emitConnection(machineId: String, state: String, message: String?) {
    let allowed = ["connecting", "connected", "disconnected", "incompatible", "pin-mismatch", "revoked"]
    let safeState = allowed.contains(state) ? state : "disconnected"
    DispatchQueue.main.async { [weak self] in
      var payload: [String: Any] = ["machineId": machineId, "state": safeState]
      if let message { payload["message"] = message }
      self?.sendEvent("onConnectionState", payload)
    }
  }

  private func environment() throws -> NativeEnvironment {
    environmentLock.lock()
    defer { environmentLock.unlock() }
    if let storedEnvironment { return storedEnvironment }
    let registry = try MachineRegistry(keychain: keychain)
    let savedSecret = try keychain.string(for: MachineRegistry.irohSecretAccount)
    let core = try NativeClient(irohSecretHex: savedSecret)
    if savedSecret == nil {
      do {
        try keychain.set(core.irohSecretHex(), for: MachineRegistry.irohSecretAccount)
      } catch {
        try? core.shutdown()
        throw error
      }
    }
    let listener = NativeEvents(owner: self)
    try core.setEventListener(listener: listener)
    let value = NativeEnvironment(registry: registry, core: core, listener: listener)
    storedEnvironment = value
    return value
  }

  @MainActor
  private func previewManager() -> PreviewManager {
    if let storedPreviewManager { return storedPreviewManager }
    let manager = PreviewManager()
    storedPreviewManager = manager
    return manager
  }

  private func perform(_ promise: Promise, _ body: () throws -> Any?) {
    do {
      promise.resolve(try body())
    } catch {
      promise.reject(exception(error))
    }
  }

  private func exception(_ error: Error) -> Exception {
    let description = String(describing: error)
    let localized = (error as NSError).localizedDescription
    let searchable = "\(description) \(localized)".lowercased()
    let codes = [
      "invalid_pairing", "pairing_expired", "pin_mismatch", "alpn_mismatch", "unreachable",
      "incompatible", "not_connected", "request_timeout", "remote_error", "protocol_error",
      "keychain_error", "invalid_registry", "method_forbidden", "readonly", "control_locked",
      "picker_busy", "picker_unavailable", "invalid_attachment", "invalid_attachment_read",
      "attachment_error", "invalid_preview_url", "invalid_machine", "preview_unavailable"
    ]
    let code = codes.first(where: { searchable.contains($0) }) ?? "internal_error"
    return Exception(name: "ThreadTermMobileError", description: description, code: code)
  }

  private func isControlUnlocked() -> Bool {
    controlLock.lock()
    defer { controlLock.unlock() }
    return controlUnlocked
  }

  private func setControlUnlocked(_ value: Bool) {
    controlLock.lock()
    if !value {
      controlGeneration &+= 1
    }
    let changed = controlUnlocked != value
    controlUnlocked = value
    controlLock.unlock()
    if changed {
      DispatchQueue.main.async { [weak self] in
        self?.sendEvent("onControlLock", ["locked": !value])
      }
    }
  }

  private func beginControlUnlock() -> UInt64 {
    controlLock.lock()
    controlGeneration &+= 1
    let generation = controlGeneration
    controlLock.unlock()
    return generation
  }

  private func completeControlUnlock(generation: UInt64, authenticated: Bool) -> Bool {
    controlLock.lock()
    guard authenticated, generation == controlGeneration else {
      controlLock.unlock()
      return false
    }
    let changed = !controlUnlocked
    controlUnlocked = true
    controlLock.unlock()
    if changed {
      DispatchQueue.main.async { [weak self] in
        self?.sendEvent("onControlLock", ["locked": false])
      }
    }
    return true
  }

  private func lockAndDisconnect() throws {
    setControlUnlocked(false)
    environmentLock.lock()
    let environment = storedEnvironment
    environmentLock.unlock()
    guard let environment else { return }
    var firstError: Error?
    for machine in environment.registry.list() {
      do { try environment.core.disconnect(machineId: machine.id) }
      catch { if firstError == nil { firstError = error } }
    }
    if let firstError { throw firstError }
  }

  private func destroy() {
    setControlUnlocked(false)
    environmentLock.lock()
    let environment = storedEnvironment
    storedEnvironment = nil
    environmentLock.unlock()
    DispatchQueue.main.async {
      if let environment { self.storedPreviewManager?.closeActive(core: environment.core) }
      self.storedPreviewManager = nil
      self.attachmentPicker.cancel()
      self.attachmentPicker.cleanup()
    }
    nativeQueue.async {
      try? environment?.core.clearEventListener()
      try? environment?.core.shutdown()
    }
  }
}

private struct ModuleError: Error, CustomStringConvertible {
  let description: String
  init(_ description: String) { self.description = description }
}
