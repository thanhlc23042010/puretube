const PureAPI = {
  getCloudBaseUrl() {
    const raw = (window.Store?.state?.settings?.cloudServerUrl || "").trim();
    return raw ? raw.replace(/\/+$/, "") : "";
  },

  isNativeShell() {
    return Boolean(window.PureStandaloneBridge?.isAvailable());
  },

  isNativeStandalone() {
    return this.isNativeShell() && !this.getCloudBaseUrl();
  },

  getConnectionMode() {
    if (this.getCloudBaseUrl()) return "cloud";
    if (this.isNativeShell()) return "standalone";
    return "server";
  },

  resolveUrl(path) {
    if (!path) return "";
    if (/^(https?:|data:|blob:)/i.test(path)) return path;
    const base = this.getCloudBaseUrl();
    if (!base) return path;
    return `${base}${path.startsWith("/") ? path : `/${path}`}`;
  },

  async fetchJson(url, options = {}) {
    const targetUrl = this.resolveUrl(url);
    const res = await fetch(targetUrl, options);
    if (!res.ok) {
      let msg = `Lỗi máy chủ (${res.status})`;
      try {
        const err = await res.json();
        if (err && err.detail) msg = err.detail;
      } catch (_) {}
      throw new Error(msg);
    }
    return res.json();
  },

  async testServerUrl(url) {
    const clean = (url || "").trim().replace(/\/+$/, "");
    if (!/^https?:\/\/.+/i.test(clean)) {
      throw new Error("Địa chỉ Cloud phải bắt đầu bằng https:// hoặc http://");
    }
    const res = await fetch(`${clean}/api/info`);
    if (!res.ok) throw new Error(`Máy chủ phản hồi lỗi (${res.status})`);
    return res.json();
  },

  getInfo() {
    if (this.isNativeStandalone()) return Promise.resolve(window.PureStandaloneBridge.getInfo());
    return this.fetchJson("/api/info");
  },

  getMobilePackages() {
    if (this.isNativeStandalone()) {
      return Promise.resolve({ packages: [], has_reference_apps: false, capacitor_project_ready: true });
    }
    return this.fetchJson("/api/mobile-packages").catch(() => ({
      packages: [],
      has_reference_apps: false,
      capacitor_project_ready: false,
    }));
  },

  getTrending(category = "all", continuation = "", refresh = false) {
    if (this.isNativeStandalone()) {
      return window.PureStandaloneBridge.getTrending(category, continuation, refresh);
    }
    const qs = new URLSearchParams({ category });
    if (continuation) qs.set("continuation", continuation);
    if (refresh) qs.set("refresh", "1");
    return this.fetchJson(`/api/trending?${qs.toString()}`);
  },

  search(query, limit = 18) {
    if (this.isNativeStandalone()) return window.PureStandaloneBridge.search(query, limit);
    return this.fetchJson(`/api/search?q=${encodeURIComponent(query)}&limit=${limit}`);
  },

  suggest(query) {
    if (this.isNativeStandalone()) return window.PureStandaloneBridge.suggest(query);
    return this.fetchJson(`/api/suggest?q=${encodeURIComponent(query)}`);
  },

  getVideo(videoId, forceRefresh = false) {
    if (this.isNativeStandalone()) return window.PureStandaloneBridge.getVideo(videoId, forceRefresh);
    const qs = forceRefresh ? "?refresh=1" : "";
    return this.fetchJson(`/api/video/${encodeURIComponent(videoId)}${qs}`);
  },

  getVideoExtras(videoId, channel = "", title = "") {
    if (this.isNativeStandalone()) return window.PureStandaloneBridge.getVideoExtras(videoId, channel, title);
    return this.fetchJson(
      `/api/video/${encodeURIComponent(videoId)}/extras?channel=${encodeURIComponent(channel)}&title=${encodeURIComponent(title)}`
    );
  },

  prefetchVideo(videoId) {
    if (!videoId) return;
    if (this.isNativeStandalone()) {
      window.PureStandaloneBridge.prefetchVideo(videoId);
      return;
    }
    fetch(this.resolveUrl(`/api/prefetch/${encodeURIComponent(videoId)}`), { method: "POST" }).catch(() => {});
  },

  getDubbing(videoId) {
    if (this.isNativeStandalone()) return window.PureStandaloneBridge.getDubbing(videoId);
    return this.fetchJson(`/api/dubbing/${encodeURIComponent(videoId)}`);
  },

  getTtsUrl(text, voice = "vi-VN-HoaiMyNeural") {
    return this.resolveUrl(`/api/tts?text=${encodeURIComponent(text)}&voice=${encodeURIComponent(voice)}`);
  },

  async resolveTtsPlayableUrl(text, voice = "vi-VN-HoaiMyNeural") {
    if (this.isNativeStandalone()) {
      return window.PureStandaloneBridge.fetchTtsDataUri(text, voice);
    }
    return this.getTtsUrl(text, voice);
  },

  getChannel(channelName, tab = "videos") {
    if (this.isNativeStandalone()) return window.PureStandaloneBridge.getChannel(channelName, tab);
    return this.fetchJson(`/api/channel/${encodeURIComponent(channelName)}?tab=${encodeURIComponent(tab)}`);
  },

  getShorts(q = "", excludeIds = [], seed = 0) {
    const excludeCsv = Array.isArray(excludeIds) ? excludeIds.filter(Boolean).slice(-120).join(",") : String(excludeIds || "");
    if (this.isNativeStandalone()) return window.PureStandaloneBridge.getShorts(q, excludeCsv, seed);
    const qs = new URLSearchParams({ q });
    if (excludeCsv) qs.set("exclude", excludeCsv);
    if (seed) qs.set("seed", String(seed));
    return this.fetchJson(`/api/shorts?${qs.toString()}`);
  },

  reportWatchProgress(videoId, positionSec = 0, durationSec = 0) {
    if (!videoId) return Promise.resolve({ synced: false });
    if (this.isNativeStandalone()) {
      return window.PureStandaloneBridge.reportWatchProgress(videoId, positionSec, durationSec).catch(() => ({ synced: false }));
    }
    return this.fetchJson("/api/youtube/watchtime", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ video_id: videoId, position_sec: positionSec, duration_sec: durationSec }),
    }).catch(() => ({ synced: false }));
  },

  subscribeChannel(channelId, subscribe = true) {
    if (this.isNativeStandalone()) return window.PureStandaloneBridge.subscribeChannel(channelId, subscribe);
    return this.fetchJson("/api/channel/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel_id: channelId, subscribe }),
    });
  },

  getComments(videoId, continuation = "") {
    if (this.isNativeStandalone()) return window.PureStandaloneBridge.getComments(videoId, continuation);
    return this.fetchJson(
      `/api/comments/${encodeURIComponent(videoId)}?continuation=${encodeURIComponent(continuation)}`
    );
  },

  reactVideo(videoId, action = "like") {
    if (this.isNativeStandalone()) return window.PureStandaloneBridge.reactVideo(videoId, action);
    return this.fetchJson(`/api/video/${encodeURIComponent(videoId)}/react`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
  },

  getYoutubePlaylists(videoId = "") {
    if (this.isNativeStandalone()) return window.PureStandaloneBridge.getYoutubePlaylists(videoId);
    return this.fetchJson(`/api/playlists/youtube?video_id=${encodeURIComponent(videoId)}`);
  },

  getYoutubePlaylistItems(playlistId) {
    if (this.isNativeStandalone()) return window.PureStandaloneBridge.getYoutubePlaylistItems(playlistId);
    return this.fetchJson(`/api/playlists/youtube/${encodeURIComponent(playlistId)}`);
  },

  addVideoToYoutubePlaylist(playlistId, videoId, remove = false) {
    if (this.isNativeStandalone()) return window.PureStandaloneBridge.addVideoToYoutubePlaylist(playlistId, videoId, remove);
    return this.fetchJson("/api/playlists/youtube/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playlist_id: playlistId, video_id: videoId, remove }),
    });
  },

  downloadToDevice(videoData, mode = "video") {
    return window.PureStandaloneBridge.downloadToDevice(videoData, mode);
  },

  updateMediaNotification(opts) {
    if (window.PureStandaloneBridge?.isAvailable()) {
      window.PureStandaloneBridge.updateMediaNotification(opts);
    }
  },

  addNativeListener(eventName, cb) {
    if (window.PureStandaloneBridge?.isAvailable()) {
      return window.PureStandaloneBridge.addNativeListener(eventName, cb);
    }
    return null;
  },

  getAuthStatus() {
    if (this.isNativeStandalone()) return Promise.resolve(window.PureStandaloneBridge.getAuthStatus());
    return this.fetchJson("/api/auth/status");
  },

  launchGoogleLogin() {
    if (this.isNativeStandalone()) return window.PureStandaloneBridge.launchGoogleLogin();
    return this.fetchJson("/api/auth/launch-login", { method: "POST" });
  },

  pollGoogleLogin() {
    if (this.isNativeStandalone()) return window.PureStandaloneBridge.pollGoogleLogin();
    return this.fetchJson("/api/auth/poll-login");
  },

  completeGoogleLogin() {
    if (this.isNativeStandalone()) return window.PureStandaloneBridge.completeGoogleLogin();
    return this.fetchJson("/api/auth/complete-login", { method: "POST" });
  },

  importBrowserCookies(browser = "auto") {
    if (this.isNativeStandalone()) {
      return Promise.reject(new Error("Trên điện thoại hãy dùng Cách 1 (Mã kết nối Google chính thức)."));
    }
    return this.fetchJson("/api/auth/import-browser", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ browser }),
    });
  },

  saveManualCookies(cookiesText) {
    if (this.isNativeStandalone()) {
      return Promise.reject(new Error("Bản App độc lập dùng trực tiếp Cách 1 (Mã kết nối Google)."));
    }
    return this.fetchJson("/api/auth/save-cookies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cookies_text: cookiesText }),
    });
  },

  logoutGoogle() {
    if (this.isNativeStandalone()) return Promise.resolve(window.PureStandaloneBridge.logoutGoogle());
    return this.fetchJson("/api/auth/logout", { method: "POST" });
  },

  getYoutubeHistory() {
    if (this.isNativeStandalone()) return window.PureStandaloneBridge.getYoutubeHistory();
    return this.fetchJson("/api/youtube/history");
  },

  getYoutubeSubscriptions() {
    if (this.isNativeStandalone()) return window.PureStandaloneBridge.getYoutubeSubscriptions();
    return this.fetchJson("/api/youtube/subscriptions");
  },

  getQrUrl(text) {
    return this.resolveUrl(`/api/qr.svg?text=${encodeURIComponent(text)}`);
  },

  getDownloadUrl(videoId, mode = "video", height = 720) {
    return this.resolveUrl(
      `/api/download/${encodeURIComponent(videoId)}?mode=${encodeURIComponent(mode)}&height=${height}`
    );
  },

  formatViews(count) {
    if (!count || count <= 0) return "Mới đăng";
    if (count >= 1_000_000) {
      return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")} Tr lượt xem`;
    }
    if (count >= 1_000) {
      return `${Math.round(count / 1_000)} N lượt xem`;
    }
    return `${count} lượt xem`;
  },

  formatTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) return "0:00";
    const total = Math.floor(sec);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) {
      return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    }
    return `${m}:${String(s).padStart(2, "0")}`;
  },
};

window.PureAPI = PureAPI;
