import Foundation
import UIKit
import UniformTypeIdentifiers

struct PickedAttachmentValue {
  let name: String
  let size: Int64
  let uri: String

  var dictionary: [String: Any] {
    ["name": name, "size": size, "uri": uri]
  }
}

enum AttachmentError: Error, CustomStringConvertible {
  case pickerBusy
  case unavailable
  case invalidSelection
  case invalidRead
  case file(Error)

  var description: String {
    switch self {
    case .pickerBusy: return "picker_busy: another attachment picker is open"
    case .unavailable: return "picker_unavailable: no view controller can present the attachment picker"
    case .invalidSelection: return "invalid_attachment: select one regular file"
    case .invalidRead: return "invalid_attachment_read: attachment read is outside the picked file"
    case .file(let error): return "attachment_error: \(error.localizedDescription)"
    }
  }
}

final class AttachmentPicker: NSObject, UIDocumentPickerDelegate {
  private static let baseRoot = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
    .appendingPathComponent("ThreadTermAttachments", isDirectory: true)
  private static let purgePriorProcessCopies: Void = {
    try? FileManager.default.removeItem(at: AttachmentPicker.baseRoot)
  }()

  private let lock = NSLock()
  private var completion: ((Result<PickedAttachmentValue?, Error>) -> Void)?
  private var files: [String: URL] = [:]
  private let root: URL

  override init() {
    _ = Self.purgePriorProcessCopies
    root = Self.baseRoot
      .appendingPathComponent(UUID().uuidString.lowercased(), isDirectory: true)
    super.init()
  }

  @MainActor
  func present(from controller: UIViewController, completion: @escaping (Result<PickedAttachmentValue?, Error>) -> Void) {
    guard self.completion == nil else {
      completion(.failure(AttachmentError.pickerBusy))
      return
    }
    self.completion = completion
    let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.data], asCopy: true)
    picker.delegate = self
    picker.allowsMultipleSelection = false
    picker.shouldShowFileExtensions = true
    controller.present(picker, animated: true)
  }

  @MainActor
  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    settle(.success(nil))
  }

  @MainActor
  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    guard let source = urls.first, urls.count == 1 else {
      settle(.failure(AttachmentError.invalidSelection))
      return
    }
    let accessed = source.startAccessingSecurityScopedResource()
    defer { if accessed { source.stopAccessingSecurityScopedResource() } }
    var coordinationError: NSError?
    var result: Result<PickedAttachmentValue, Error>?
    NSFileCoordinator().coordinate(readingItemAt: source, options: .withoutChanges, error: &coordinationError) { coordinated in
      do {
        let values = try coordinated.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey, .nameKey])
        guard values.isRegularFile == true, let size = values.fileSize, size >= 0 else {
          throw AttachmentError.invalidSelection
        }
        try FileManager.default.createDirectory(
          at: root,
          withIntermediateDirectories: true,
          attributes: [.protectionKey: FileProtectionType.complete]
        )
        let id = UUID().uuidString.lowercased()
        let destination = root.appendingPathComponent(id, isDirectory: false)
        try FileManager.default.copyItem(at: coordinated, to: destination)
        try FileManager.default.setAttributes(
          [.protectionKey: FileProtectionType.complete, .posixPermissions: 0o600],
          ofItemAtPath: destination.path
        )
        let uri = "threadterm-attachment://\(id)"
        lock.lock()
        files[uri] = destination
        lock.unlock()
        result = .success(PickedAttachmentValue(name: values.name ?? source.lastPathComponent, size: Int64(size), uri: uri))
      } catch {
        result = .failure(error)
      }
    }
    if let coordinationError {
      settle(.failure(AttachmentError.file(coordinationError)))
    } else {
      settle(result ?? .failure(AttachmentError.invalidSelection))
    }
  }

  func read(uri: String, offset: Int64, length: Int) throws -> String {
    guard offset >= 0, length >= 0, length <= 1024 * 1024 else {
      throw AttachmentError.invalidRead
    }
    lock.lock()
    let file = files[uri]
    lock.unlock()
    guard let file, file.deletingLastPathComponent().standardizedFileURL == root.standardizedFileURL else {
      throw AttachmentError.invalidRead
    }
    do {
      let handle = try FileHandle(forReadingFrom: file)
      defer { try? handle.close() }
      let size = try handle.seekToEnd()
      guard UInt64(offset) <= size else {
        throw AttachmentError.invalidRead
      }
      if length == 0 {
        guard UInt64(offset) == size else {
          throw AttachmentError.invalidRead
        }
        return ""
      }
      try handle.seek(toOffset: UInt64(offset))
      let data = try handle.read(upToCount: length) ?? Data()
      return data.base64EncodedString()
    } catch let error as AttachmentError {
      throw error
    } catch {
      throw AttachmentError.file(error)
    }
  }

  @MainActor
  func cancel() {
    settle(.failure(AttachmentError.unavailable))
  }

  func cleanup() {
    lock.lock()
    files.removeAll()
    lock.unlock()
    try? FileManager.default.removeItem(at: root)
  }

  @MainActor
  private func settle(_ result: Result<PickedAttachmentValue?, Error>) {
    let callback = completion
    completion = nil
    callback?(result)
  }
}
