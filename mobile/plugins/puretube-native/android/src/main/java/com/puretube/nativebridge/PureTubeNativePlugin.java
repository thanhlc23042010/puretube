package com.puretube.nativebridge;

import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "PureTubeNative")
public class PureTubeNativePlugin extends Plugin {
    private final ExecutorService executor = Executors.newCachedThreadPool();

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
