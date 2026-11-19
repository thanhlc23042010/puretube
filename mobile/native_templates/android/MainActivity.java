package com.puretube.app;

import android.Manifest;
import android.app.PictureInPictureParams;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.content.res.ColorStateList;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Rational;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.Toast;
import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.puretube.nativebridge.PureTubeMediaService;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

public class MainActivity extends AppCompatActivity {
    private static final String HOME_URL = "https://m.youtube.com";
    private static final int REQ_NOTIF_PERM = 9101;
    private static final Set<String> YT_SCRIPT_ORIGINS = new HashSet<>(Arrays.asList(
        "https://m.youtube.com",
        "https://www.youtube.com",
        "https://music.youtube.com"
    ));

    private BackgroundWebView webView;
    private FrameLayout fullscreenContainer;
    private ProgressBar loadingBar;
    private View customVideoView = null;
    private WebChromeClient.CustomViewCallback customViewCallback = null;

    private String injectScript = "";
    private volatile boolean adBlockEnabled = true;
    private volatile boolean backgroundPlayEnabled = true;
    private volatile boolean mediaServiceStarted = false;
    private long lastBackPressAt = 0L;
    private final Handler uiHandler = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        WindowCompat.setDecorFitsSystemWindows(getWindow(), true);
        getWindow().setStatusBarColor(Color.parseColor("#0F0F0F"));
        getWindow().setNavigationBarColor(Color.parseColor("#0F0F0F"));
        WindowInsetsControllerCompat insetsCtrl = WindowCompat.getInsetsController(
            getWindow(),
            getWindow().getDecorView()
        );
        if (insetsCtrl != null) {
            insetsCtrl.setAppearanceLightStatusBars(false);
            insetsCtrl.setAppearanceLightNavigationBars(false);
        }

        injectScript = loadAssetScript("puretube_inject.js");

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0F0F0F"));

        webView = new BackgroundWebView(this);
        webView.setBackgroundColor(Color.parseColor("#0F0F0F"));
        webView.setLayoutParams(new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ));

        fullscreenContainer = new FrameLayout(this);
        fullscreenContainer.setBackgroundColor(Color.BLACK);
        fullscreenContainer.setVisibility(View.GONE);
        fullscreenContainer.setLayoutParams(new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ));

        loadingBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        loadingBar.setIndeterminate(true);
        loadingBar.setIndeterminateTintList(ColorStateList.valueOf(Color.parseColor("#FF0033")));
        FrameLayout.LayoutParams barLp = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            Math.max(4, (int) (getResources().getDisplayMetrics().density * 2.5f))
        );
        barLp.gravity = Gravity.TOP;
        loadingBar.setLayoutParams(barLp);
        loadingBar.setVisibility(View.GONE);

        root.addView(webView);
        root.addView(fullscreenContainer);
        root.addView(loadingBar);
        setContentView(root);

        configureWebView();
        bindMediaServiceCallbacks();
        setupBackNavigation();
        requestNotificationPermissionIfNeeded();

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            String initialUrl = extractYouTubeUrl(getIntent());
            webView.loadUrl(initialUrl != null ? initialUrl : HOME_URL);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String url = extractYouTubeUrl(intent);
        if (url != null && webView != null) {
            webView.loadUrl(url);
        }
    }

    private String loadAssetScript(String filename) {
        StringBuilder sb = new StringBuilder();
        try (InputStream is = getAssets().open(filename);
             BufferedReader br = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8))) {
            String line;
            while ((line = br.readLine()) != null) {
                sb.append(line).append('\n');
            }
        } catch (Exception ignored) {}
        return sb.toString();
    }

    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setAllowFileAccess(false);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);

        // Strip WebView token "; wv" so accounts.google.com allows native login cleanly
        String rawUa = settings.getUserAgentString();
        if (rawUa != null && !rawUa.isEmpty()) {
            String cleanUa = rawUa
                .replace("; wv)", ")")
                .replace("; wv;", ";")
                .replace("; wv", "")
                .replace("Version/4.0 ", "");
            settings.setUserAgentString(cleanUa);
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        }

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(webView, true);

        webView.addJavascriptInterface(new HostBridge(), "PureTubeHost");

        if (!injectScript.isEmpty()) {
            try {
                if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                    WebViewCompat.addDocumentStartJavaScript(webView, injectScript, YT_SCRIPT_ORIGINS);
                }
            } catch (Throwable ignored) {}
        }

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (adBlockEnabled && request != null && AdBlockFilter.shouldBlock(request.getUrl())) {
                    return AdBlockFilter.emptyBlockedResponse();
                }
                return super.shouldInterceptRequest(view, request);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (request == null || request.getUrl() == null) return false;
                Uri uri = request.getUrl();
                String scheme = uri.getScheme() != null ? uri.getScheme().toLowerCase(Locale.ROOT) : "";

                if ("intent".equals(scheme)) {
                    String ytFallback = resolveIntentToYouTubeUrl(uri.toString());
                    if (ytFallback != null) {
                        view.loadUrl(ytFallback);
                    }
                    return true;
                }

                if ("http".equals(scheme) || "https".equals(scheme)) {
                    String host = uri.getHost() != null ? uri.getHost().toLowerCase(Locale.ROOT) : "";
                    if (isAllowedInAppHost(host)) {
                        return false;
                    }
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, uri));
                    } catch (Exception ignored) {}
                    return true;
                }

                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                loadingBar.setVisibility(View.VISIBLE);
                super.onPageStarted(view, url, favicon);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                loadingBar.setVisibility(View.GONE);
                if (!injectScript.isEmpty() && isYouTubePageUrl(url)) {
                    view.evaluateJavascript(injectScript, null);
                }
                try {
                    CookieManager.getInstance().flush();
                } catch (Exception ignored) {}
                super.onPageFinished(view, url);
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (customVideoView != null) {
                    if (callback != null) callback.onCustomViewHidden();
                    return;
                }
                customVideoView = view;
                customViewCallback = callback;
                webView.setVisibility(View.GONE);
                fullscreenContainer.setVisibility(View.VISIBLE);
                fullscreenContainer.addView(view, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
                ));
                getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
                WindowInsetsControllerCompat ctrl = WindowCompat.getInsetsController(
                    getWindow(),
                    getWindow().getDecorView()
                );
                if (ctrl != null) {
                    ctrl.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                    ctrl.hide(WindowInsetsCompat.Type.systemBars());
                }
            }

            @Override
            public void onHideCustomView() {
                exitCustomFullscreen();
            }
        });
    }

    private void exitCustomFullscreen() {
        if (customVideoView == null) return;
        fullscreenContainer.removeView(customVideoView);
        fullscreenContainer.setVisibility(View.GONE);
        customVideoView = null;
        if (customViewCallback != null) {
            try {
                customViewCallback.onCustomViewHidden();
            } catch (Exception ignored) {}
            customViewCallback = null;
        }
        webView.setVisibility(View.VISIBLE);
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        WindowInsetsControllerCompat ctrl = WindowCompat.getInsetsController(
            getWindow(),
            getWindow().getDecorView()
        );
        if (ctrl != null) {
            ctrl.show(WindowInsetsCompat.Type.systemBars());
        }
    }

    private void bindMediaServiceCallbacks() {
        PureTubeMediaService.actionListener = action -> uiHandler.post(() -> {
            if (webView == null || action == null) return;
            String safeAct = action.replace("'", "");
            webView.evaluateJavascript(
                "if(window.__puretubeMediaControl){window.__puretubeMediaControl('" + safeAct + "');}",
                null
            );
        });
    }

    private void setupBackNavigation() {
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (customVideoView != null) {
                    exitCustomFullscreen();
                    return;
                }
                if (webView != null && webView.canGoBack()) {
                    webView.goBack();
                    return;
                }
                long now = System.currentTimeMillis();
                if (now - lastBackPressAt < 2000L) {
                    finish();
                } else {
                    lastBackPressAt = now;
                    Toast.makeText(
                        MainActivity.this,
                        "Bấm Quay lại lần nữa để thoát PureTube",
                        Toast.LENGTH_SHORT
                    ).show();
                }
            }
        });
    }

    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= 33) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(
                    this,
                    new String[] { Manifest.permission.POST_NOTIFICATIONS },
                    REQ_NOTIF_PERM
                );
            }
        }
    }

    private static boolean hostIsDomain(String host, String domain) {
        return host.equals(domain) || host.endsWith("." + domain);
    }

    private static boolean isYouTubePageUrl(String url) {
        if (url == null) return false;
        Uri uri = Uri.parse(url);
        String host = uri.getHost() != null ? uri.getHost().toLowerCase(Locale.ROOT) : "";
        return hostIsDomain(host, "youtube.com") || hostIsDomain(host, "youtu.be");
    }

    private static boolean isAllowedInAppHost(String host) {
        if (host.isEmpty()) return false;
        return hostIsDomain(host, "youtube.com")
            || hostIsDomain(host, "youtu.be")
            || hostIsDomain(host, "youtube-nocookie.com")
            || hostIsDomain(host, "google.com")
            || hostIsDomain(host, "google.com.vn")
            || hostIsDomain(host, "gstatic.com")
            || hostIsDomain(host, "googleapis.com")
            || hostIsDomain(host, "googleusercontent.com")
            || hostIsDomain(host, "ytimg.com")
            || hostIsDomain(host, "ggpht.com");
    }

    private static String extractYouTubeUrl(Intent intent) {
        if (intent == null) return null;
        Uri data = intent.getData();
        if (data != null) {
            String host = data.getHost() != null ? data.getHost().toLowerCase(Locale.ROOT) : "";
            if (hostIsDomain(host, "youtube.com") || hostIsDomain(host, "youtu.be")) {
                return data.toString().replace("://www.youtube.com", "://m.youtube.com");
            }
        }
        String sharedText = intent.getStringExtra(Intent.EXTRA_TEXT);
        if (sharedText != null && (sharedText.contains("youtube.com") || sharedText.contains("youtu.be"))) {
            for (String token : sharedText.split("\\s+")) {
                if (token.startsWith("http://") || token.startsWith("https://")) {
                    if (isYouTubePageUrl(token)) {
                        return token.replace("://www.youtube.com", "://m.youtube.com");
                    }
                }
            }
        }
        return null;
    }

    private static String resolveIntentToYouTubeUrl(String intentUrl) {
        try {
            Intent parsed = Intent.parseUri(intentUrl, Intent.URI_INTENT_SCHEME);
            String fallback = parsed.getStringExtra("browser_fallback_url");
            if (fallback != null && isYouTubePageUrl(fallback)) {
                return fallback;
            }
            if (parsed.getDataString() != null && isYouTubePageUrl(parsed.getDataString())) {
                return parsed.getDataString();
            }
        } catch (Exception ignored) {}
        return null;
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) {
            webView.saveState(outState);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) {
            webView.onResume();
            webView.resumeTimers();
        }
    }

    @Override
    protected void onPause() {
        try {
            CookieManager.getInstance().flush();
        } catch (Exception ignored) {}
        if (!backgroundPlayEnabled && webView != null) {
            webView.onPause();
            webView.pauseTimers();
        }
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        PureTubeMediaService.actionListener = null;
        if (!isChangingConfigurations() && mediaServiceStarted) {
            try {
                Intent stopIntent = new Intent(this, PureTubeMediaService.class);
                stopIntent.setAction(PureTubeMediaService.ACTION_STOP);
                startService(stopIntent);
                mediaServiceStarted = false;
            } catch (Exception ignored) {}
        }
        if (webView != null && isFinishing()) {
            webView.destroy();
        }
        super.onDestroy();
    }

    public final class HostBridge {
        @JavascriptInterface
        public void onMediaState(String title, String artist, boolean playing) {
            uiHandler.post(() -> {
                if (!playing && !mediaServiceStarted) {
                    return;
                }
                if (!backgroundPlayEnabled && playing) {
                    return;
                }
                try {
                    Intent svc = new Intent(MainActivity.this, PureTubeMediaService.class);
                    svc.setAction(PureTubeMediaService.ACTION_UPDATE);
                    svc.putExtra("title", title != null ? title : "PureTube");
                    svc.putExtra("artist", artist != null ? artist : "YouTube");
                    svc.putExtra("playing", playing);
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !mediaServiceStarted) {
                        ContextCompat.startForegroundService(MainActivity.this, svc);
                    } else {
                        startService(svc);
                    }
                    mediaServiceStarted = true;
                } catch (Exception ignored) {}
            });
        }

        @JavascriptInterface
        public void setBackgroundPlay(boolean enabled) {
            backgroundPlayEnabled = enabled;
            uiHandler.post(() -> {
                if (webView != null) {
                    webView.setKeepAliveInBackground(enabled);
                }
            });
        }

        @JavascriptInterface
        public void setAdBlockEnabled(boolean enabled) {
            adBlockEnabled = enabled;
        }

        @JavascriptInterface
        public void enterPip() {
            uiHandler.post(() -> {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    try {
                        PictureInPictureParams params = new PictureInPictureParams.Builder()
                            .setAspectRatio(new Rational(16, 9))
                            .build();
                        enterPictureInPictureMode(params);
                    } catch (Exception ignored) {}
                }
            });
        }
    }
}
