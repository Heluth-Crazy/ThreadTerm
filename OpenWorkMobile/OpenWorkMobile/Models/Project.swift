import Foundation
struct Project: Codable, Identifiable, Hashable {
    let name: String
    let path: String
    var id: String { path }
}
