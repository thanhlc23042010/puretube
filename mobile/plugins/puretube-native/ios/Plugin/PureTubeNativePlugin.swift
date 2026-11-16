import Foundation
import AVFoundation
import Capacitor
import Darwin

private final class StreamSpec {
    let url: String
    let headers: [String: String]
    let createdAt: TimeInterval
    var totalLength: Int64
    var mimeType: String

    init(url: String, headers: [String: String], totalLength: Int64, mimeType: String) {
        self.url = url
        self.headers = headers
        self.totalLength = totalLength
        self.mimeType = mimeType.isEmpty ? "video/mp4" : mimeType
        self.createdAt = Date().timeIntervalSince1970
    }
}

@objc(PureTubeNativePlugin)
public class PureTubeNativePlugin: CAPPlugin {
    private let registryLock = NSLock()
    private var streamRegistry: [String: StreamSpec] = [:]
    private let proxyLock = NSLock()
    private var listenFd: Int32 = -1
    private var proxyPort: Int = 0
    private let proxySession: URLSession = {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 15.0
        cfg.timeoutIntervalForResource = 30.0
        return URLSession(configuration: cfg)
    }()

    override public func load() {
        super.load()
        Darwin.signal(SIGPIPE, SIG_IGN)
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback, options: [.allowAirPlay, .allowBluetoothA2DP])
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {
            // Non-fatal if simulator or audio session deferred
        }
        _ = ensureProxyStarted()
    }

    deinit {
        proxyLock.lock()
        if listenFd >= 0 {
            Darwin.close(listenFd)
            listenFd = -1
        }
        proxyPort = 0
        proxyLock.unlock()
    }

    private func ensureProxyStarted() -> Int {
        proxyLock.lock()
        defer { proxyLock.unlock() }
        if listenFd >= 0 && proxyPort > 0 {
            return proxyPort
        }

        let fd = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return 0 }

        var yes: Int32 = 1
        Darwin.setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))

        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = 0
        addr.sin_addr = in_addr(s_addr: Darwin.inet_addr("127.0.0.1"))

        let bindOk = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0
            }
        }
        guard bindOk, Darwin.listen(fd, 64) == 0 else {
            Darwin.close(fd)
            return 0
        }

        var boundAddr = sockaddr_in()
        var addrLen = socklen_t(MemoryLayout<sockaddr_in>.size)
        let nameOk = withUnsafeMutablePointer(to: &boundAddr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.getsockname(fd, $0, &addrLen) == 0
            }
        }
        let port = nameOk ? Int(UInt16(bigEndian: boundAddr.sin_port)) : 0
        guard port > 0 else {
            Darwin.close(fd)
            return 0
        }

        listenFd = fd
        proxyPort = port

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            while let self = self {
                var clientAddr = sockaddr_in()
                var clientLen = socklen_t(MemoryLayout<sockaddr_in>.size)
                let clientFd = withUnsafeMutablePointer(to: &clientAddr) {
                    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                        Darwin.accept(fd, $0, &clientLen)
                    }
                }
                if clientFd < 0 {
                    break
                }
                var noSigPipe: Int32 = 1
                Darwin.setsockopt(clientFd, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))
                DispatchQueue.global(qos: .userInitiated).async {
                    self.handleProxyClient(clientFd)
                }
            }
        }
        return port
    }

    private func writeAll(_ fd: Int32, data: Data) -> Bool {
        if data.isEmpty { return true }
        return data.withUnsafeBytes { rawBuf in
            guard let base = rawBuf.baseAddress else { return false }
            var sent = 0
            while sent < data.count {
                let n = Darwin.send(fd, base.advanced(by: sent), data.count - sent, 0)
                if n <= 0 {
                    return false
                }
                sent += n
            }
            return true
        }
    }

    private func writeSimpleResponse(_ fd: Int32, code: Int, reason: String, extraHeaders: String = "") {
        let raw = "HTTP/1.1 \(code) \(reason)\r\n\(extraHeaders)Access-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n"
        if let d = raw.data(using: .ascii) {
            _ = writeAll(fd, data: d)
        }
    }

    private func fetchUpstreamSync(urlStr: String, headers: [String: String], rangeHeader: String) -> (Int, [AnyHashable: Any], Data)? {
        guard let url = URL(string: urlStr) else { return nil }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20.0)
        req.httpMethod = "GET"
        for (k, v) in headers where k.lowercased() != "accept-encoding" && k.lowercased() != "range" {
            req.setValue(v, forHTTPHeaderField: k)
        }
        req.setValue(rangeHeader, forHTTPHeaderField: "Range")

        let sem = DispatchSemaphore(value: 0)
        var out: (Int, [AnyHashable: Any], Data)?
        proxySession.dataTask(with: req) { data, response, _ in
            if let http = response as? HTTPURLResponse {
                out = (http.statusCode, http.allHeaderFields, data ?? Data())
            }
            sem.signal()
        }.resume()
        sem.wait()
        return out
    }

    private func parseHeaderCI(_ headers: [AnyHashable: Any], key: String) -> String? {
        for (k, v) in headers {
            if let ks = k as? String, ks.caseInsensitiveCompare(key) == .orderedSame {
                return "\(v)"
            }
        }
        return nil
    }

    private func probeStreamMeta(_ spec: StreamSpec) {
        guard let (status, hdrs, _) = fetchUpstreamSync(urlStr: spec.url, headers: spec.headers, rangeHeader: "bytes=0-65535") else {
            return
        }
        if let cr = parseHeaderCI(hdrs, key: "Content-Range"),
           let slashIdx = cr.lastIndex(of: "/") {
            let totalStr = String(cr[cr.index(after: slashIdx)...]).trimmingCharacters(in: .whitespacesAndNewlines)
            if let val = Int64(totalStr), val > 0 {
                spec.totalLength = val
            }
        } else if status == 200,
                  let cl = parseHeaderCI(hdrs, key: "Content-Length"),
                  let val = Int64(cl.trimmingCharacters(in: .whitespacesAndNewlines)),
                  val > 0 {
            spec.totalLength = val
        }
        if let ct = parseHeaderCI(hdrs, key: "Content-Type"), !ct.contains("text/plain") {
            let cleanCt = ct.split(separator: ";").first.map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
            if let cleanCt = cleanCt, !cleanCt.isEmpty {
                spec.mimeType = cleanCt
            }
        }
    }

    private func handleProxyClient(_ fd: Int32) {
        defer { Darwin.close(fd) }

        var reqData = Data()
        var chunk = [UInt8](repeating: 0, count: 4096)
        let separator = Data([13, 10, 13, 10]) // \r\n\r\n
        while reqData.count < 16384 {
            let n = Darwin.recv(fd, &chunk, chunk.count, 0)
            if n <= 0 { break }
            reqData.append(chunk, count: n)
            if reqData.range(of: separator) != nil { break }
        }
        guard let reqStr = String(data: reqData, encoding: .utf8) else { return }
        let lines = reqStr.components(separatedBy: "\r\n")
        guard let firstLine = lines.first, !firstLine.isEmpty else { return }
        let parts = firstLine.split(separator: " ")
        guard parts.count >= 2 else {
            writeSimpleResponse(fd, code: 400, reason: "Bad Request")
            return
        }
        let method = String(parts[0]).uppercased()
        let target = String(parts[1])
        if method != "GET" && method != "HEAD" {
            writeSimpleResponse(fd, code: 405, reason: "Method Not Allowed")
            return
        }

        var rangeHeader: String?
        for line in lines.dropFirst() {
            if let idx = line.firstIndex(of: ":") {
                let name = String(line[..<idx]).trimmingCharacters(in: .whitespaces)
                if name.caseInsensitiveCompare("Range") == .orderedSame {
                    rangeHeader = String(line[line.index(after: idx)...]).trimmingCharacters(in: .whitespaces)
                }
            }
        }

        guard let comps = URLComponents(string: "http://127.0.0.1\(target)"),
              let streamId = comps.queryItems?.first(where: { $0.name == "id" })?.value else {
            writeSimpleResponse(fd, code: 404, reason: "Not Found")
            return
        }

        registryLock.lock()
        let spec = streamRegistry[streamId]
        registryLock.unlock()
        guard let spec = spec else {
            writeSimpleResponse(fd, code: 404, reason: "Not Found")
            return
        }

        if spec.totalLength <= 0 {
            probeStreamMeta(spec)
        }
        let total = spec.totalLength
        guard total > 0 else {
            writeSimpleResponse(fd, code: 502, reason: "Bad Gateway")
            return
        }

        var reqStart: Int64 = 0
        var reqEnd: Int64 = total - 1
        var hasRange = false
        if let rh = rangeHeader?.lowercased(), rh.hasPrefix("bytes=") {
            hasRange = true
            let specPart = String(rh.dropFirst("bytes=".count)).components(separatedBy: ",")[0]
            let bounds = specPart.components(separatedBy: "-")
            if bounds.count == 2 {
                if let s = Int64(bounds[0]) {
                    reqStart = s
                    reqEnd = Int64(bounds[1]).map { min($0, total - 1) } ?? (total - 1)
                } else if let suffix = Int64(bounds[1]) {
                    reqStart = max(0, total - suffix)
                    reqEnd = total - 1
                }
            }
        }

        if reqStart < 0 || reqStart >= total || reqEnd < reqStart {
            writeSimpleResponse(fd, code: 416, reason: "Range Not Satisfiable", extraHeaders: "Content-Range: bytes */\(total)\r\n")
            return
        }

        let contentLen = (reqEnd - reqStart) + 1
        var hdr = hasRange ? "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes \(reqStart)-\(reqEnd)/\(total)\r\n" : "HTTP/1.1 200 OK\r\n"
        hdr += "Accept-Ranges: bytes\r\nContent-Type: \(spec.mimeType)\r\nContent-Length: \(contentLen)\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n"
        guard let hdrData = hdr.data(using: .ascii), writeAll(fd, data: hdrData) else { return }
        if method == "HEAD" { return }

        var chunkSpan: Int64 = (total > 0 && total < 35_000_000) ? 262_144 : 524_288
        var cursor = reqStart
        while cursor <= reqEnd {
            let subEnd = min(cursor + chunkSpan - 1, reqEnd)
            guard let (status, _, data) = fetchUpstreamSync(urlStr: spec.url, headers: spec.headers, rangeHeader: "bytes=\(cursor)-\(subEnd)") else {
                break
            }
            if status == 403 && chunkSpan > 65_536 {
                chunkSpan /= 2
                continue
            }
            guard (status == 200 || status == 206), !data.isEmpty else {
                break
            }
            if !writeAll(fd, data: data) {
                break
            }
            cursor += Int64(data.count)
        }
    }

    @objc func registerStream(_ call: CAPPluginCall) {
        let url = call.getString("url") ?? ""
        if url.isEmpty {
            call.reject("Missing url")
            return
        }
        let port = ensureProxyStarted()
        if port <= 0 {
            call.reject("Failed to start local media proxy")
            return
        }
        let rawHeaders = call.getObject("headers") ?? [:]
        var headers: [String: String] = [:]
        for (k, v) in rawHeaders {
            if let sv = v as? String, k.lowercased() != "accept-encoding" {
                headers[k] = sv
            }
        }
        let contentLength = Int64(call.getDouble("contentLength") ?? 0)
        let mimeType = call.getString("mimeType") ?? "video/mp4"

        let id = UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(16).lowercased()
        registryLock.lock()
        if streamRegistry.count > 96,
           let oldestKey = streamRegistry.min(by: { $0.value.createdAt < $1.value.createdAt })?.key {
            streamRegistry.removeValue(forKey: oldestKey)
        }
        streamRegistry[String(id)] = StreamSpec(url: url, headers: headers, totalLength: contentLength, mimeType: mimeType)
        registryLock.unlock()

        call.resolve(["proxyUrl": "http://127.0.0.1:\(port)/stream?id=\(id)"])
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
