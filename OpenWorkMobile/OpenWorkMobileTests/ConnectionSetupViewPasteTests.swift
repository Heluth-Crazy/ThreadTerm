import XCTest
import SwiftUI
@testable import OpenWorkMobile

@MainActor
final class ConnectionSetupViewPasteTests: XCTestCase {
    func testTokenFieldAcceptsPasteFromPasteboard() {
        let originalPasteboard = UIPasteboard.general.string
        defer {
            UIPasteboard.general.string = originalPasteboard
        }

        let connectionVM = ConnectionViewModel()
        let host = UIHostingController(
            rootView: ConnectionSetupView()
                .environment(connectionVM)
        )
        let scene = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first
        let window = if let scene {
            UIWindow(windowScene: scene)
        } else {
            UIWindow(frame: UIScreen.main.bounds)
        }
        window.frame = UIScreen.main.bounds
        window.rootViewController = host
        window.makeKeyAndVisible()
        host.loadViewIfNeeded()
        host.view.frame = window.bounds
        host.view.setNeedsLayout()
        host.view.layoutIfNeeded()
        window.layoutIfNeeded()

        pumpMainRunLoop(times: 5)

        guard let tokenField = findTokenField(in: host.view) else {
            return XCTFail("Failed to locate the API token field.\n\(debugViewHierarchy(host.view))")
        }

        XCTAssertEqual(tokenField.textContentType, .oneTimeCode)

        UIPasteboard.general.string = "ow_test_token_1234567890"
        XCTAssertTrue(tokenField.becomeFirstResponder(), "The API token field should become first responder")

        pumpMainRunLoop(times: 2)

        tokenField.paste(nil)

        pumpMainRunLoop(times: 2)

        XCTAssertEqual(tokenField.text, "ow_test_token_1234567890")
    }

    private func pumpMainRunLoop(times: Int = 1) {
        for _ in 0..<times {
            RunLoop.main.run(until: Date().addingTimeInterval(0.2))
        }
    }

    private func findTokenField(in view: UIView) -> UITextField? {
        for _ in 0..<10 {
            if let textField = firstMatchingTextField(in: view) {
                return textField
            }

            pumpMainRunLoop()
        }

        return nil
    }

    private func firstMatchingTextField(in view: UIView) -> UITextField? {
        if let textField = view as? UITextField {
            if textField.placeholder == "API Token" {
                return textField
            }

            if textField.keyboardType == .asciiCapable {
                return textField
            }
        }

        for subview in view.subviews {
            if let match = firstMatchingTextField(in: subview) {
                return match
            }
        }

        return nil
    }

    private func debugViewHierarchy(_ view: UIView, depth: Int = 0) -> String {
        let indent = String(repeating: "  ", count: depth)
        let current = "\(indent)\(type(of: view))"
        let children = view.subviews.map { debugViewHierarchy($0, depth: depth + 1) }
        return ([current] + children).joined(separator: "\n")
    }
}
