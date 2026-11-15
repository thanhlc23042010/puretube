const STORAGE_KEY = "puretube_state_v1";

const DEFAULT_STATE = {
  subscriptions: [],
  playlists: [
    {
      id: "pl-favorites",
      name: "Nghe sau & Yêu thích",
      items: [],
      createdAt: Date.now(),
    },
  ],
  history: [],
  stats: {
    adsBlocked: 0,
    secondsSaved: 0,
  },
  settings: {
    autoSkipSponsorBlock: true,
    preferredQuality: 720,
    audioOnlyDefault: false,
    autoPlayNext: true,
    dubbingMode: "auto-vi",
    cloudServerUrl: "",
    sponsorCategories: {
      sponsor: true,
      selfpromo: true,
      interaction: true,
      intro: true,
      outro: true,
      music_offtopic: true,
    },
  },
};

const Store = {
  state: null,
  listeners: new Set(),

  init() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        this.state = {
          subscriptions: Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [],
          playlists:
            Array.isArray(parsed.playlists) && parsed.playlists.length > 0
              ? parsed.playlists
              : structuredClone(DEFAULT_STATE.playlists),
          history: Array.isArray(parsed.history) ? parsed.history : [],
          stats: { ...DEFAULT_STATE.stats, ...(parsed.stats || {}) },
          settings: {
            ...DEFAULT_STATE.settings,
            ...(parsed.settings || {}),
            sponsorCategories: {
              ...DEFAULT_STATE.settings.sponsorCategories,
              ...((parsed.settings && parsed.settings.sponsorCategories) || {}),
            },
          },
        };
      } else {
        this.state = structuredClone(DEFAULT_STATE);
      }
    } catch (_) {
      this.state = structuredClone(DEFAULT_STATE);
    }
    return this.state;
  },

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch (_) {}
    this.listeners.forEach((fn) => fn(this.state));
  },

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  },

  isSubscribed(channelName) {
    const norm = (channelName || "").trim().toLowerCase();
    return this.state.subscriptions.some((c) => c.name.toLowerCase() === norm);
  },

  toggleSubscription(channel) {
    const name = (channel.name || "").trim();
    if (!name) return false;
    const norm = name.toLowerCase();
    const idx = this.state.subscriptions.findIndex((c) => c.name.toLowerCase() === norm);
    let added = false;
    if (idx >= 0) {
      this.state.subscriptions.splice(idx, 1);
    } else {
      this.state.subscriptions.unshift({
        id: channel.id || name,
        name,
        subscribedAt: Date.now(),
      });
      added = true;
    }
    this.save();
    return added;
  },

  createPlaylist(name) {
    const clean = (name || "").trim();
    if (!clean) return null;
    const pl = {
      id: `pl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: clean,
      items: [],
      createdAt: Date.now(),
    };
    this.state.playlists.unshift(pl);
    this.save();
    return pl;
  },

  deletePlaylist(playlistId) {
    this.state.playlists = this.state.playlists.filter((p) => p.id !== playlistId);
    this.save();
  },

  hasVideoInPlaylist(playlistId, videoId) {
    const pl = this.state.playlists.find((p) => p.id === playlistId);
    return Boolean(pl && pl.items.some((v) => v.id === videoId));
  },

  toggleVideoInPlaylist(playlistId, video) {
    const pl = this.state.playlists.find((p) => p.id === playlistId);
    if (!pl || !video || !video.id) return false;
    const idx = pl.items.findIndex((v) => v.id === video.id);
    let added = false;
    if (idx >= 0) {
      pl.items.splice(idx, 1);
    } else {
      pl.items.push({
        id: video.id,
        title: video.title,
        channel: video.channel,
        channel_id: video.channel_id || video.channel,
        duration: video.duration || 0,
        duration_text: video.duration_text || "0:00",
        thumbnail: video.thumbnail,
      });
      added = true;
    }
    this.save();
    return added;
  },

  removeVideoFromPlaylist(playlistId, videoId) {
    const pl = this.state.playlists.find((p) => p.id === playlistId);
    if (!pl) return;
    pl.items = pl.items.filter((v) => v.id !== videoId);
    this.save();
  },

  addHistory(video) {
    if (!video || !video.id) return;
    this.state.history = this.state.history.filter((v) => v.id !== video.id);
    this.state.history.unshift({
      id: video.id,
      title: video.title,
      channel: video.channel,
      channel_id: video.channel_id || video.channel,
      duration: video.duration || 0,
      duration_text: video.duration_text || "0:00",
      thumbnail: video.thumbnail,
      watchedAt: Date.now(),
    });
    if (this.state.history.length > 100) {
      this.state.history.length = 100;
    }
    this.save();
  },

  clearHistory() {
    this.state.history = [];
    this.save();
  },

  recordAdBlocked(seconds = 15) {
    this.state.stats.adsBlocked += 1;
    this.state.stats.secondsSaved += Math.max(0, Math.round(seconds));
    this.save();
  },

  updateSetting(key, value) {
    this.state.settings[key] = value;
    this.save();
  },

  updateSponsorCategory(category, enabled) {
    this.state.settings.sponsorCategories[category] = Boolean(enabled);
    this.save();
  },

  exportBackup() {
    return JSON.stringify(this.state, null, 2);
  },

  importBackup(jsonText) {
    const parsed = JSON.parse(jsonText);
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Tệp sao lưu không hợp lệ.");
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
    this.init();
    this.save();
  },
};

Store.init();
window.Store = Store;
