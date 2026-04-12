import Foundation

/// Messages received from the PTY WebSocket server.
enum PTYMessageFromServer {
    case history(id: String, data: String)
    case output(id: String, data: String)
    case exit(id: String, code: UInt32?)

    init?(json: [String: Any]) {
        guard let type = json["type"] as? String else { return nil }
        switch type {
        case "pty-history":
            guard let id = json["id"] as? String,
                  let data = json["data"] as? String else { return nil }
            self = .history(id: id, data: data)
        case "pty-output":
            guard let id = json["id"] as? String,
                  let data = json["data"] as? String else { return nil }
            self = .output(id: id, data: data)
        case "pty-exit":
            guard let id = json["id"] as? String else { return nil }
            let code = json["code"] as? UInt32
            self = .exit(id: id, code: code)
        default:
            return nil
        }
    }
}

/// Message sent from the iOS app to the PTY WebSocket.
struct PTYInputMessage: Encodable {
    let type = "pty-input"
    let data: String
}
