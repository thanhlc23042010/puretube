import AVFoundation
import Capacitor
import MediaPlayer
import UIKit
import WebKit

private final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    private weak var target: WKScriptMessageHandler?

    init(_ target: WKScriptMessageHandler) {
        self.target = target
        super.init()
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        target?.userContentController(userContentController, didReceive: message)
    }
}

final class PureTubeWebViewController: UIViewController, WKNavigationDelegate, WKScriptMessageHandler {
    private let homeURL = URL(string: "https://m.youtube.com")!
    private var webView: WKWebView!

    override var preferredStatusBarStyle: UIStatusBarStyle {
        .lightContent
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 15 / 255, green: 15 / 255, blue: 15 / 255, alpha: 1)

        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.allowsPictureInPictureMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.websiteDataStore = .default()

        let ucc = WKUserContentController()
        ucc.add(WeakScriptMessageHandler(self), name: "puretube")

        if let scriptSource = loadInjectScript() {
            let userScript = WKUserScript(
                source: scriptSource,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: false
            )
            ucc.addUserScript(userScript)
        }
        config.userContentController = ucc

        webView = WKWebView(frame: .zero, configuration: config)
        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.navigationDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.isOpaque = false
        webView.backgroundColor = view.backgroundColor
        webView.scrollView.backgroundColor = view.backgroundColor
        webView.customUserAgent =
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"

        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
        ])

        setupRemoteCommands()
        compileAdRulesAndLoad(into: ucc)
    }

    private func loadInjectScript() -> String? {
        let url =
            Bundle.main.url(forResource: "puretube_inject", withExtension: "js", subdirectory: "public")
            ?? Bundle.main.url(forResource: "puretube_inject", withExtension: "js")
        guard let scriptURL = url else { return nil }
        return try? String(contentsOf: scriptURL, encoding: .utf8)
    }

    private func compileAdRulesAndLoad(into ucc: WKUserContentController) {
        let rulesPayload: [[String: Any]] = [
            [
                "trigger": [
                    "url-filter": #"https?://([^/]+\.)?(doubleclick\.net|googlesyndication\.com|googleadservices\.com|google-analytics\.com|googletagmanager\.com|adservice\.google\.com(\.vn)?|ads\.youtube\.com|s0\.2mdn\.net)/.*"#,
                ],
                "action": ["type": "block"],
            ],
            [
                "trigger": [
                    "url-filter": #"https?://([^/]+\.)?youtube\.com/(pagead/|api/stats/ads|api/stats/atr|ptracking|get_midroll_info|youtubei/v1/ad_break).*"#,
                ],
                "action": ["type": "block"],
            ],
        ]

        guard let data = try? JSONSerialization.data(withJSONObject: rulesPayload),
              let rulesJson = String(data: data, encoding: .utf8) else {
            webView.load(URLRequest(url: homeURL))
            return
        }

        WKContentRuleListStore.default()?.compileContentRuleList(
            forIdentifier: "PureTubeYouTubeAdBlock",
            encodedContentRuleList: rulesJson
        ) { [weak self] ruleList, _ in
            DispatchQueue.main.async {
                if let ruleList = ruleList {
                    ucc.add(ruleList)
                }
                self?.webView.load(URLRequest(url: self?.homeURL ?? URL(string: "https://m.youtube.com")!))
            }
        }
    }

    func openYouTubeURL(_ url: URL) {
        guard webView != nil else { return }
        webView.load(URLRequest(url: url))
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url,
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else {
            decisionHandler(.cancel)
            return
        }
        let host = (url.host ?? "").lowercased()
        let allowed = ["youtube.com", "youtu.be", "youtube-nocookie.com", "google.com", "google.com.vn", "gstatic.com", "googleapis.com", "googleusercontent.com", "ytimg.com", "ggpht.com"]
        if allowed.contains(where: { host == $0 || host.hasSuffix("." + $0) }) {
            decisionHandler(.allow)
            return
        }
        UIApplication.shared.open(url, options: [:], completionHandler: nil)
        decisionHandler(.cancel)
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard message.name == "puretube",
              let body = message.body as? [String: Any],
              (body["type"] as? String) == "mediaState" else {
            return
        }
        let title = (body["title"] as? String) ?? "PureTube"
        let artist = (body["artist"] as? String) ?? "YouTube"
        let playing = (body["playing"] as? Bool) ?? false

        MPNowPlayingInfoCenter.default().nowPlayingInfo = [
            MPMediaItemPropertyTitle: title,
            MPMediaItemPropertyArtist: artist,
            MPNowPlayingInfoPropertyPlaybackRate: playing ? 1.0 : 0.0,
        ]
    }

    private func setupRemoteCommands() {
        let cc = MPRemoteCommandCenter.shared()
        cc.playCommand.isEnabled = true
        cc.pauseCommand.isEnabled = true
        cc.nextTrackCommand.isEnabled = true
        cc.previousTrackCommand.isEnabled = true

        cc.playCommand.addTarget { [weak self] _ in
            self?.sendMediaControl("play")
            return .success
        }
        cc.pauseCommand.addTarget { [weak self] _ in
            self?.sendMediaControl("pause")
            return .success
        }
        cc.nextTrackCommand.addTarget { [weak self] _ in
            self?.sendMediaControl("next")
            return .success
        }
        cc.previousTrackCommand.addTarget { [weak self] _ in
            self?.sendMediaControl("prev")
            return .success
        }
    }

    private func sendMediaControl(_ action: String) {
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript(
                "if(window.__puretubeMediaControl){window.__puretubeMediaControl('\(action)');}",
                completionHandler: nil
            )
        }
    }
}

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    private var rootVC: PureTubeWebViewController?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .moviePlayback, options: [])
            try session.setActive(true)
        } catch {}

        let vc = PureTubeWebViewController()
        let win = UIWindow(frame: UIScreen.main.bounds)
        win.backgroundColor = UIColor(red: 15 / 255, green: 15 / 255, blue: 15 / 255, alpha: 1)
        win.rootViewController = vc
        win.makeKeyAndVisible()
        self.rootVC = vc
        self.window = win
        return true
    }

    func application(
        _ app: UIApplication,
        open url: URL,
        options: [UIApplication.OpenURLOptionsKey: Any] = [:]
    ) -> Bool {
        if let host = url.host?.lowercased(), host.contains("youtube.com") || host.contains("youtu.be") {
            rootVC?.openYouTubeURL(url)
            return true
        }
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(
        _ application: UIApplication,
        continue userActivity: NSUserActivity,
        restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
    ) -> Bool {
        if let url = userActivity.webpageURL,
           let host = url.host?.lowercased(),
           host.contains("youtube.com") || host.contains("youtu.be") {
            rootVC?.openYouTubeURL(url)
            return true
        }
        return ApplicationDelegateProxy.shared.application(
            application,
            continue: userActivity,
            restorationHandler: restorationHandler
        )
    }
}
