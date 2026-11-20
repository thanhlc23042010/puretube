package com.puretube.app;

import android.annotation.SuppressLint;
import android.app.PictureInPictureParams;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.ColorFilter;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
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
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
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

    private static final int MINI_WIDTH_DP = 112;
    private static final int MINI_HEIGHT_DP = 63;
    private static final int MINI_BOTTOM_MARGIN_DP = 54;

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
    private ImageView playerMinimizeBtn;
    private LinearLayout miniBarChrome;
    private View miniProgressTrack;
    private View miniProgressView;
    private TextView miniTitleView;
    private TextView miniArtistView;
    private ImageView miniPlayPauseBtn;
    private VectorIconDrawable playPauseIconDrawable;
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
    private long lastBrowseWatchBounceMs = 0L;
    private boolean inPipMode = false;
    private boolean imeVisible = false;
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
            boolean nextIme = insets.isVisible(WindowInsetsCompat.Type.ime());
            if (nextIme != imeVisible) {
                imeVisible = nextIme;
                syncMiniVisibilityForIme();
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
        playerWebView.setVisibility(View.GONE);
        rootFrame.addView(playerWebView, playerParams);

        miniVideoTouchShield = new View(this);
        miniVideoTouchShield.setBackgroundColor(Color.TRANSPARENT);
        miniVideoTouchShield.setClickable(true);
        miniVideoTouchShield.setVisibility(View.GONE);
        miniVideoTouchShield.setElevation(dpToPx(14));
        attachMiniBarSwipeTouch(miniVideoTouchShield, this::expandPlayer);
        FrameLayout.LayoutParams shieldParams = new FrameLayout.LayoutParams(
                dpToPx(MINI_WIDTH_DP),
                dpToPx(MINI_HEIGHT_DP)
        );
        shieldParams.gravity = Gravity.BOTTOM | Gravity.START;
        shieldParams.bottomMargin = dpToPx(MINI_BOTTOM_MARGIN_DP);
        rootFrame.addView(miniVideoTouchShield, shieldParams);

        playerMinimizeBtn = buildOverlayMinimizeButton();
        rootFrame.addView(playerMinimizeBtn);

        fullscreenContainer = new FrameLayout(this);
        fullscreenContainer.setBackgroundColor(Color.BLACK);
        fullscreenContainer.setVisibility(View.GONE);
        fullscreenContainer.setElevation(dpToPx(24));
        rootFrame.addView(fullscreenContainer, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        ));
    }

    private ImageView buildOverlayMinimizeButton() {
        ImageView btn = new ImageView(this);
        GradientDrawable bg = new GradientDrawable();
        bg.setShape(GradientDrawable.OVAL);
        bg.setColor(Color.argb(107, 0, 0, 0));
        btn.setBackground(bg);
        btn.setImageDrawable(new VectorIconDrawable(
                VectorIconDrawable.ICON_CHEVRON_DOWN,
                Color.WHITE,
                getResources().getDisplayMetrics().density
        ));
        btn.setScaleType(ImageView.ScaleType.CENTER);
        btn.setContentDescription("Thu nhỏ trình phát");
        btn.setVisibility(View.GONE);
        btn.setClickable(true);
        btn.setFocusable(true);
        btn.setElevation(dpToPx(12));
        btn.setOnClickListener(v -> minimizePlayer());
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(dpToPx(36), dpToPx(36));
        lp.gravity = Gravity.TOP | Gravity.START;
        lp.leftMargin = dpToPx(8);
        lp.topMargin = dpToPx(8);
        btn.setLayoutParams(lp);
        return btn;
    }

    private LinearLayout buildMiniBarChrome() {
        LinearLayout container = new LinearLayout(this);
        container.setOrientation(LinearLayout.VERTICAL);
        container.setBackgroundColor(Color.parseColor("#1F1F1F"));
        container.setClickable(true);
        container.setVisibility(View.GONE);
        container.setElevation(dpToPx(10));
        FrameLayout.LayoutParams containerParams = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dpToPx(MINI_HEIGHT_DP)
        );
        containerParams.gravity = Gravity.BOTTOM;
        containerParams.bottomMargin = dpToPx(MINI_BOTTOM_MARGIN_DP);
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

        int rowHeightPx = dpToPx(MINI_HEIGHT_DP - 2);
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        container.addView(row, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                rowHeightPx
        ));

        View videoSpacer = new View(this);
        row.addView(videoSpacer, new LinearLayout.LayoutParams(dpToPx(MINI_WIDTH_DP), ViewGroup.LayoutParams.MATCH_PARENT));

        LinearLayout textCol = new LinearLayout(this);
        textCol.setOrientation(LinearLayout.VERTICAL);
        textCol.setGravity(Gravity.CENTER_VERTICAL);
        textCol.setPadding(dpToPx(10), dpToPx(4), dpToPx(6), dpToPx(4));
        attachMiniBarSwipeTouch(textCol, this::expandPlayer);

        miniTitleView = new TextView(this);
        miniTitleView.setTextColor(Color.WHITE);
        miniTitleView.setTextSize(13f);
        miniTitleView.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
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

        float density = getResources().getDisplayMetrics().density;
        playPauseIconDrawable = new VectorIconDrawable(VectorIconDrawable.ICON_PLAY, Color.WHITE, density);
        miniPlayPauseBtn = new ImageView(this);
        miniPlayPauseBtn.setImageDrawable(playPauseIconDrawable);
        miniPlayPauseBtn.setScaleType(ImageView.ScaleType.CENTER);
        miniPlayPauseBtn.setContentDescription("Phát / Tạm dừng");
        miniPlayPauseBtn.setClickable(true);
        miniPlayPauseBtn.setFocusable(true);
        miniPlayPauseBtn.setLayoutParams(new LinearLayout.LayoutParams(dpToPx(44), rowHeightPx));
        miniPlayPauseBtn.setOnClickListener(v -> toggleMiniPlayPause());
        row.addView(miniPlayPauseBtn);

        ImageView closeBtn = new ImageView(this);
        closeBtn.setImageDrawable(new VectorIconDrawable(
                VectorIconDrawable.ICON_CLOSE,
                Color.parseColor("#CCCCCC"),
                density
        ));
        closeBtn.setScaleType(ImageView.ScaleType.CENTER);
        closeBtn.setContentDescription("Đóng trình phát");
        closeBtn.setClickable(true);
        closeBtn.setFocusable(true);
        closeBtn.setLayoutParams(new LinearLayout.LayoutParams(dpToPx(44), rowHeightPx));
        closeBtn.setOnClickListener(v -> closePlayer());
        row.addView(closeBtn);

        return container;
    }

    @SuppressLint("ClickableViewAccessibility")
    private void attachMiniBarSwipeTouch(View target, Runnable onTap) {
        target.setOnTouchListener(new View.OnTouchListener() {
            private float downRawX;
            private float downRawY;
            private float lastDx;
            private float lastDy;
            private int dragAxis; // 0 = undecided, 1 = vertical, 2 = horizontal

            @Override
            public boolean onTouch(View v, MotionEvent ev) {
                if (playerState != PlayerState.MINI || ev == null) return false;
                int action = ev.getActionMasked();
                if (action == MotionEvent.ACTION_DOWN) {
                    downRawX = ev.getRawX();
                    downRawY = ev.getRawY();
                    lastDx = 0f;
                    lastDy = 0f;
                    dragAxis = 0;
                    return true;
                } else if (action == MotionEvent.ACTION_MOVE) {
                    lastDx = ev.getRawX() - downRawX;
                    lastDy = ev.getRawY() - downRawY;
                    if (dragAxis == 0) {
                        if (Math.abs(lastDy) > touchSlopPx && Math.abs(lastDy) >= Math.abs(lastDx)) {
                            dragAxis = 1;
                        } else if (Math.abs(lastDx) > touchSlopPx && Math.abs(lastDx) > Math.abs(lastDy)) {
                            dragAxis = 2;
                        }
                    }
                    if (dragAxis == 1) {
                        float alpha = lastDy > 0f ? Math.max(0.25f, 1f - lastDy / dpToPx(80)) : 1f;
                        translateMiniCluster(0f, lastDy, alpha);
                    } else if (dragAxis == 2) {
                        float alpha = Math.max(0.2f, 1f - Math.abs(lastDx) / dpToPx(150));
                        translateMiniCluster(lastDx, 0f, alpha);
                    }
                    return true;
                } else if (action == MotionEvent.ACTION_UP) {
                    if (dragAxis == 0) {
                        onTap.run();
                        return true;
                    }
                    if (dragAxis == 1 && lastDy < -dpToPx(36)) {
                        translateMiniCluster(0f, 0f, 1f);
                        expandPlayer();
                        return true;
                    }
                    if ((dragAxis == 1 && lastDy > dpToPx(40))
                            || (dragAxis == 2 && Math.abs(lastDx) > dpToPx(88))) {
                        translateMiniCluster(0f, 0f, 1f);
                        closePlayer();
                        return true;
                    }
                    snapBackMiniCluster();
                    return true;
                } else if (action == MotionEvent.ACTION_CANCEL) {
                    snapBackMiniCluster();
                    return true;
                }
                return false;
            }
        });
    }

    private void translateMiniCluster(float tx, float ty, float alpha) {
        if (imeVisible) return;
        miniBarChrome.setTranslationX(tx);
        miniBarChrome.setTranslationY(ty);
        miniBarChrome.setAlpha(alpha);
        playerWebView.setTranslationX(tx);
        playerWebView.setTranslationY(ty);
        playerWebView.setAlpha(alpha);
        miniVideoTouchShield.setTranslationX(tx);
        miniVideoTouchShield.setTranslationY(ty);
    }

    private void snapBackMiniCluster() {
        if (imeVisible) return;
        miniBarChrome.animate().translationX(0f).translationY(0f).alpha(1f).setDuration(160).start();
        playerWebView.animate().translationX(0f).translationY(0f).alpha(1f).setDuration(160).start();
        miniVideoTouchShield.animate().translationX(0f).translationY(0f).setDuration(160).start();
    }

    private void applyInteractiveDrag(float dyPx) {
        if (playerState != PlayerState.EXPANDED) return;
        float clamped = Math.max(0f, dyPx);
        playerWebView.setTranslationY(clamped);
        float progress = Math.min(1f, clamped / dpToPx(280));
        float scale = 1f - 0.08f * progress;
        playerWebView.setScaleX(scale);
        playerWebView.setScaleY(scale);
        playerMinimizeBtn.setAlpha(Math.max(0f, 1f - (clamped / dpToPx(90))));
        playerBackdrop.setAlpha(Math.max(0f, 1f - (clamped / dpToPx(240))));
    }

    private void finishInteractiveDrag(boolean shouldMinimize) {
        if (playerState != PlayerState.EXPANDED) return;
        if (shouldMinimize) {
            playerWebView.setTranslationY(0f);
            playerWebView.setScaleX(1f);
            playerWebView.setScaleY(1f);
            playerMinimizeBtn.setAlpha(1f);
            playerBackdrop.setAlpha(1f);
            minimizePlayer();
            return;
        }
        playerWebView.animate().translationY(0f).scaleX(1f).scaleY(1f).setDuration(180).setListener(null).start();
        playerMinimizeBtn.animate().alpha(1f).setDuration(180).start();
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

        if (roleWebChromeClient == null) {
            roleWebChromeClient = createRoleWebChromeClient();
        }
        webView.setWebViewClient(createRoleWebViewClient(role));
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
                    if (isWatchUrl(url)) {
                        openVideoInPlayer(normalizeWatchUrl(url));
                        mainHandler.postDelayed(() -> {
                            if (browseWebView != null && isWatchUrl(browseWebView.getUrl())) {
                                long now = SystemClock.uptimeMillis();
                                if (now - lastBrowseWatchBounceMs > 900L) {
                                    lastBrowseWatchBounceMs = now;
                                    if (browseWebView.canGoBack()) {
                                        browseWebView.goBack();
                                    } else {
                                        browseWebView.loadUrl(YOUTUBE_HOME);
                                    }
                                }
                            }
                        }, 250L);
                    }
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
                if (playerMinimizeBtn != null) {
                    playerMinimizeBtn.setVisibility(View.GONE);
                }
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
                if (playerState == PlayerState.EXPANDED && !inPipMode && playerMinimizeBtn != null) {
                    playerMinimizeBtn.setVisibility(View.VISIBLE);
                }
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

        playerWebView.setTranslationX(0f);
        playerWebView.setTranslationY(0f);
        playerWebView.setScaleX(1f);
        playerWebView.setScaleY(1f);
        playerWebView.setAlpha(1f);
        miniBarChrome.setTranslationX(0f);
        miniBarChrome.setTranslationY(0f);
        miniBarChrome.setAlpha(1f);
        miniVideoTouchShield.setTranslationX(0f);
        miniVideoTouchShield.setTranslationY(0f);
        playerMinimizeBtn.setAlpha(1f);
        playerBackdrop.setAlpha(1f);

        if (nextState == PlayerState.HIDDEN) {
            playerWebView.setSwipeDownEnabled(false);
            playerBackdrop.setVisibility(View.GONE);
            playerMinimizeBtn.setVisibility(View.GONE);
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
            lp.topMargin = 0;
            playerWebView.setLayoutParams(lp);
            playerWebView.setElevation(dpToPx(6));
            playerWebView.setVisibility(View.VISIBLE);
            playerWebView.requestLayout();
            playerWebView.setSwipeDownEnabled(!inPipMode);
            playerBackdrop.setVisibility(View.VISIBLE);
            playerMinimizeBtn.setVisibility((inPipMode || customFullscreenView != null) ? View.GONE : View.VISIBLE);
            miniBarChrome.setVisibility(View.GONE);
            miniVideoTouchShield.setVisibility(View.GONE);
            syncMiniModeCssToPlayer(false);
            return;
        }

        // PlayerState.MINI
        FrameLayout.LayoutParams miniLp = new FrameLayout.LayoutParams(dpToPx(MINI_WIDTH_DP), dpToPx(MINI_HEIGHT_DP));
        miniLp.gravity = Gravity.BOTTOM | Gravity.START;
        miniLp.bottomMargin = dpToPx(MINI_BOTTOM_MARGIN_DP);
        playerWebView.setLayoutParams(miniLp);
        playerWebView.setElevation(dpToPx(12));
        playerWebView.setVisibility(View.VISIBLE);
        playerWebView.requestLayout();
        playerWebView.setSwipeDownEnabled(false);
        playerBackdrop.setVisibility(View.GONE);
        playerMinimizeBtn.setVisibility(View.GONE);
        syncMiniVisibilityForIme();
        syncMiniModeCssToPlayer(true);
        updateProgressBarWidth();
        updateTitleViews();
    }

    private void syncMiniVisibilityForIme() {
        if (playerState != PlayerState.MINI || playerWebView == null) return;
        if (imeVisible) {
            miniBarChrome.setVisibility(View.GONE);
            miniVideoTouchShield.setVisibility(View.GONE);
            playerWebView.setVisibility(View.VISIBLE);
            playerWebView.setAlpha(0f);
            playerWebView.setTranslationX(0f);
            playerWebView.setTranslationY(dpToPx(240));
        } else {
            miniBarChrome.setTranslationX(0f);
            miniBarChrome.setTranslationY(0f);
            miniBarChrome.setAlpha(1f);
            miniBarChrome.setVisibility(View.VISIBLE);
            miniVideoTouchShield.setTranslationX(0f);
            miniVideoTouchShield.setTranslationY(0f);
            miniVideoTouchShield.setVisibility(View.VISIBLE);
            playerWebView.setVisibility(View.VISIBLE);
            playerWebView.setAlpha(1f);
            playerWebView.setTranslationX(0f);
            playerWebView.setTranslationY(0f);
        }
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
        dispatchMediaControlToWebView(playerWebView, action);
    }

    private void dispatchMediaControlToActiveWebView(String action) {
        BackgroundWebView target = (playerState != PlayerState.HIDDEN) ? playerWebView : browseWebView;
        dispatchMediaControlToWebView(target, action);
    }

    private void dispatchMediaControlToWebView(BackgroundWebView target, String action) {
        if (target == null || TextUtils.isEmpty(action)) return;
        String safeAction = action.replace("'", "");
        mainHandler.post(() -> target.evaluateJavascript(
                "window.__puretubeMediaControl && window.__puretubeMediaControl('" + safeAction + "');",
                null
        ));
    }

    private void updateTitleViews() {
        if (miniTitleView != null) {
            miniTitleView.setText(currentTitle);
        }
        if (miniArtistView != null) {
            miniArtistView.setText(currentArtist);
        }
        updateMiniPlayPauseIcon();
    }

    private void updateMiniPlayPauseIcon() {
        if (playPauseIconDrawable != null) {
            playPauseIconDrawable.setIconType(
                    mediaIsPlaying ? VectorIconDrawable.ICON_PAUSE : VectorIconDrawable.ICON_PLAY
            );
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
        PureTubeMediaService.actionListener = action -> mainHandler.post(() -> dispatchMediaControlToActiveWebView(action));
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

    private static final class VectorIconDrawable extends Drawable {
        static final int ICON_CHEVRON_DOWN = 1;
        static final int ICON_PLAY = 2;
        static final int ICON_PAUSE = 3;
        static final int ICON_CLOSE = 4;

        private int iconType;
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final float density;

        VectorIconDrawable(int iconType, int color, float density) {
            this.iconType = iconType;
            this.density = density;
            this.paint.setColor(color);
            this.paint.setStrokeCap(Paint.Cap.ROUND);
            this.paint.setStrokeJoin(Paint.Join.ROUND);
        }

        void setIconType(int iconType) {
            if (this.iconType != iconType) {
                this.iconType = iconType;
                invalidateSelf();
            }
        }

        @Override
        public void draw(@NonNull Canvas canvas) {
            Rect b = getBounds();
            float cx = b.exactCenterX();
            float cy = b.exactCenterY();
            if (iconType == ICON_CHEVRON_DOWN) {
                paint.setStyle(Paint.Style.STROKE);
                paint.setStrokeWidth(2.1f * density);
                Path p = new Path();
                p.moveTo(cx - 5.5f * density, cy - 2.5f * density);
                p.lineTo(cx, cy + 3.0f * density);
                p.lineTo(cx + 5.5f * density, cy - 2.5f * density);
                canvas.drawPath(p, paint);
            } else if (iconType == ICON_PLAY) {
                paint.setStyle(Paint.Style.FILL);
                Path p = new Path();
                p.moveTo(cx - 4.5f * density, cy - 6.5f * density);
                p.lineTo(cx + 6.5f * density, cy);
                p.lineTo(cx - 4.5f * density, cy + 6.5f * density);
                p.close();
                canvas.drawPath(p, paint);
            } else if (iconType == ICON_PAUSE) {
                paint.setStyle(Paint.Style.FILL);
                float r = 1.2f * density;
                canvas.drawRoundRect(
                        cx - 5.5f * density, cy - 6.5f * density,
                        cx - 2.0f * density, cy + 6.5f * density, r, r, paint);
                canvas.drawRoundRect(
                        cx + 2.0f * density, cy - 6.5f * density,
                        cx + 5.5f * density, cy + 6.5f * density, r, r, paint);
            } else if (iconType == ICON_CLOSE) {
                paint.setStyle(Paint.Style.STROKE);
                paint.setStrokeWidth(2.0f * density);
                float d = 5.0f * density;
                canvas.drawLine(cx - d, cy - d, cx + d, cy + d, paint);
                canvas.drawLine(cx + d, cy - d, cx - d, cy + d, paint);
            }
        }

        @Override
        public int getIntrinsicWidth() {
            return Math.round(24f * density);
        }

        @Override
        public int getIntrinsicHeight() {
            return Math.round(24f * density);
        }

        @Override
        public void setAlpha(int alpha) {
            paint.setAlpha(alpha);
            invalidateSelf();
        }

        @Override
        public void setColorFilter(@Nullable ColorFilter colorFilter) {
            paint.setColorFilter(colorFilter);
            invalidateSelf();
        }

        @Override
        public int getOpacity() {
            return PixelFormat.TRANSLUCENT;
        }
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
            if (!"player".equals(role)) return;
            final int clamped = Math.max(0, Math.min(1000, permille));
            mainHandler.post(() -> {
                if (playerState == PlayerState.HIDDEN) return;
                currentProgressPermille = clamped;
                if (playerState == PlayerState.MINI) {
                    updateProgressBarWidth();
                }
            });
        }

        @JavascriptInterface
        public void onMediaState(String title, String artist, boolean playing) {
            mainHandler.post(() -> {
                if ("player".equals(role)) {
                    if (playerState == PlayerState.HIDDEN) return;
                    if (!TextUtils.isEmpty(title)) currentTitle = title;
                    if (!TextUtils.isEmpty(artist)) currentArtist = artist;
                    mediaIsPlaying = playing;
                    updateTitleViews();
                    updateMediaService(currentTitle, currentArtist, playing);
                } else {
                    if (playerState == PlayerState.HIDDEN && playing) {
                        String browseTitle = !TextUtils.isEmpty(title) ? title : "PureTube";
                        String browseArtist = !TextUtils.isEmpty(artist) ? artist : "YouTube";
                        updateMediaService(browseTitle, browseArtist, true);
                    }
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