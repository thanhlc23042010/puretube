package com.puretube.app;

import android.annotation.SuppressLint;
import android.app.PictureInPictureParams;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.util.Rational;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import com.puretube.nativebridge.PureTubeMediaService;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Locale;

public class MainActivity extends AppCompatActivity {
    private static final String PREFS_NAME = "puretube_native_prefs";
    private static final String KEY_BG_PLAY = "bg_play";
    private static final String KEY_AD_BLOCK = "ad_block";
    private static final String KEY_PLAYER_STATE = "player_state";
    private static final String KEY_PLAYER_URL = "player_url";
    private static final String YOUTUBE_HOME = "https://m.youtube.com";
    private static final String MOBILE_UA =
            "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 "
                    + "(KHTML, like Gecko) Chrome/126.0.6478.122 Mobile Safari/537.36";

    private enum PlayerState {
        HIDDEN,
        EXPANDED,
        MINI
    }

    private FrameLayout rootFrame;
    private SwipeRefreshLayout swipeRefresh;
    private BackgroundWebView browseWebView;
    private BackgroundWebView playerWebView;
    private View playerBackdrop;
    private LinearLayout playerTopBar;
    private TextView playerTopTitle;
    private LinearLayout miniBarChrome;
    private View miniProgressTrack;
    private View miniProgressView;
    private TextView miniTitleView;
    private TextView miniArtistView;
    private TextView miniPlayPauseBtn;
    private View miniVideoTouchShield;
    private FrameLayout fullscreenContainer;

    private WebChromeClient.CustomViewCallback customViewCallback;
    private View customFullscreenView;
    private WebChromeClient roleWebChromeClient;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private Runnable refreshFailsafeRunnable;

    private String injectScriptSource = "";
    private PlayerState playerState = PlayerState.HIDDEN;
    private volatile boolean backgroundPlayEnabled = true;
    private volatile boolean adBlockEnabled = true;
    private volatile boolean browseInShorts = false;
    private boolean mediaIsPlaying = false;
    private int currentProgressPermille = 0;
    private String currentVideoUrl = "";
    private String currentVideoId = "";
    private String currentTitle = "PureTube";
    private String currentArtist = "YouTube";
    private long lastBackPressMs = 0L;
    private boolean inPipMode = false;

    private float topBarDownRawY = 0f;
    private float topBarDownRawX = 0f;
    private float topBarLastDy = 0f;
    private boolean topBarDragging = false;
    private float touchSlopPx = 18f;

    @SuppressLint({"SetJavaScriptEnabled", "ClickableViewAccessibility"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        backgroundPlayEnabled = prefs.getBoolean(KEY_BG_PLAY, true);
        adBlockEnabled = prefs.getBoolean(KEY_AD_BLOCK, true);
        touchSlopPx = ViewConfiguration.get(this).getScaledTouchSlop();
        injectScriptSource = loadAssetText("puretube_inject.js");

        configureSystemBars();
        buildViewHierarchy();
        setContentView(rootFrame);

        setupMediaServiceListener();
        setupBackNavigation();

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(browseWebView, true);
        cm.setAcceptThirdPartyCookies(playerWebView, true);

        configureWebView(browseWebView, "browse");
        configureWebView(playerWebView, "player");

        playerWebView.setSwipeDownListener(new BackgroundWebView.SwipeDownListener() {
            @Override
            public void onDragProgress(float dyPx) {
                applyInteractiveDrag(dyPx);
            }

            @Override
            public void onDragEnd(boolean shouldMinimize) {
                finishInteractiveDrag(shouldMinimize);
            }
        });

        String initialBrowseUrl = YOUTUBE_HOME;
        String pendingVideoUrl = null;
        if (savedInstanceState != null) {
            Bundle browseState = savedInstanceState.getBundle("browse_state");
            if (browseState != null) {
                browseWebView.restoreState(browseState);
            } else {
                browseWebView.loadUrl(initialBrowseUrl);
            }
            String savedPlayerState = savedInstanceState.getString(KEY_PLAYER_STATE, PlayerState.HIDDEN.name());
            String savedVideoUrl = savedInstanceState.getString(KEY_PLAYER_URL, "");
            if (!TextUtils.isEmpty(savedVideoUrl) && !PlayerState.HIDDEN.name().equals(savedPlayerState)) {
                pendingVideoUrl = savedVideoUrl;
            }
        } else {
            String deepLink = extractYouTubeIntentUrl(getIntent());
            if (!TextUtils.isEmpty(deepLink)) {
                if (isWatchUrl(deepLink)) {
                    browseWebView.loadUrl(initialBrowseUrl);
                    pendingVideoUrl = normalizeWatchUrl(deepLink);
                } else {
                    browseWebView.loadUrl(deepLink);
                }
            } else {
                browseWebView.loadUrl(initialBrowseUrl);
            }
        }

        if (!TextUtils.isEmpty(pendingVideoUrl)) {
            final String targetVideo = pendingVideoUrl;
            final boolean startMini = savedInstanceState != null
                    && PlayerState.MINI.name().equals(savedInstanceState.getString(KEY_PLAYER_STATE, ""));
            mainHandler.post(() -> {
                openVideoInPlayer(targetVideo);
                if (startMini) {
                    minimizePlayer();
                }
            });
        } else {
            applyPlayerState(PlayerState.HIDDEN);
        }
    }

    private void configureSystemBars() {
        getWindow().setStatusBarColor(Color.parseColor("#0F0F0F"));
        getWindow().setNavigationBarColor(Color.parseColor("#0F0F0F"));
        WindowInsetsControllerCompat controller = new WindowInsetsControllerCompat(getWindow(), getWindow().getDecorView());
        controller.setAppearanceLightStatusBars(false);
        controller.setAppearanceLightNavigationBars(false);
    }

    @SuppressLint("ClickableViewAccessibility")
    private void buildViewHierarchy() {
        rootFrame = new FrameLayout(this);
        rootFrame.setBackgroundColor(Color.parseColor("#0F0F0F"));
        rootFrame.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        ));

        ViewCompat.setOnApplyWindowInsetsListener(rootFrame, (v, insets) -> {
            if (customFullscreenView != null || inPipMode) {
                v.setPadding(0, 0, 0, 0);
            } else {
                Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            }
            return insets;
        });

        browseWebView = new BackgroundWebView(this);
        swipeRefresh = new SwipeRefreshLayout(this);
        swipeRefresh.setColorSchemeColors(Color.parseColor("#FF0033"), Color.WHITE);
        swipeRefresh.setProgressBackgroundColorSchemeColor(Color.parseColor("#1F1F1F"));
        swipeRefresh.addView(browseWebView, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        ));
        swipeRefresh.setOnRefreshListener(() -> {
            if (browseWebView != null) {
                browseWebView.reload();
                scheduleRefreshFailsafe();
            } else {
                swipeRefresh.setRefreshing(false);
            }
        });
        swipeRefresh.setOnChildScrollUpCallback((parent, child) -> {
            if (browseWebView == null) return false;
            if (browseInShorts || isShortsUrl(browseWebView.getUrl())) return true;
            return browseWebView.getScrollY() > 0 || browseWebView.canScrollVertically(-1);
        });
        rootFrame.addView(swipeRefresh, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        ));

        playerBackdrop = new View(this);
        playerBackdrop.setBackgroundColor(Color.parseColor("#0F0F0F"));
        playerBackdrop.setClickable(true);
        playerBackdrop.setVisibility(View.GONE);
        rootFrame.addView(playerBackdrop, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        ));

        miniBarChrome = buildMiniBarChrome();
        rootFrame.addView(miniBarChrome);

        playerWebView = new BackgroundWebView(this);
        FrameLayout.LayoutParams playerParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        );
        playerParams.topMargin = dpToPx(44);
        playerWebView.setVisibility(View.GONE);
        rootFrame.addView(playerWebView, playerParams);

        miniVideoTouchShield = new View(this);
        miniVideoTouchShield.setBackgroundColor(Color.TRANSPARENT);
        miniVideoTouchShield.setClickable(true);
        miniVideoTouchShield.setVisibility(View.GONE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            miniVideoTouchShield.setElevation(dpToPx(12));
        }
        miniVideoTouchShield.setOnClickListener(v -> expandPlayer());
        FrameLayout.LayoutParams shieldParams = new FrameLayout.LayoutParams(dpToPx(106), dpToPx(60));
        shieldParams.gravity = Gravity.BOTTOM | Gravity.START;
        shieldParams.bottomMargin = dpToPx(54);
        rootFrame.addView(miniVideoTouchShield, shieldParams);

        playerTopBar = buildPlayerTopBar();
        rootFrame.addView(playerTopBar);

        fullscreenContainer = new FrameLayout(this);
        fullscreenContainer.setBackgroundColor(Color.BLACK);
        fullscreenContainer.setVisibility(View.GONE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            fullscreenContainer.setElevation(dpToPx(24));
        }
        rootFrame.addView(fullscreenContainer, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        ));
    }

    private LinearLayout buildMiniBarChrome() {
        LinearLayout container = new LinearLayout(this);
        container.setOrientation(LinearLayout.VERTICAL);
        container.setBackgroundColor(Color.parseColor("#1D1D1D"));
        container.setClickable(true);
        container.setVisibility(View.GONE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            container.setElevation(dpToPx(8));
        }
        FrameLayout.LayoutParams containerParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dpToPx(60)
        );
        containerParams.gravity = Gravity.BOTTOM;
        containerParams.bottomMargin = dpToPx(54);
        container.setLayoutParams(containerParams);

        FrameLayout track = new FrameLayout(this);
        track.setBackgroundColor(Color.parseColor("#2BFFFFFF"));
        miniProgressTrack = track;
        miniProgressView = new View(this);
        miniProgressView.setBackgroundColor(Color.parseColor("#FF0033"));
        track.addView(miniProgressView, new FrameLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT));
        container.addView(track, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dpToPx(2)
        ));

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        container.addView(row, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dpToPx(58)
        ));

        View videoSpacer = new View(this);
        row.addView(videoSpacer, new LinearLayout.LayoutParams(dpToPx(106), ViewGroup.LayoutParams.MATCH_PARENT));

        LinearLayout textCol = new LinearLayout(this);
        textCol.setOrientation(LinearLayout.VERTICAL);
        textCol.setGravity(Gravity.CENTER_VERTICAL);
        textCol.setPadding(dpToPx(10), dpToPx(6), dpToPx(6), dpToPx(6));
        textCol.setOnClickListener(v -> expandPlayer());

        miniTitleView = new TextView(this);
        miniTitleView.setTextColor(Color.WHITE);
        miniTitleView.setTextSize(13f);
        miniTitleView.setSingleLine(true);
        miniTitleView.setEllipsize(TextUtils.TruncateAt.END);
        miniTitleView.setText(currentTitle);

        miniArtistView = new TextView(this);
        miniArtistView.setTextColor(Color.parseColor("#AAAAAA"));
        miniArtistView.setTextSize(11f);
        miniArtistView.setSingleLine(true);
        miniArtistView.setEllipsize(TextUtils.TruncateAt.END);
        miniArtistView.setText(currentArtist);

        textCol.addView(miniTitleView);
        textCol.addView(miniArtistView);
        row.addView(textCol, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f));

        miniPlayPauseBtn = createBarButton("\u25b6", 16f, Color.WHITE, dpToPx(44), dpToPx(58));
        miniPlayPauseBtn.setContentDescription("Phát / Tạm dừng");
        miniPlayPauseBtn.setOnClickListener(v -> toggleMiniPlayPause());
        row.addView(miniPlayPauseBtn);

        TextView closeBtn = createBarButton("\u2715", 15f, Color.parseColor("#CCCCCC"), dpToPx(44), dpToPx(58));
        closeBtn.setContentDescription("Đóng trình phát");
        closeBtn.setOnClickListener(v -> closePlayer());
        row.addView(closeBtn);

        return container;
    }

    @SuppressLint("ClickableViewAccessibility")
    private LinearLayout buildPlayerTopBar() {
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setBackgroundColor(Color.parseColor("#0F0F0F"));
        bar.setVisibility(View.GONE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            bar.setElevation(dpToPx(8));
        }
        FrameLayout.LayoutParams barParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dpToPx(44)
        );
        barParams.gravity = Gravity.TOP;
        bar.setLayoutParams(barParams);

        TextView minBtn = createBarButton("\u2304", 20f, Color.WHITE, dpToPx(44), dpToPx(44));
        minBtn.setContentDescription("Thu nhỏ trình phát");
        minBtn.setOnClickListener(v -> minimizePlayer());
        bar.addView(minBtn);

        playerTopTitle = new TextView(this);
        playerTopTitle.setTextColor(Color.WHITE);
        playerTopTitle.setTextSize(14f);
        playerTopTitle.setSingleLine(true);
        playerTopTitle.setEllipsize(TextUtils.TruncateAt.END);
        playerTopTitle.setPadding(dpToPx(4), 0, dpToPx(8), 0);
        playerTopTitle.setText(currentTitle);
        playerTopTitle.setOnTouchListener((v, ev) -> handleTopBarDragTouch(ev));
        bar.addView(playerTopTitle, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f));
        playerTopTitle.setGravity(Gravity.CENTER_VERTICAL);

        TextView reloadBtn = createBarButton("\u21bb", 18f, Color.WHITE, dpToPx(40), dpToPx(44));
        reloadBtn.setContentDescription("Tải lại video");
        reloadBtn.setOnClickListener(v -> {
            if (playerWebView != null) {
                playerWebView.reload();
            }
        });
        bar.addView(reloadBtn);

        TextView pipBtn = createBarButton("PiP", 11f, Color.parseColor("#E0E0E0"), dpToPx(42), dpToPx(28));
        GradientDrawable pipBg = new GradientDrawable();
        pipBg.setColor(Color.parseColor("#242424"));
        pipBg.setCornerRadius(dpToPx(14));
        pipBg.setStroke(dpToPx(1), Color.parseColor("#44FFFFFF"));
        pipBtn.setBackground(pipBg);
        pipBtn.setContentDescription("Hình trong hình");
        pipBtn.setOnClickListener(v -> enterPictureInPictureSafe());
        LinearLayout.LayoutParams pipLp = new LinearLayout.LayoutParams(dpToPx(42), dpToPx(28));
        pipLp.setMargins(dpToPx(2), 0, dpToPx(2), 0);
        bar.addView(pipBtn, pipLp);

        TextView closeBtn = createBarButton("\u2715", 16f, Color.parseColor("#CCCCCC"), dpToPx(40), dpToPx(44));
        closeBtn.setContentDescription("Đóng video");
        closeBtn.setOnClickListener(v -> closePlayer());
        bar.addView(closeBtn);

        return bar;
    }

    private TextView createBarButton(String label, float textSizeSp, int textColor, int widthPx, int heightPx) {
        TextView btn = new TextView(this);
        btn.setText(label);
        btn.setTextSize(textSizeSp);
        btn.setTextColor(textColor);
        btn.setGravity(Gravity.CENTER);
        btn.setClickable(true);
        btn.setFocusable(true);
        btn.setLayoutParams(new LinearLayout.LayoutParams(widthPx, heightPx));
        return btn;
    }

    private boolean handleTopBarDragTouch(MotionEvent ev) {
        if (playerState != PlayerState.EXPANDED || ev == null) return false;
        int action = ev.getActionMasked();
        if (action == MotionEvent.ACTION_DOWN) {
            topBarDownRawX = ev.getRawX();
            topBarDownRawY = ev.getRawY();
            topBarLastDy = 0f;
            topBarDragging = false;
            return true;
        } else if (action == MotionEvent.ACTION_MOVE) {
            float dy = ev.getRawY() - topBarDownRawY;
            float dx = ev.getRawX() - topBarDownRawX;
            if (!topBarDragging) {
                if (dy > touchSlopPx && dy > Math.abs(dx)) {
                    topBarDragging = true;
                }
            }
            if (topBarDragging) {
                topBarLastDy = Math.max(0f, dy - touchSlopPx);
                applyInteractiveDrag(topBarLastDy);
                return true;
            }
        } else if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) {
            if (topBarDragging) {
                boolean shouldMin = action == MotionEvent.ACTION_UP && topBarLastDy >= dpToPx(60);
                topBarDragging = false;
                topBarLastDy = 0f;
                finishInteractiveDrag(shouldMin);
                return true;
            }
            topBarDragging = false;
            return true;
        }
        return false;
    }

    private void applyInteractiveDrag(float dyPx) {
        if (playerState != PlayerState.EXPANDED) return;
        float clamped = Math.max(0f, dyPx);
        playerWebView.setTranslationY(clamped);
        playerTopBar.setTranslationY(clamped);
        float topBarAlpha = Math.max(0f, 1f - (clamped / dpToPx(120)));
        playerTopBar.setAlpha(topBarAlpha);
        float backdropAlpha = Math.max(0f, 1f - (clamped / dpToPx(240)));
        playerBackdrop.setAlpha(backdropAlpha);
    }

    private void finishInteractiveDrag(boolean shouldMinimize) {
        if (playerState != PlayerState.EXPANDED) return;
        if (shouldMinimize) {
            playerWebView.setTranslationY(0f);
            playerTopBar.setTranslationY(0f);
            playerTopBar.setAlpha(1f);
            playerBackdrop.setAlpha(1f);
            minimizePlayer();
            return;
        }
        playerWebView.animate().translationY(0f).setDuration(180).setListener(null).start();
        playerTopBar.animate().translationY(0f).alpha(1f).setDuration(180).start();
        playerBackdrop.animate().alpha(1f).setDuration(180).start();
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView(BackgroundWebView webView, String role) {
        webView.setBackgroundColor(Color.parseColor("#0F0F0F"));
        webView.setKeepAliveInBackground(backgroundPlayEnabled);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setSupportMultipleWindows(false);
        settings.setUserAgentString(MOBILE_UA);

        webView.addJavascriptInterface(new HostBridge(role), "PureTubeHost");

        if (!TextUtils.isEmpty(injectScriptSource)
                && WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(webView, injectScriptSource, Collections.singleton("*"));
        }

        webView.setWebViewClient(createRoleWebViewClient(role));
        if (roleWebChromeClient == null) {
            roleWebChromeClient = createRoleWebChromeClient();
        }
        webView.setWebChromeClient(roleWebChromeClient);
    }

    private WebViewClient createRoleWebViewClient(String role) {
        final boolean isBrowse = "browse".equals(role);
        return new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (adBlockEnabled && request != null && request.getUrl() != null) {
                    if (AdBlockFilter.shouldBlock(request.getUrl())) {
                        return AdBlockFilter.emptyBlockedResponse();
                    }
                }
                return super.shouldInterceptRequest(view, request);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (request == null || request.getUrl() == null) return false;
                Uri uri = request.getUrl();
                String url = uri.toString();
                String scheme = uri.getScheme() != null ? uri.getScheme().toLowerCase(Locale.US) : "";
                if (!"http".equals(scheme) && !"https".equals(scheme)) {
                    launchExternalUri(uri);
                    return true;
                }
                String host = uri.getHost() != null ? uri.getHost().toLowerCase(Locale.US) : "";
                if (!isAllowedInAppHost(host)) {
                    launchExternalUri(uri);
                    return true;
                }
                if (isGoogleAuthHost(host)) {
                    return false;
                }
                if (isBrowse && isWatchUrl(url)) {
                    openVideoInPlayer(normalizeWatchUrl(url));
                    return true;
                }
                if (!isBrowse && isBrowsePathInYouTube(uri) && !isWatchUrl(url)) {
                    openInBrowseFromPlayer(url);
                    return true;
                }
                return false;
            }

            @Override
            public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
                super.doUpdateVisitedHistory(view, url, isReload);
                if (isBrowse) {
                    browseInShorts = isShortsUrl(url);
                }
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                if (!TextUtils.isEmpty(injectScriptSource) && isYouTubeScriptHost(url)) {
                    if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                        view.evaluateJavascript(injectScriptSource, null);
                    }
                }
                if (isBrowse) {
                    browseInShorts = isShortsUrl(url);
                    stopBrowseRefreshIndicator();
                } else {
                    syncMiniModeCssToPlayer(playerState == PlayerState.MINI);
                }
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, android.webkit.WebResourceError error) {
                super.onReceivedError(view, request, error);
                if (isBrowse && request != null && request.isForMainFrame()) {
                    stopBrowseRefreshIndicator();
                }
            }
        };
    }

    private WebChromeClient createRoleWebChromeClient() {
        return new WebChromeClient() {
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (customFullscreenView != null) {
                    onHideCustomView();
                    return;
                }
                customFullscreenView = view;
                customViewCallback = callback;
                fullscreenContainer.removeAllViews();
                fullscreenContainer.addView(view, new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT
                ));
                fullscreenContainer.setVisibility(View.VISIBLE);
                setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
                hideSystemBarsForFullscreen(true);
            }

            @Override
            public void onHideCustomView() {
                if (customFullscreenView == null) return;
                fullscreenContainer.setVisibility(View.GONE);
                fullscreenContainer.removeAllViews();
                customFullscreenView = null;
                if (customViewCallback != null) {
                    customViewCallback.onCustomViewHidden();
                    customViewCallback = null;
                }
                setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
                hideSystemBarsForFullscreen(false);
            }
        };
    }

    private void hideSystemBarsForFullscreen(boolean hide) {
        WindowInsetsControllerCompat controller = new WindowInsetsControllerCompat(getWindow(), getWindow().getDecorView());
        if (hide) {
            controller.hide(WindowInsetsCompat.Type.systemBars());
            controller.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        } else {
            controller.show(WindowInsetsCompat.Type.systemBars());
        }
        ViewCompat.requestApplyInsets(rootFrame);
    }

    private void openVideoInPlayer(String url) {
        if (TextUtils.isEmpty(url)) return;
        String normalized = normalizeWatchUrl(url);
        String nextVideoId = extractVideoId(normalized);
        boolean sameVideoActive = playerState != PlayerState.HIDDEN
                && !TextUtils.isEmpty(nextVideoId)
                && nextVideoId.equals(currentVideoId);

        expandPlayer();
        if (sameVideoActive) {
            return;
        }
        currentVideoUrl = normalized;
        currentVideoId = nextVideoId;
        currentTitle = "PureTube";
        currentArtist = "YouTube";
        currentProgressPermille = 0;
        updateTitleViews();
        updateProgressBarWidth();
        playerWebView.loadUrl(normalized);
    }

    private void openInBrowseFromPlayer(String url) {
        if (TextUtils.isEmpty(url)) return;
        minimizePlayer();
        browseInShorts = isShortsUrl(url);
        browseWebView.loadUrl(url);
    }

    private void expandPlayer() {
        if (playerWebView == null) return;
        applyPlayerState(PlayerState.EXPANDED);
    }

    private void minimizePlayer() {
        if (playerState == PlayerState.HIDDEN) return;
        if (customFullscreenView != null && customViewCallback != null) {
            customFullscreenView = null;
            fullscreenContainer.setVisibility(View.GONE);
            fullscreenContainer.removeAllViews();
            customViewCallback.onCustomViewHidden();
            customViewCallback = null;
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
            hideSystemBarsForFullscreen(false);
        }
        applyPlayerState(PlayerState.MINI);
    }

    private void closePlayer() {
        applyPlayerState(PlayerState.HIDDEN);
        mediaIsPlaying = false;
        currentVideoUrl = "";
        currentVideoId = "";
        currentTitle = "PureTube";
        currentArtist = "YouTube";
        currentProgressPermille = 0;
        updateTitleViews();
        updateProgressBarWidth();
        playerWebView.loadUrl("about:blank");
        stopMediaService();
    }

    private void applyPlayerState(PlayerState nextState) {
        playerState = nextState;
        if (playerWebView == null) return;

        playerWebView.setTranslationY(0f);
        playerTopBar.setTranslationY(0f);
        playerTopBar.setAlpha(1f);
        playerBackdrop.setAlpha(1f);

        if (nextState == PlayerState.HIDDEN) {
            playerWebView.setSwipeDownEnabled(false);
            playerBackdrop.setVisibility(View.GONE);
            playerTopBar.setVisibility(View.GONE);
            miniBarChrome.setVisibility(View.GONE);
            miniVideoTouchShield.setVisibility(View.GONE);
            playerWebView.setVisibility(View.GONE);
            syncMiniModeCssToPlayer(false);
            return;
        }

        if (nextState == PlayerState.EXPANDED) {
            FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
            );
            lp.gravity = Gravity.TOP | Gravity.START;
            lp.topMargin = inPipMode ? 0 : dpToPx(44);
            playerWebView.setLayoutParams(lp);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                playerWebView.setElevation(dpToPx(6));
            }
            playerWebView.setVisibility(View.VISIBLE);
            playerWebView.setSwipeDownEnabled(!inPipMode);
            playerBackdrop.setVisibility(View.VISIBLE);
            playerTopBar.setVisibility(inPipMode ? View.GONE : View.VISIBLE);
            miniBarChrome.setVisibility(View.GONE);
            miniVideoTouchShield.setVisibility(View.GONE);
            syncMiniModeCssToPlayer(false);
            return;
        }

        // PlayerState.MINI
        FrameLayout.LayoutParams miniLp = new FrameLayout.LayoutParams(dpToPx(106), dpToPx(60));
        miniLp.gravity = Gravity.BOTTOM | Gravity.START;
        miniLp.bottomMargin = dpToPx(54);
        playerWebView.setLayoutParams(miniLp);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            playerWebView.setElevation(dpToPx(10));
        }
        playerWebView.setVisibility(View.VISIBLE);
        playerWebView.setSwipeDownEnabled(false);
        playerBackdrop.setVisibility(View.GONE);
        playerTopBar.setVisibility(View.GONE);
        miniBarChrome.setVisibility(View.VISIBLE);
        miniVideoTouchShield.setVisibility(View.VISIBLE);
        syncMiniModeCssToPlayer(true);
        updateProgressBarWidth();
        updateTitleViews();
    }

    private void syncMiniModeCssToPlayer(boolean isMini) {
        if (playerWebView == null) return;
        playerWebView.evaluateJavascript(
                "window.__puretubeSetMiniMode && window.__puretubeSetMiniMode(" + (isMini ? "true" : "false") + ");",
                null
        );
    }

    private void toggleMiniPlayPause() {
        String action = mediaIsPlaying ? "pause" : "play";
        mediaIsPlaying = !mediaIsPlaying;
        updateMiniPlayPauseIcon();
        dispatchMediaControlToPlayer(action);
    }

    private void dispatchMediaControlToPlayer(String action) {
        if (playerWebView == null || TextUtils.isEmpty(action)) return;
        String safeAction = action.replace("'", "");
        mainHandler.post(() -> playerWebView.evaluateJavascript(
                "window.__puretubeMediaControl && window.__puretubeMediaControl('" + safeAction + "');",
                null
        ));
    }

    private void updateTitleViews() {
        if (playerTopTitle != null) {
            playerTopTitle.setText(currentTitle);
        }
        if (miniTitleView != null) {
            miniTitleView.setText(currentTitle);
        }
        if (miniArtistView != null) {
            miniArtistView.setText(currentArtist);
        }
        updateMiniPlayPauseIcon();
    }

    private void updateMiniPlayPauseIcon() {
        if (miniPlayPauseBtn != null) {
            miniPlayPauseBtn.setText(mediaIsPlaying ? "\u23f8" : "\u25b6");
        }
    }

    private void updateProgressBarWidth() {
        if (miniProgressView == null || miniProgressTrack == null) return;
        miniProgressTrack.post(() -> {
            int trackWidth = miniProgressTrack.getWidth();
            if (trackWidth <= 0) return;
            ViewGroup.LayoutParams lp = miniProgressView.getLayoutParams();
            lp.width = Math.round(trackWidth * (currentProgressPermille / 1000f));
            miniProgressView.setLayoutParams(lp);
        });
    }

    private void scheduleRefreshFailsafe() {
        if (refreshFailsafeRunnable != null) {
            mainHandler.removeCallbacks(refreshFailsafeRunnable);
        }
        refreshFailsafeRunnable = () -> {
            if (swipeRefresh != null && swipeRefresh.isRefreshing()) {
                swipeRefresh.setRefreshing(false);
            }
        };
        mainHandler.postDelayed(refreshFailsafeRunnable, 6000L);
    }

    private void stopBrowseRefreshIndicator() {
        if (refreshFailsafeRunnable != null) {
            mainHandler.removeCallbacks(refreshFailsafeRunnable);
        }
        if (swipeRefresh != null && swipeRefresh.isRefreshing()) {
            swipeRefresh.setRefreshing(false);
        }
    }

    private void setupMediaServiceListener() {
        PureTubeMediaService.actionListener = action -> mainHandler.post(() -> dispatchMediaControlToPlayer(action));
    }

    private void updateMediaService(String title, String artist, boolean playing) {
        try {
            Intent intent = new Intent(this, PureTubeMediaService.class);
            intent.setAction(PureTubeMediaService.ACTION_UPDATE);
            intent.putExtra("title", title);
            intent.putExtra("artist", artist);
            intent.putExtra("playing", playing);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(intent);
            } else {
                startService(intent);
            }
        } catch (Exception ignored) {}
    }

    private void stopMediaService() {
        try {
            Intent intent = new Intent(this, PureTubeMediaService.class);
            intent.setAction(PureTubeMediaService.ACTION_STOP);
            startService(intent);
        } catch (Exception ignored) {}
    }

    private void enterPictureInPictureSafe() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        if (!getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)) return;
        if (playerState == PlayerState.HIDDEN) return;
        if (playerState == PlayerState.MINI) {
            expandPlayer();
        }
        try {
            PictureInPictureParams params = new PictureInPictureParams.Builder()
                    .setAspectRatio(new Rational(16, 9))
                    .build();
            enterPictureInPictureMode(params);
        } catch (Exception ignored) {}
    }

    @Override
    public void onPictureInPictureModeChanged(boolean isInPictureInPictureMode, Configuration newConfig) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig);
        inPipMode = isInPictureInPictureMode;
        if (playerState != PlayerState.HIDDEN) {
            applyPlayerState(PlayerState.EXPANDED);
        }
        ViewCompat.requestApplyInsets(rootFrame);
    }

    private void setupBackNavigation() {
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (customFullscreenView != null) {
                    if (roleWebChromeClient != null) roleWebChromeClient.onHideCustomView();
                    return;
                }
                if (playerState == PlayerState.EXPANDED) {
                    minimizePlayer();
                    return;
                }
                if (browseWebView != null && browseWebView.canGoBack()) {
                    browseWebView.goBack();
                    return;
                }
                long now = System.currentTimeMillis();
                if (now - lastBackPressMs < 1800L) {
                    setEnabled(false);
                    getOnBackPressedDispatcher().onBackPressed();
                } else {
                    lastBackPressMs = now;
                    Toast.makeText(MainActivity.this, "Bấm lần nữa để thoát PureTube", Toast.LENGTH_SHORT).show();
                }
            }
        });
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String url = extractYouTubeIntentUrl(intent);
        if (TextUtils.isEmpty(url)) return;
        if (isWatchUrl(url)) {
            openVideoInPlayer(normalizeWatchUrl(url));
        } else if (browseWebView != null) {
            browseInShorts = isShortsUrl(url);
            browseWebView.loadUrl(url);
            if (playerState == PlayerState.EXPANDED) {
                minimizePlayer();
            }
        }
    }

    @Override
    protected void onSaveInstanceState(@NonNull Bundle outState) {
        super.onSaveInstanceState(outState);
        if (browseWebView != null) {
            Bundle browseState = new Bundle();
            browseWebView.saveState(browseState);
            outState.putBundle("browse_state", browseState);
        }
        outState.putString(KEY_PLAYER_STATE, playerState.name());
        outState.putString(KEY_PLAYER_URL, currentVideoUrl);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (browseWebView != null) browseWebView.onResume();
        if (playerWebView != null) playerWebView.onResume();
    }

    @Override
    protected void onPause() {
        boolean keepPlaying = backgroundPlayEnabled || isPipActiveCompat();
        if (browseWebView != null) browseWebView.setKeepAliveInBackground(keepPlaying);
        if (playerWebView != null) playerWebView.setKeepAliveInBackground(keepPlaying);
        if (!keepPlaying) {
            if (playerWebView != null) playerWebView.onPause();
            if (browseWebView != null) browseWebView.onPause();
        }
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (refreshFailsafeRunnable != null) {
            mainHandler.removeCallbacks(refreshFailsafeRunnable);
        }
        PureTubeMediaService.actionListener = null;
        if (playerWebView != null) {
            playerWebView.destroy();
        }
        if (browseWebView != null) {
            browseWebView.destroy();
        }
        super.onDestroy();
    }

    private boolean isPipActiveCompat() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && isInPictureInPictureMode();
    }

    private int dpToPx(int dp) {
        return Math.round(dp * getResources().getDisplayMetrics().density);
    }

    private String loadAssetText(String filename) {
        try (InputStream is = getAssets().open(filename);
             BufferedReader br = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8))) {
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = br.readLine()) != null) {
                sb.append(line).append('\n');
            }
            return sb.toString();
        } catch (Exception ignored) {
            return "";
        }
    }

    private void launchExternalUri(Uri uri) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
            startActivity(intent);
        } catch (Exception ignored) {}
    }

    private static String extractYouTubeIntentUrl(Intent intent) {
        if (intent == null) return null;
        Uri data = intent.getData();
        if (data != null && ("http".equalsIgnoreCase(data.getScheme()) || "https".equalsIgnoreCase(data.getScheme()))) {
            return data.toString();
        }
        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        if (!TextUtils.isEmpty(text) && (text.contains("youtube.com") || text.contains("youtu.be"))) {
            return text.trim();
        }
        return null;
    }

    private static boolean isAllowedInAppHost(String host) {
        if (TextUtils.isEmpty(host)) return false;
        String[] domains = {
                "youtube.com", "youtu.be", "youtube-nocookie.com", "youtubekids.com",
                "google.com", "google.com.vn", "gstatic.com", "googleapis.com",
                "googleusercontent.com", "ytimg.com", "ggpht.com"
        };
        for (String d : domains) {
            if (host.equals(d) || host.endsWith("." + d)) return true;
        }
        return false;
    }

    private static boolean isGoogleAuthHost(String host) {
        return host.equals("accounts.google.com")
                || host.endsWith(".accounts.google.com")
                || host.equals("accounts.youtube.com");
    }

    private static boolean isYouTubeScriptHost(String url) {
        if (TextUtils.isEmpty(url)) return false;
        try {
            String host = Uri.parse(url).getHost();
            if (host == null) return false;
            host = host.toLowerCase(Locale.US);
            return host.equals("youtube.com") || host.endsWith(".youtube.com")
                    || host.equals("youtu.be") || host.equals("youtube-nocookie.com")
                    || host.endsWith(".youtube-nocookie.com");
        } catch (Exception ignored) {
            return false;
        }
    }

    private static boolean isShortsUrl(String url) {
        if (TextUtils.isEmpty(url)) return false;
        try {
            String path = Uri.parse(url).getPath();
            return path != null && (path.equals("/shorts") || path.startsWith("/shorts/"));
        } catch (Exception ignored) {
            return false;
        }
    }

    private static boolean isWatchUrl(String url) {
        if (TextUtils.isEmpty(url)) return false;
        try {
            Uri uri = Uri.parse(url);
            String host = uri.getHost() != null ? uri.getHost().toLowerCase(Locale.US) : "";
            if (host.equals("youtu.be") || host.endsWith(".youtu.be")) {
                String seg = uri.getLastPathSegment();
                return seg != null && seg.length() == 11;
            }
            if (!(host.equals("youtube.com") || host.endsWith(".youtube.com"))) return false;
            return "/watch".equals(uri.getPath()) && !TextUtils.isEmpty(uri.getQueryParameter("v"));
        } catch (Exception ignored) {
            return false;
        }
    }

    private static boolean isBrowsePathInYouTube(Uri uri) {
        if (uri == null) return false;
        String host = uri.getHost() != null ? uri.getHost().toLowerCase(Locale.US) : "";
        if (!(host.equals("youtube.com") || host.endsWith(".youtube.com"))) return false;
        String path = uri.getPath();
        if (path == null || path.equals("/watch")) return false;
        return path.equals("/")
                || path.startsWith("/@")
                || path.startsWith("/channel/")
                || path.startsWith("/c/")
                || path.startsWith("/user/")
                || path.startsWith("/results")
                || path.startsWith("/feed/")
                || path.startsWith("/playlist")
                || path.startsWith("/shorts")
                || path.startsWith("/hashtag/");
    }

    private static String normalizeWatchUrl(String url) {
        try {
            Uri uri = Uri.parse(url);
            String host = uri.getHost() != null ? uri.getHost().toLowerCase(Locale.US) : "";
            if (host.equals("youtu.be") || host.endsWith(".youtu.be")) {
                String seg = uri.getLastPathSegment();
                if (!TextUtils.isEmpty(seg)) {
                    Uri.Builder b = Uri.parse(YOUTUBE_HOME + "/watch").buildUpon().appendQueryParameter("v", seg);
                    String t = uri.getQueryParameter("t");
                    if (!TextUtils.isEmpty(t)) b.appendQueryParameter("t", t);
                    return b.build().toString();
                }
            }
            return url;
        } catch (Exception ignored) {
            return url;
        }
    }

    private static String extractVideoId(String url) {
        if (TextUtils.isEmpty(url)) return "";
        try {
            Uri uri = Uri.parse(url);
            String v = uri.getQueryParameter("v");
            if (!TextUtils.isEmpty(v)) return v;
            String host = uri.getHost() != null ? uri.getHost().toLowerCase(Locale.US) : "";
            if (host.contains("youtu.be")) {
                String seg = uri.getLastPathSegment();
                return seg != null ? seg : "";
            }
        } catch (Exception ignored) {}
        return "";
    }

    private final class HostBridge {
        private final String role;

        HostBridge(String role) {
            this.role = role;
        }

        @JavascriptInterface
        public String getRole() {
            return role;
        }

        @JavascriptInterface
        public void openVideo(String url) {
            if (TextUtils.isEmpty(url)) return;
            mainHandler.post(() -> openVideoInPlayer(url));
        }

        @JavascriptInterface
        public void openInBrowse(String url) {
            if (TextUtils.isEmpty(url)) return;
            mainHandler.post(() -> openInBrowseFromPlayer(url));
        }

        @JavascriptInterface
        public void onBrowseShorts() {
            browseInShorts = true;
        }

        @JavascriptInterface
        public void reloadBrowse() {
            mainHandler.post(() -> {
                if (browseWebView != null) {
                    browseWebView.reload();
                }
            });
        }

        @JavascriptInterface
        public void onMediaProgress(int permille) {
            final int clamped = Math.max(0, Math.min(1000, permille));
            mainHandler.post(() -> {
                currentProgressPermille = clamped;
                if (playerState == PlayerState.MINI) {
                    updateProgressBarWidth();
                }
            });
        }

        @JavascriptInterface
        public void onMediaState(String title, String artist, boolean playing) {
            mainHandler.post(() -> {
                if (!TextUtils.isEmpty(title)) currentTitle = title;
                if (!TextUtils.isEmpty(artist)) currentArtist = artist;
                mediaIsPlaying = playing;
                updateTitleViews();
                if (playing || playerState != PlayerState.HIDDEN) {
                    updateMediaService(currentTitle, currentArtist, playing);
                }
            });
        }

        @JavascriptInterface
        public void setBackgroundPlay(boolean enabled) {
            backgroundPlayEnabled = enabled;
            getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit().putBoolean(KEY_BG_PLAY, enabled).apply();
            mainHandler.post(() -> {
                if (browseWebView != null) browseWebView.setKeepAliveInBackground(enabled);
                if (playerWebView != null) playerWebView.setKeepAliveInBackground(enabled);
                if (!enabled && !mediaIsPlaying) stopMediaService();
            });
        }

        @JavascriptInterface
        public void setAdBlockEnabled(boolean enabled) {
            adBlockEnabled = enabled;
            getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit().putBoolean(KEY_AD_BLOCK, enabled).apply();
        }

        @JavascriptInterface
        public void enterPip() {
            mainHandler.post(MainActivity.this::enterPictureInPictureSafe);
        }
    }
}