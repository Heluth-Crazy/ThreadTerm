import Foundation
import Network
import UIKit
import WebKit

enum PreviewError: Error, CustomStringConvertible {
  case invalidURL
  case invalidMachine
  case unavailable

  var description: String {
    switch self {
    case .invalidURL: return "invalid_preview_url: preview requires an HTTP or HTTPS URL without credentials"
    case .invalidMachine: return "invalid_machine: machine identity is not a UUID"
    case .unavailable: return "preview_unavailable: no view controller can present the preview"
    }
  }
}

@MainActor
final class PreviewManager {
  private weak var activeController: PreviewViewController?
  private var activeMachineId: String?

  func open(machineId: String, url text: String, core: NativeClient, presenter: UIViewController) throws {
    guard let url = URL(string: text),
          ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
          url.user == nil,
          url.password == nil,
          url.host != nil else {
      throw PreviewError.invalidURL
    }
    guard let identifier = UUID(uuidString: machineId) else {
      throw PreviewError.invalidMachine
    }
    // Per-machine data store and per-store proxy routing are iOS 17 APIs. The
    // app's minimum is iOS 17.0, so this guard only keeps the pod compiling
    // when a pod target's deployment setting is read back below 17.
    guard #available(iOS 17.0, *) else {
      throw PreviewError.unavailable
    }
    closeActive(core: core)
    let proxy = try core.startProxy(machineId: machineId)
    guard let port = NWEndpoint.Port(rawValue: proxy.port) else {
      try? core.stopProxy(machineId: machineId)
      throw PreviewError.unavailable
    }
    var proxyConfiguration = ProxyConfiguration(
      httpCONNECTProxy: .hostPort(host: "127.0.0.1", port: port),
      tlsOptions: nil
    )
    proxyConfiguration.applyCredential(username: proxy.username, password: proxy.secret)
    proxyConfiguration.allowFailover = false

    let dataStore = WKWebsiteDataStore(forIdentifier: identifier)
    dataStore.proxyConfigurations = [proxyConfiguration]
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = dataStore
    configuration.defaultWebpagePreferences.allowsContentJavaScript = true
    let controller = PreviewViewController(machineId: machineId, url: url, configuration: configuration)
    controller.onClose = { [weak self, weak core, weak controller] in
      guard let self else { return }
      if self.activeController === controller {
        try? core?.stopProxy(machineId: machineId)
        self.activeController = nil
        self.activeMachineId = nil
      }
    }
    let navigation = UINavigationController(rootViewController: controller)
    navigation.modalPresentationStyle = .fullScreen
    activeController = controller
    activeMachineId = machineId
    presenter.present(navigation, animated: true)
  }

  func remove(machineId: String, core: NativeClient, completion: @escaping (Error?) -> Void) {
    if activeMachineId == machineId {
      closeActive(core: core)
    }
    guard let identifier = UUID(uuidString: machineId) else {
      completion(PreviewError.invalidMachine)
      return
    }
    guard #available(iOS 17.0, *) else {
      completion(PreviewError.unavailable)
      return
    }
    // remove(forIdentifier:) crashes (null WebKit main RunLoop) when nothing has initialized WebKit yet,
    // for example removing a computer whose preview was never opened. Touching the default store initializes it.
    _ = WKWebsiteDataStore.default()
    WKWebsiteDataStore.remove(forIdentifier: identifier) { error in
      completion(error)
    }
  }

  func closeActive(core: NativeClient) {
    guard let controller = activeController else {
      activeMachineId = nil
      return
    }
    let machineId = controller.machineId
    controller.dismiss(animated: false)
    try? core.stopProxy(machineId: machineId)
    activeController = nil
    activeMachineId = nil
  }
}

@MainActor
private final class PreviewViewController: UIViewController, WKNavigationDelegate {
  let machineId: String
  var onClose: (() -> Void)?
  private let initialURL: URL
  private let webView: WKWebView
  private var closed = false

  init(machineId: String, url: URL, configuration: WKWebViewConfiguration) {
    self.machineId = machineId
    initialURL = url
    webView = WKWebView(frame: .zero, configuration: configuration)
    super.init(nibName: nil, bundle: nil)
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    navigationItem.title = initialURL.host
    navigationItem.leftBarButtonItem = UIBarButtonItem(
      barButtonSystemItem: .close,
      target: self,
      action: #selector(close)
    )
    navigationItem.rightBarButtonItems = [
      UIBarButtonItem(barButtonSystemItem: .refresh, target: self, action: #selector(reload)),
      UIBarButtonItem(title: "Back", style: .plain, target: self, action: #selector(goBack))
    ]
    webView.navigationDelegate = self
    webView.allowsBackForwardNavigationGestures = true
    webView.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(webView)
    NSLayoutConstraint.activate([
      webView.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
      webView.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
      webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
      webView.bottomAnchor.constraint(equalTo: view.bottomAnchor)
    ])
    webView.load(URLRequest(url: initialURL, cachePolicy: .useProtocolCachePolicy, timeoutInterval: 30))
  }

  override func viewDidDisappear(_ animated: Bool) {
    super.viewDidDisappear(animated)
    if isBeingDismissed || navigationController?.isBeingDismissed == true {
      finish()
    }
  }

  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    guard let url = navigationAction.request.url,
          ["http", "https", "about"].contains(url.scheme?.lowercased() ?? "") else {
      decisionHandler(.cancel)
      return
    }
    if navigationAction.targetFrame == nil {
      webView.load(navigationAction.request)
      decisionHandler(.cancel)
    } else {
      decisionHandler(.allow)
    }
  }

  @objc private func close() {
    dismiss(animated: true)
    finish()
  }

  @objc private func reload() {
    webView.reload()
  }

  @objc private func goBack() {
    if webView.canGoBack { webView.goBack() }
  }

  private func finish() {
    guard !closed else { return }
    closed = true
    webView.stopLoading()
    onClose?()
    onClose = nil
  }
}
