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

  getTrending(category = "all") {
    if (this.isNativeStandalone()) return window.PureStandaloneBridge.getTrending(category);
    return this.fetchJson(`/api/trending?category=${encodeURIComponent(category)}`);
  },

  search(query, limit = 18) {
    if (this.isNativeStandalone()) return window.PureStandaloneBridge.search(query, limit);
    return this.fetchJson(`/api/search?q=${encodeURIComponent(query)}&limit=${limit}`);
  },

  suggest(query) {
    if (this.isNativeStandalone()) return window.PureStandaloneBridge.suggest(query);
    return this.fetchJson(`/api/suggest?q=${encodeURIComponent(query)}`);
  },

  getVideo(videoId) {
    if (this.isNativeStandalone()) return window.PureStandaloneBridge.getVideo(videoId);
    return this.fetchJson(`/api/video/${encodeURIComponent(videoId)}`);
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

  getChannel(channelName) {
    if (this.isNativeStandalone()) return window.PureStandaloneBridge.getChannel(channelName);
    return this.fetchJson(`/api/channel/${encodeURIComponent(channelName)}`);
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
