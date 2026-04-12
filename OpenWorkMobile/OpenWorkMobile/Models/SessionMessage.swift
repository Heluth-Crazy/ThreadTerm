import Foundation
struct SessionMessage: Codable, Identifiable {
    let uuid: String
    var id: String { uuid }
}
