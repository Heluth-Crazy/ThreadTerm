import Foundation
enum PTYMessageFromServer {
    case output(id: String, data: String)
}
struct PTYInputMessage: Encodable {
    let type = "pty-input"
    let data: String
}
