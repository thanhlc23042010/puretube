package com.puretube.nativebridge;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.BufferedOutputStream;
import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

@CapacitorPlugin(name = "PureTubeNative")
public class PureTubeNativePlugin extends Plugin {
    private static final Pattern CONTENT_RANGE_TOTAL = Pattern.compile("/(\\d+)$");
    private static final Pattern RANGE_BYTES_PATTERN = Pattern.compile("bytes=(\\d*)-(\\d*)", Pattern.CASE_INSENSITIVE);
    private static final Pattern M3U8_URI_ATTR = Pattern.compile("URI=\"([^\"]+)\"");
    private static final int MAX_STREAMS = 96;

    private static final class StreamSpec {
        final String url;
        final Map<String, String> headers;
        final long createdAt;
        volatile long totalLength;
        volatile String mimeType;

        StreamSpec(String url, Map<String, String> headers, long totalLength, String mimeType) {
            this.url = url;
            this.headers = headers;
            this.totalLength = totalLength;
            this.mimeType = (mimeType != null && !mimeType.isEmpty()) ? mimeType : "video/mp4";
            this.createdAt = System.currentTimeMillis();
        }
    }

    private final ExecutorService executor = Executors.newCachedThreadPool();
    private final ConcurrentHashMap<String, StreamSpec> streamRegistry = new ConcurrentHashMap<>();
    private final Object proxyLock = new Object();
    private volatile ServerSocket proxySocket = null;
    private volatile int proxyPort = 0;

    @Override
    public void load() {
        super.load();
        ensureProxyStarted();
        PureTubeMediaService.actionListener = action -> {
            JSObject ev = new JSObject();
            ev.put("action", action);
            notifyListeners("mediaControlAction", ev);
        };
    }

    @Override
    protected void handleOnDestroy() {
        PureTubeMediaService.actionListener = null;
        try {
            Context ctx = getContext();
            if (ctx != null) {
                Intent stopIntent = new Intent(ctx, PureTubeMediaService.class);
                stopIntent.setAction(PureTubeMediaService.ACTION_STOP);
                ctx.startService(stopIntent);
            }
        } catch (Exception ignored) {}
        synchronized (proxyLock) {
            if (proxySocket != null) {
                try {
                    proxySocket.close();
                } catch (IOException ignored) {}
                proxySocket = null;
            }
            proxyPort = 0;
        }
        streamRegistry.clear();
        super.handleOnDestroy();
    }

    private int ensureProxyStarted() {
        if (proxySocket != null && !proxySocket.isClosed() && proxyPort > 0) {
            return proxyPort;
        }
        synchronized (proxyLock) {
            if (proxySocket != null && !proxySocket.isClosed() && proxyPort > 0) {
                return proxyPort;
            }
            try {
                ServerSocket ss = new ServerSocket(0, 64, InetAddress.getByName("127.0.0.1"));
                proxySocket = ss;
                proxyPort = ss.getLocalPort();
                executor.execute(() -> runAcceptLoop(ss));
                return proxyPort;
            } catch (IOException e) {
                return 0;
            }
        }
    }

    private void runAcceptLoop(ServerSocket ss) {
        while (!ss.isClosed()) {
            try {
                final Socket client = ss.accept();
                executor.execute(() -> handleProxyClient(client));
            } catch (IOException e) {
                break;
            }
        }
    }

    private static Map<String, String> toHeaderMap(JSObject headersObj) {
        Map<String, String> map = new HashMap<>();
        if (headersObj == null) return map;
        Iterator<String> keys = headersObj.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            String val = headersObj.getString(key);
            if (val != null && !key.equalsIgnoreCase("accept-encoding")) {
                map.put(key, val);
            }
        }
        return map;
    }

    private void pruneRegistryIfNeeded() {
        if (streamRegistry.size() <= MAX_STREAMS) return;
        String oldestKey = null;
        long oldestTime = Long.MAX_VALUE;
        for (Map.Entry<String, StreamSpec> entry : streamRegistry.entrySet()) {
            if (entry.getValue().createdAt < oldestTime) {
                oldestTime = entry.getValue().createdAt;
                oldestKey = entry.getKey();
            }
        }
        if (oldestKey != null) {
            streamRegistry.remove(oldestKey);
        }
    }

    private static HttpURLConnection openUpstream(String urlStr, Map<String, String> headers, String rangeHeader)
        throws IOException {
        URL url = new URL(urlStr);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setRequestMethod("GET");
        conn.setConnectTimeout(15000);
        conn.setReadTimeout(20000);
        conn.setInstanceFollowRedirects(true);
        if (headers != null) {
            for (Map.Entry<String, String> entry : headers.entrySet()) {
                if (!entry.getKey().equalsIgnoreCase("range")) {
                    conn.setRequestProperty(entry.getKey(), entry.getValue());
                }
            }
        }
        if (rangeHeader != null && !rangeHeader.isEmpty()) {
            conn.setRequestProperty("Range", rangeHeader);
        }
        return conn;
    }

    private static void probeStreamMeta(StreamSpec spec) {
        HttpURLConnection conn = null;
        try {
            conn = openUpstream(spec.url, spec.headers, "bytes=0-65535");
            int status = conn.getResponseCode();
            String cr = conn.getHeaderField("Content-Range");
            if (cr != null) {
                Matcher m = CONTENT_RANGE_TOTAL.matcher(cr.trim());
                if (m.find()) {
                    spec.totalLength = Long.parseLong(m.group(1));
                }
            } else if (status == 200) {
                String cl = conn.getHeaderField("Content-Length");
                if (cl != null) {
                    spec.totalLength = Long.parseLong(cl.trim());
                }
            }
            String ct = conn.getContentType();
            if (ct != null && !ct.isEmpty() && !ct.contains("text/plain")) {
                spec.mimeType = ct.split(";")[0].trim();
            }
        } catch (Exception ignored) {
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static void writeSimpleResponse(OutputStream out, int code, String reason, String extraHeaders)
        throws IOException {
        String header = "HTTP/1.1 " + code + " " + reason + "\r\n" +
            (extraHeaders != null ? extraHeaders : "") +
            "Access-Control-Allow-Origin: *\r\n" +
            "Connection: close\r\n\r\n";
        out.write(header.getBytes(StandardCharsets.US_ASCII));
        out.flush();
    }

    private String rewriteM3u8Playlist(String body, String baseUrl, String streamId) {
        String proxyPrefix = "http://127.0.0.1:" + proxyPort + "/hls-seg?id=" + streamId + "&u=";
        StringBuilder out = new StringBuilder(body.length() + 512);
        String[] lines = body.split("\\r?\\n");
        for (String line : lines) {
            if (line.startsWith("#")) {
                Matcher m = M3U8_URI_ATTR.matcher(line);
                if (m.find()) {
                    StringBuffer sb = new StringBuffer();
                    m.reset();
                    while (m.find()) {
                        try {
                            String abs = new URL(new URL(baseUrl), m.group(1)).toString();
                            String rep = "URI=\"" + proxyPrefix + URLEncoder.encode(abs, "UTF-8") + "\"";
                            m.appendReplacement(sb, Matcher.quoteReplacement(rep));
                        } catch (Exception e) {
                            m.appendReplacement(sb, Matcher.quoteReplacement(m.group(0)));
                        }
                    }
                    m.appendTail(sb);
                    out.append(sb.toString()).append('\n');
                } else {
                    out.append(line).append('\n');
                }
            } else if (!line.trim().isEmpty()) {
                try {
                    String abs = new URL(new URL(baseUrl), line.trim()).toString();
                    out.append(proxyPrefix).append(URLEncoder.encode(abs, "UTF-8")).append('\n');
                } catch (Exception e) {
                    out.append(line).append('\n');
                }
            } else {
                out.append(line).append('\n');
            }
        }
        return out.toString();
    }

    private void handleHlsRequest(String target, StreamSpec spec, String streamId, OutputStream rawOut, boolean isSeg)
        throws IOException {
        String upstreamUrl = spec.url;
        if (isSeg) {
            String uParam = extractQueryParam(target, "u");
            if (uParam == null || uParam.isEmpty()) {
                writeSimpleResponse(rawOut, 400, "Bad Request", null);
                return;
            }
            upstreamUrl = uParam;
        }

        HttpURLConnection conn = null;
        try {
            conn = openUpstream(upstreamUrl, spec.headers, null);
            int status = conn.getResponseCode();
            if (status >= 400) {
                writeSimpleResponse(rawOut, status, "Upstream Error", null);
                return;
            }
            String finalUrl = conn.getURL() != null ? conn.getURL().toString() : upstreamUrl;
            String ct = conn.getContentType();
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            try (InputStream in = conn.getInputStream()) {
                byte[] chunk = new byte[16384];
                int n;
                while ((n = in.read(chunk)) != -1) {
                    buffer.write(chunk, 0, n);
                }
            }
            byte[] bytes = buffer.toByteArray();
            boolean isManifest = !isSeg
                || finalUrl.contains(".m3u8")
                || (ct != null && ct.toLowerCase(Locale.US).contains("mpegurl"))
                || (bytes.length >= 7 && new String(bytes, 0, 7, StandardCharsets.US_ASCII).equals("#EXTM3U"));

            if (isManifest) {
                String text = new String(bytes, StandardCharsets.UTF_8);
                byte[] rewritten = rewriteM3u8Playlist(text, finalUrl, streamId).getBytes(StandardCharsets.UTF_8);
                String hdr = "HTTP/1.1 200 OK\r\n" +
                    "Content-Type: application/vnd.apple.mpegurl\r\n" +
                    "Content-Length: " + rewritten.length + "\r\n" +
                    "Cache-Control: no-store\r\n" +
                    "Access-Control-Allow-Origin: *\r\n" +
                    "Connection: close\r\n\r\n";
                rawOut.write(hdr.getBytes(StandardCharsets.US_ASCII));
                rawOut.write(rewritten);
                rawOut.flush();
                return;
            }

            String hdr = "HTTP/1.1 200 OK\r\n" +
                "Content-Type: " + (ct != null ? ct : "video/mp2t") + "\r\n" +
                "Content-Length: " + bytes.length + "\r\n" +
                "Cache-Control: no-store\r\n" +
                "Access-Control-Allow-Origin: *\r\n" +
                "Connection: close\r\n\r\n";
            rawOut.write(hdr.getBytes(StandardCharsets.US_ASCII));
            rawOut.write(bytes);
            rawOut.flush();
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private void handleProxyClient(Socket client) {
        try {
            client.setSoTimeout(30000);
            client.setTcpNoDelay(true);
            BufferedReader reader = new BufferedReader(
                new InputStreamReader(client.getInputStream(), StandardCharsets.US_ASCII)
            );
            OutputStream rawOut = new BufferedOutputStream(client.getOutputStream(), 65536);

            String requestLine = reader.readLine();
            if (requestLine == null || requestLine.isEmpty()) return;

            String[] reqParts = requestLine.split(" ");
            if (reqParts.length < 2) {
                writeSimpleResponse(rawOut, 400, "Bad Request", null);
                return;
            }
            String method = reqParts[0].toUpperCase(Locale.US);
            String target = reqParts[1];

            String rangeHeader = null;
            String line;
            while ((line = reader.readLine()) != null && !line.isEmpty()) {
                int colon = line.indexOf(':');
                if (colon > 0) {
                    String name = line.substring(0, colon).trim();
                    if (name.equalsIgnoreCase("Range")) {
                        rangeHeader = line.substring(colon + 1).trim();
                    }
                }
            }

            if ("OPTIONS".equals(method)) {
                writeSimpleResponse(rawOut, 204, "No Content", "Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\nAccess-Control-Allow-Headers: *\r\n");
                return;
            }
            if (!"GET".equals(method) && !"HEAD".equals(method)) {
                writeSimpleResponse(rawOut, 405, "Method Not Allowed", null);
                return;
            }

            String streamId = extractQueryParam(target, "id");
            StreamSpec spec = streamId != null ? streamRegistry.get(streamId) : null;
            if (spec == null) {
                writeSimpleResponse(rawOut, 404, "Not Found", null);
                return;
            }

            if (target.startsWith("/hls-seg")) {
                handleHlsRequest(target, spec, streamId, rawOut, true);
                return;
            }
            if (target.startsWith("/hls")) {
                handleHlsRequest(target, spec, streamId, rawOut, false);
                return;
            }

            if (spec.totalLength <= 0) {
                probeStreamMeta(spec);
            }
            long total = spec.totalLength;
            if (total <= 0) {
                writeSimpleResponse(rawOut, 502, "Bad Gateway", null);
                return;
            }

            long reqStart = 0;
            long reqEnd = total - 1;
            boolean hasRange = false;
            if (rangeHeader != null) {
                Matcher rm = RANGE_BYTES_PATTERN.matcher(rangeHeader);
                if (rm.find()) {
                    hasRange = true;
                    String sPart = rm.group(1);
                    String ePart = rm.group(2);
                    if (sPart != null && !sPart.isEmpty()) {
                        reqStart = Long.parseLong(sPart);
                        reqEnd = (ePart != null && !ePart.isEmpty()) ? Math.min(Long.parseLong(ePart), total - 1) : (total - 1);
                    } else if (ePart != null && !ePart.isEmpty()) {
                        long suffix = Long.parseLong(ePart);
                        reqStart = Math.max(0, total - suffix);
                        reqEnd = total - 1;
                    }
                }
            }

            if (reqStart < 0 || reqStart >= total || reqEnd < reqStart) {
                writeSimpleResponse(rawOut, 416, "Range Not Satisfiable", "Content-Range: bytes */" + total + "\r\n");
                return;
            }

            long contentLen = (reqEnd - reqStart) + 1;
            StringBuilder respHdr = new StringBuilder();
            if (hasRange) {
                respHdr.append("HTTP/1.1 206 Partial Content\r\n");
                respHdr.append("Content-Range: bytes ").append(reqStart).append('-').append(reqEnd).append('/').append(total).append("\r\n");
            } else {
                respHdr.append("HTTP/1.1 200 OK\r\n");
            }
            respHdr.append("Accept-Ranges: bytes\r\n");
            respHdr.append("Content-Type: ").append(spec.mimeType).append("\r\n");
            respHdr.append("Content-Length: ").append(contentLen).append("\r\n");
            respHdr.append("Cache-Control: no-store\r\n");
            respHdr.append("Access-Control-Allow-Origin: *\r\n");
            respHdr.append("Connection: close\r\n\r\n");

            rawOut.write(respHdr.toString().getBytes(StandardCharsets.US_ASCII));
            rawOut.flush();

            if ("HEAD".equals(method)) {
                return;
            }

            streamChunkedBody(spec, reqStart, reqEnd, rawOut, null);
            rawOut.flush();
        } catch (IOException ignored) {
            // Normal when WebView cancels preload or seeks
        } finally {
            try {
                client.close();
            } catch (IOException ignored) {}
        }
    }

    private interface ProgressCallback {
        void onBytes(long copied, long total);
    }

    private static void streamChunkedBody(
        StreamSpec spec,
        long start,
        long end,
        OutputStream clientOut,
        ProgressCallback cb
    ) throws IOException {
        long cursor = start;
        long totalToCopy = (end - start) + 1;
        long totalCopied = 0;
        byte[] buf = new byte[65536];

        // First attempt a single continuous upstream Range request (fast path: 1 TLS handshake for seek/playback)
        if (cb == null && totalToCopy > 65536L) {
            HttpURLConnection directConn = null;
            boolean directAborted = false;
            try {
                directConn = openUpstream(spec.url, spec.headers, "bytes=" + cursor + "-" + end);
                int directStatus = directConn.getResponseCode();
                if (directStatus == 200 || directStatus == 206) {
                    try (InputStream in = directConn.getInputStream()) {
                        int n;
                        long flushAcc = 0;
                        boolean firstFlush = false;
                        while (cursor <= end && (n = in.read(buf, 0, (int) Math.min(buf.length, (end - cursor) + 1))) != -1) {
                            clientOut.write(buf, 0, n);
                            cursor += n;
                            totalCopied += n;
                            flushAcc += n;
                            if (!firstFlush || flushAcc >= 262144L) {
                                clientOut.flush();
                                firstFlush = true;
                                flushAcc = 0;
                            }
                        }
                        clientOut.flush();
                    }
                    if (cursor > end) {
                        return;
                    }
                } else {
                    directAborted = true;
                }
            } catch (IOException ioe) {
                directAborted = true;
                // Client disconnected (e.g. user dragged scrubber again): propagate immediately
                if (totalCopied > 0 && cursor <= end) {
                    throw ioe;
                }
            } finally {
                if (directConn != null && (directAborted || cursor <= end)) {
                    directConn.disconnect();
                }
            }
        }

        long chunkSpan = (spec.totalLength > 0 && spec.totalLength < 35_000_000L) ? 1_048_576L : 4_194_304L;
        while (cursor <= end) {
            long subEnd = Math.min(cursor + chunkSpan - 1, end);
            HttpURLConnection conn = null;
            boolean cleanDone = false;
            try {
                conn = openUpstream(spec.url, spec.headers, "bytes=" + cursor + "-" + subEnd);
                int status = conn.getResponseCode();
                if (status == 403 && chunkSpan > 65_536L) {
                    chunkSpan = chunkSpan / 2L;
                    continue;
                }
                if (status != 200 && status != 206) {
                    throw new IOException("Upstream HTTP " + status);
                }
                long expected = (subEnd - cursor) + 1;
                long received = 0;
                try (InputStream in = conn.getInputStream()) {
                    int n;
                    while (received < expected && (n = in.read(buf, 0, (int) Math.min(buf.length, expected - received))) != -1) {
                        clientOut.write(buf, 0, n);
                        received += n;
                        totalCopied += n;
                        if (cb != null) cb.onBytes(totalCopied, totalToCopy);
                    }
                    clientOut.flush();
                }
                cleanDone = (received == expected);
                if (received <= 0) {
                    break;
                }
                cursor += received;
            } finally {
                if (conn != null && !cleanDone) conn.disconnect();
            }
        }
    }

    private static String extractQueryParam(String target, String key) {
        int q = target.indexOf('?');
        if (q < 0) return null;
        String query = target.substring(q + 1);
        for (String pair : query.split("&")) {
            int eq = pair.indexOf('=');
            if (eq > 0 && pair.substring(0, eq).equals(key)) {
                try {
                    return URLDecoder.decode(pair.substring(eq + 1), "UTF-8");
                } catch (Exception e) {
                    return pair.substring(eq + 1);
                }
            }
        }
        return null;
    }

    private JSObject registerStreamInternal(PluginCall call, String pathPrefix) {
        String url = call.getString("url", "");
        if (url == null || url.isEmpty()) {
            call.reject("Missing url");
            return null;
        }
        int port = ensureProxyStarted();
        if (port <= 0) {
            call.reject("Failed to start local media proxy");
            return null;
        }
        Map<String, String> headers = toHeaderMap(call.getObject("headers", new JSObject()));
        long contentLength = 0L;
        Object rawLen = call.getData().opt("contentLength");
        if (rawLen instanceof Number) {
            contentLength = ((Number) rawLen).longValue();
        } else if (rawLen != null) {
            try {
                contentLength = Long.parseLong(String.valueOf(rawLen));
            } catch (Exception ignored) {}
        }
        String mimeType = call.getString("mimeType", "video/mp4");

        pruneRegistryIfNeeded();
        String id = UUID.randomUUID().toString().replace("-", "").substring(0, 16);
        streamRegistry.put(id, new StreamSpec(url, headers, contentLength, mimeType));

        JSObject out = new JSObject();
        out.put("proxyUrl", "http://127.0.0.1:" + port + pathPrefix + "?id=" + id);
        return out;
    }

    @PluginMethod
    public void registerStream(PluginCall call) {
        JSObject out = registerStreamInternal(call, "/stream");
        if (out != null) call.resolve(out);
    }

    @PluginMethod
    public void registerHls(PluginCall call) {
        JSObject out = registerStreamInternal(call, "/hls");
        if (out != null) call.resolve(out);
    }

    @PluginMethod
    public void downloadToDevice(PluginCall call) {
        String url = call.getString("url", "");
        String rawName = call.getString("filename", "puretube_media.mp4");
        String mimeType = call.getString("mimeType", "video/mp4");
        if (url == null || url.isEmpty()) {
            call.reject("Missing url");
            return;
        }
        String safeName = rawName.replaceAll("[\\\\/:*?\"<>|]+", "_").trim();
        if (safeName.isEmpty()) safeName = "puretube_media.mp4";
        final String finalName = safeName;
        final Map<String, String> headers = toHeaderMap(call.getObject("headers", new JSObject()));
        long rawLen = 0L;
        Object lenObj = call.getData().opt("contentLength");
        if (lenObj instanceof Number) rawLen = ((Number) lenObj).longValue();
        final long initLen = rawLen;

        executor.execute(() -> {
            StreamSpec spec = new StreamSpec(url, headers, initLen, mimeType);
            if (spec.totalLength <= 0) {
                probeStreamMeta(spec);
            }
            if (spec.totalLength <= 0) {
                call.reject("Không xác định được kích thước tệp để tải về.");
                return;
            }
            Context ctx = getContext();
            if (ctx == null) {
                call.reject("No application context");
                return;
            }

            final int[] lastPct = new int[]{-1};
            ProgressCallback pcb = (copied, total) -> {
                if (total > 0) {
                    int pct = (int) Math.min(100, (copied * 100L) / total);
                    if (pct >= lastPct[0] + 5 || pct == 100) {
                        lastPct[0] = pct;
                        JSObject prog = new JSObject();
                        prog.put("filename", finalName);
                        prog.put("percent", pct);
                        notifyListeners("downloadProgress", prog);
                    }
                }
            };

            try {
                String savedPath;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ContentResolver resolver = ctx.getContentResolver();
                    ContentValues cv = new ContentValues();
                    cv.put(MediaStore.MediaColumns.DISPLAY_NAME, finalName);
                    cv.put(MediaStore.MediaColumns.MIME_TYPE, mimeType);
                    cv.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/PureTube");
                    cv.put(MediaStore.MediaColumns.IS_PENDING, 1);
                    Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                    if (uri == null) {
                        throw new IOException("Không tạo được tệp trong thư mục Downloads.");
                    }
                    try (OutputStream os = new BufferedOutputStream(resolver.openOutputStream(uri), 32768)) {
                        streamChunkedBody(spec, 0, spec.totalLength - 1, os, pcb);
                        os.flush();
                    } catch (IOException ex) {
                        resolver.delete(uri, null, null);
                        throw ex;
                    }
                    ContentValues done = new ContentValues();
                    done.put(MediaStore.MediaColumns.IS_PENDING, 0);
                    resolver.update(uri, done, null, null);
                    savedPath = "Downloads/PureTube/" + finalName;
                } else {
                    File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "PureTube");
                    if (!dir.exists()) dir.mkdirs();
                    File outFile = new File(dir, finalName);
                    try (OutputStream os = new BufferedOutputStream(new FileOutputStream(outFile), 32768)) {
                        streamChunkedBody(spec, 0, spec.totalLength - 1, os, pcb);
                        os.flush();
                    }
                    savedPath = outFile.getAbsolutePath();
                }

                JSObject res = new JSObject();
                res.put("filename", finalName);
                res.put("savedPath", savedPath);
                res.put("bytes", spec.totalLength);
                call.resolve(res);
            } catch (Exception ex) {
                call.reject("Lỗi tải tệp offline: " + ex.getMessage(), ex);
            }
        });
    }

    @PluginMethod
    public void updateMediaNotification(PluginCall call) {
        Context ctx = getContext();
        if (ctx == null) {
            call.resolve();
            return;
        }
        boolean clear = Boolean.TRUE.equals(call.getBoolean("clear", false));
        try {
            Intent intent = new Intent(ctx, PureTubeMediaService.class);
            if (clear) {
                intent.setAction(PureTubeMediaService.ACTION_STOP);
                ctx.startService(intent);
            } else {
                intent.setAction(PureTubeMediaService.ACTION_UPDATE);
                intent.putExtra("title", call.getString("title", "PureTube"));
                intent.putExtra("artist", call.getString("artist", "Đang phát"));
                intent.putExtra("playing", Boolean.TRUE.equals(call.getBoolean("playing", true)));
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    ctx.startForegroundService(intent);
                } else {
                    ctx.startService(intent);
                }
            }
        } catch (Exception ignored) {}
        call.resolve();
    }

    private void executeRequest(
        PluginCall call,
        String method,
        String urlStr,
        JSObject headersObj,
        byte[] bodyBytes,
        boolean asBase64
    ) {
        if (urlStr == null || urlStr.isEmpty()) {
            call.reject("Missing url");
            return;
        }
        executor.execute(() -> {
            HttpURLConnection conn = null;
            try {
                URL url = new URL(urlStr);
                conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod(method);
                conn.setConnectTimeout(15000);
                conn.setReadTimeout(20000);
                conn.setInstanceFollowRedirects(true);

                if (headersObj != null) {
                    Iterator<String> keys = headersObj.keys();
                    while (keys.hasNext()) {
                        String key = keys.next();
                        String val = headersObj.getString(key);
                        if (val != null && !key.equalsIgnoreCase("accept-encoding")) {
                            conn.setRequestProperty(key, val);
                        }
                    }
                }

                if (bodyBytes != null) {
                    conn.setDoOutput(true);
                    try (OutputStream os = conn.getOutputStream()) {
                        os.write(bodyBytes);
                    }
                }

                int status = conn.getResponseCode();
                InputStream stream = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
                byte[] bytes = new byte[0];
                if (stream != null) {
                    ByteArrayOutputStream buffer = new ByteArrayOutputStream();
                    byte[] chunk = new byte[16384];
                    int read;
                    while ((read = stream.read(chunk)) != -1) {
                        buffer.write(chunk, 0, read);
                    }
                    stream.close();
                    bytes = buffer.toByteArray();
                }

                JSObject result = new JSObject();
                result.put("status", status);
                if (asBase64) {
                    String ctype = conn.getContentType();
                    result.put("contentType", ctype != null ? ctype : "application/octet-stream");
                    result.put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP));
                } else {
                    result.put("body", new String(bytes, StandardCharsets.UTF_8));
                }
                call.resolve(result);
            } catch (Exception ex) {
                call.reject("Native HTTP error: " + ex.getMessage(), ex);
            } finally {
                if (conn != null) {
                    conn.disconnect();
                }
            }
        });
    }

    @PluginMethod
    public void httpGet(PluginCall call) {
        String url = call.getString("url", "");
        JSObject headers = call.getObject("headers", new JSObject());
        executeRequest(call, "GET", url, headers, null, false);
    }

    @PluginMethod
    public void httpGetBase64(PluginCall call) {
        String url = call.getString("url", "");
        JSObject headers = call.getObject("headers", new JSObject());
        executeRequest(call, "GET", url, headers, null, true);
    }

    @PluginMethod
    public void httpPostJson(PluginCall call) {
        String url = call.getString("url", "");
        String body = call.getString("body", "{}");
        JSObject headers = call.getObject("headers", new JSObject());
        if (!headers.has("Content-Type")) {
            headers.put("Content-Type", "application/json");
        }
        byte[] bytes = body != null ? body.getBytes(StandardCharsets.UTF_8) : new byte[0];
        executeRequest(call, "POST", url, headers, bytes, false);
    }

    @PluginMethod
    public void httpPostForm(PluginCall call) {
        String url = call.getString("url", "");
        JSObject form = call.getObject("form", new JSObject());
        JSObject headers = call.getObject("headers", new JSObject());
        headers.put("Content-Type", "application/x-www-form-urlencoded");
        try {
            StringBuilder sb = new StringBuilder();
            Iterator<String> keys = form.keys();
            while (keys.hasNext()) {
                String k = keys.next();
                String v = form.getString(k, "");
                if (sb.length() > 0) sb.append('&');
                sb.append(URLEncoder.encode(k, "UTF-8")).append('=').append(URLEncoder.encode(v != null ? v : "", "UTF-8"));
            }
            executeRequest(call, "POST", url, headers, sb.toString().getBytes(StandardCharsets.UTF_8), false);
        } catch (Exception ex) {
            call.reject("Form encode error: " + ex.getMessage(), ex);
        }
    }
}
