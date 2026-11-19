package com.puretube.app;

import android.net.Uri;
import android.webkit.WebResourceResponse;
import java.io.ByteArrayInputStream;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

public final class AdBlockFilter {
    private static final Set<String> BLOCKED_HOSTS = new HashSet<>(Arrays.asList(
        "doubleclick.net",
        "googlesyndication.com",
        "googleadservices.com",
        "google-analytics.com",
        "googletagmanager.com",
        "adservice.google.com",
        "adservice.google.com.vn",
        "ads.youtube.com",
        "s0.2mdn.net",
        "pagead2.googlesyndication.com",
        "tpc.googlesyndication.com",
        "pubads.g.doubleclick.net",
        "securepubads.g.doubleclick.net"
    ));

    private AdBlockFilter() {}

    private static boolean hostMatchesDomain(String host, String domain) {
        return host.equals(domain) || host.endsWith("." + domain);
    }

    public static boolean shouldBlock(Uri uri) {
        if (uri == null) return false;
        String rawHost = uri.getHost();
        if (rawHost == null || rawHost.isEmpty()) return false;
        String host = rawHost.toLowerCase(Locale.ROOT);
        String path = uri.getPath() != null ? uri.getPath().toLowerCase(Locale.ROOT) : "";
        String query = uri.getQuery() != null ? uri.getQuery().toLowerCase(Locale.ROOT) : "";

        // Never block YouTube Watch History tracking, video media CDN, thumbnails, or Google Auth
        if (path.contains("/api/stats/watchtime") || path.contains("/api/stats/playback")) {
            return false;
        }
        if (hostMatchesDomain(host, "accounts.google.com")
            || hostMatchesDomain(host, "accounts.youtube.com")
            || hostMatchesDomain(host, "myaccount.google.com")
            || hostMatchesDomain(host, "oauth2.googleapis.com")
            || hostMatchesDomain(host, "googlevideo.com")
            || hostMatchesDomain(host, "i.ytimg.com")
            || hostMatchesDomain(host, "yt3.ggpht.com")
            || hostMatchesDomain(host, "sponsor.ajay.app")) {
            return false;
        }

        for (String blocked : BLOCKED_HOSTS) {
            if (hostMatchesDomain(host, blocked)) {
                return true;
            }
        }

        if (hostMatchesDomain(host, "youtube.com")) {
            if (path.contains("/pagead/")
                || path.contains("/api/stats/ads")
                || path.contains("/api/stats/atr")
                || path.contains("/ptracking")
                || path.contains("/get_midroll_info")
                || path.contains("/youtubei/v1/ad_break")) {
                return true;
            }
            if (query.contains("adformat=") || query.contains("ctier=l")) {
                return true;
            }
        }

        return false;
    }

    public static WebResourceResponse emptyBlockedResponse() {
        return new WebResourceResponse("text/plain", "utf-8", new ByteArrayInputStream(new byte[0]));
    }
}
