import Foundation
import AVFoundation
import Capacitor

@objc(PureTubeNativePlugin)
public class PureTubeNativePlugin: CAPPlugin {
    override public func load() {
        super.load()
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback, options: [.allowAirPlay, .allowBluetoothA2DP])
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {
            // Non-fatal if simulator or audio session deferred
        }
    }

    private func executeRequest(
        _ call: CAPPluginCall,
        method: String,
        urlStr: String,
        headers: [String: String],
        bodyData: Data?,
        asBase64: Bool
    ) {
        guard let url = URL(string: urlStr) else {
            call.reject("Invalid URL")
            return
        }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20.0)
        req.httpMethod = method
        for (k, v) in headers where k.lowercased() != "accept-encoding" {
            req.setValue(v, forHTTPHeaderField: k)
        }
        req.httpBody = bodyData

        URLSession.shared.dataTask(with: req) { data, response, error in
            if let err = error {
                call.reject("Native HTTP error: \(err.localizedDescription)")
                return
            }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let rawData = data ?? Data()
            if asBase64 {
                let ctype = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Type") ?? "application/octet-stream"
                call.resolve([
                    "status": status,
                    "contentType": ctype,
                    "base64": rawData.base64EncodedString()
                ])
            } else {
                let bodyText = String(data: rawData, encoding: .utf8) ?? ""
                call.resolve([
                    "status": status,
                    "body": bodyText
                ])
            }
        }.resume()
    }

    @objc func httpGet(_ call: CAPPluginCall) {
        let url = call.getString("url") ?? ""
        let headers = call.getObject("headers") as? [String: String] ?? [:]
        executeRequest(call, method: "GET", urlStr: url, headers: headers, bodyData: nil, asBase64: false)
    }

    @objc func httpGetBase64(_ call: CAPPluginCall) {
        let url = call.getString("url") ?? ""
        let headers = call.getObject("headers") as? [String: String] ?? [:]
        executeRequest(call, method: "GET", urlStr: url, headers: headers, bodyData: nil, asBase64: true)
    }

    @objc func httpPostJson(_ call: CAPPluginCall) {
        let url = call.getString("url") ?? ""
        let body = call.getString("body") ?? "{}"
        var headers = call.getObject("headers") as? [String: String] ?? [:]
        if headers["Content-Type"] == nil {
            headers["Content-Type"] = "application/json"
        }
        executeRequest(call, method: "POST", urlStr: url, headers: headers, bodyData: body.data(using: .utf8), asBase64: false)
    }

    @objc func httpPostForm(_ call: CAPPluginCall) {
        let url = call.getString("url") ?? ""
        let form = call.getObject("form") as? [String: Any] ?? [:]
        var headers = call.getObject("headers") as? [String: String] ?? [:]
        headers["Content-Type"] = "application/x-www-form-urlencoded"

        var allowed = CharacterSet.urlQueryAllowed
        allowed.remove(charactersIn: "+&=")
        let encoded = form.map { k, v -> String in
            let ek = k.addingPercentEncoding(withAllowedCharacters: allowed) ?? k
            let vs = "\(v)"
            let ev = vs.addingPercentEncoding(withAllowedCharacters: allowed) ?? vs
            return "\(ek)=\(ev)"
        }.joined(separator: "&")

        executeRequest(call, method: "POST", urlStr: url, headers: headers, bodyData: encoded.data(using: .utf8), asBase64: false)
    }
}
