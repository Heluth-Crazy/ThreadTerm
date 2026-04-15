import UIKit

enum ANSIParser {
    private static let esc = "\u{001B}"
    private static let bel = "\u{0007}"
    private static let ansiPatterns: [String] = [
        "\(esc)\\[[0-?]*[ -/]*[@-~]",                 // CSI
        "(?s)\(esc)\\].*?(?:\(bel)|\(esc)\\\\)",      // OSC
        "(?s)\(esc)P.*?(?:\(esc)\\\\)",               // DCS
        "\(esc)[@-_]",                                // Single-character escape
    ]

    static func clean(_ input: String) -> String {
        var output = input

        for pattern in ansiPatterns {
            output = output.replacingOccurrences(
                of: pattern,
                with: "",
                options: .regularExpression
            )
        }

        let filteredScalars = output.unicodeScalars.filter { scalar in
            if scalar == "\n" || scalar == "\t" {
                return true
            }

            return !CharacterSet.controlCharacters.contains(scalar)
        }

        let normalized = String(String.UnicodeScalarView(filteredScalars))
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")

        return normalized
    }

    static func parse(_ input: String) -> NSAttributedString {
        NSAttributedString(string: clean(input))
    }
}
