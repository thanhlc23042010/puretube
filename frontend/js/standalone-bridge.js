/*
 * PureTube On-Device Standalone Engine (Native Android & iOS over 4G/5G, Zero PC Needed)
 * Architecture inspired by YouTube Morphe (Android) & YouTubePlus/YouFixPlaybackIssues (iOS):
 * calls YouTube InnerTube (IOS & WEB), SponsorBlock, Google OAuth2 Device Flow, and Translation
 * directly through Capacitor's CORS-free native HTTP bridge (PureTubeNative).
 */
(function () {
  const OAUTH_STORAGE_KEY = "puretube_mobile_oauth_v1";
  const YT_TV_CLIENT_ID = "861556708454-d6dlm3lh05idd8npek18k6be8ba3oc68.apps.googleusercontent.com";
  const YT_TV_CLIENT_SECRET = "SboVhoG9s0rNafixCSGGKXAT";
  const IOS_UA = "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_1 like Mac OS X;)";
  const VISIONOS_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
  const AND_UA = "com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip";
  const WEB_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36";
  const TV_UA = "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version";
  const CHANNEL_TAB_PARAMS = {
    videos: "EgZ2aWRlb3PyBgQKAjoA",
    shorts: "EgZzaG9ydHPyBgUKA5oBAA%3D%3D",
    live: "EgdzdHJlYW1z8gYECgJ6AA%3D%3D",
    playlists: "EglwbGF5bGlzdHPyBgoKCEIGCgIQaCIA",
  };

  const TRENDING_QUERIES = {
    all: "nhạc trẻ việt nam thịnh hành mới nhất 2026",
    music: "MV ca nhạc mới nhất Vpop Chill",
    gaming: "review game mới nhất highlights tiếng việt",
    tech: "đánh giá công nghệ smartphone AI mới nhất tiếng việt",
    chill: "nhạc lofi chill không lời học bài làm việc",
  };

  const SPONSOR_META = {
    sponsor: { label: "Quảng cáo tài trợ", color: "#10B981" },
    selfpromo: { label: "Tự quảng cáo", color: "#F59E0B" },
    interaction: { label: "Nhắc bấm Like/Sub", color: "#EC4899" },
    intro: { label: "Đoạn mở đầu (Intro)", color: "#06B6D4" },
    outro: { label: "Đoạn kết (Outro)", color: "#3B82F6" },
    music_offtopic: { label: "Đoạn không phải nhạc", color: "#A855F7" },
  };

  const LANG_LABELS = {
    vi: "Tiếng Việt",
    "vi-vn": "Tiếng Việt",
    en: "Tiếng Anh",
    "en-us": "Tiếng Anh (Mỹ)",
    "en-gb": "Tiếng Anh (Anh)",
    ja: "Tiếng Nhật",
    ko: "Tiếng Hàn",
    zh: "Tiếng Trung",
    "zh-hans": "Tiếng Trung (Giản thể)",
    "zh-hant": "Tiếng Trung (Phồn thể)",
    fr: "Tiếng Pháp",
    de: "Tiếng Đức",
    es: "Tiếng Tây Ban Nha",
    ru: "Tiếng Nga",
    th: "Tiếng Thái",
    id: "Tiếng Indonesia",
  };

  let visitorCache = { value: "", expiresAt: 0 };
  const videoCache = new Map();
  const captionsCache = new Map();
  const searchCache = new Map();
  const dubbingCache = new Map();
  const ttsDataCache = new Map();
  let pendingDeviceFlow = null;

  function plugin() {
    return window.Capacitor?.Plugins?.PureTubeNative || null;
  }

  function isAvailable() {
    return Boolean(plugin());
  }

  function extractYtText(obj) {
    if (!obj) return "";
    if (typeof obj === "string") return obj;
    if (typeof obj.simpleText === "string") return obj.simpleText;
    if (Array.isArray(obj.runs)) return obj.runs.map((r) => r?.text || "").join("");
    if (typeof obj.content === "string") return obj.content;
    return "";
  }

  function extractVideoIdFromText(text) {
    const clean = (text || "").trim();
    if (/^[A-Za-z0-9_-]{11}$/.test(clean)) return clean;
    const m = clean.match(
      /(?:youtube\.com\/watch\?.*?v=|youtu\.be\/|youtube\.com\/shorts\/|youtube\.com\/embed\/)([A-Za-z0-9_-]{11})/
    );
    return m ? m[1] : null;
  }

  function parseDurationText(durText) {
    const clean = (durText || "").trim();
    if (!clean || !clean.includes(":")) return 0;
    const parts = clean.split(":").map((p) => parseInt(p, 10));
    if (parts.some((n) => Number.isNaN(n))) return 0;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return 0;
  }

  function parseViewCountText(viewText) {
    const s = (viewText || "").toLowerCase().trim();
    if (!s) return 0;
    const m = s.match(/([\d.,]+)\s*(tr|triệu|m|n|k|nghìn|b|tỷ)?/i);
    if (!m) {
      const digits = s.replace(/\D+/g, "");
      return digits ? parseInt(digits, 10) : 0;
    }
    const unit = (m[2] || "").toLowerCase();
    let numStr = m[1];
    if (unit) {
      numStr = numStr.replace(",", ".");
    } else {
      numStr = numStr.replace(/[.,]/g, "");
    }
    const base = parseFloat(numStr);
    if (Number.isNaN(base)) return 0;
    const mult =
      unit === "b" || unit === "tỷ"
        ? 1_000_000_000
        : unit === "tr" || unit === "triệu" || unit === "m"
          ? 1_000_000
          : unit === "n" || unit === "k" || unit === "nghìn"
            ? 1_000
            : 1;
    return Math.round(base * mult);
  }

  function formatLangLabel(langCode, note) {
    const code = (langCode || "").trim().toLowerCase();
    const shortCode = code.includes("-") ? code.split("-")[0] : code;
    const base = LANG_LABELS[code] || LANG_LABELS[shortCode] || (code ? code.toUpperCase() : "Âm thanh gốc");
    const n = (note || "").toLowerCase();
    if (n.includes("original")) return `${base} (Gốc)`;
    if (n.includes("dubbed")) return `${base} (Lồng tiếng YT)`;
    return base;
  }

  function labelForHeight(h, fpsVal) {
    const fpsTag = fpsVal >= 50 ? " 60fps" : "";
    if (h >= 2160) return `2160p (4K)${fpsTag}`;
    if (h >= 1440) return `1440p (2K)${fpsTag}`;
    if (h >= 1080) return `1080p FHD${fpsTag}`;
    if (h >= 720) return `720p HD${fpsTag}`;
    return `${h}p`;
  }

  function buildItem(vid, title, channel, durText = "", viewCount = 0, allowShort = false) {
    if (!vid || vid.length !== 11 || !title) return null;
    const dur = parseDurationText(durText);
    if (!allowShort && dur > 0 && dur < 45) return null;
    return {
      id: vid,
      title,
      channel: channel || "Kênh YouTube",
      channel_id: channel || "Kênh YouTube",
      duration: dur,
      duration_text: durText || "0:00",
      view_count: viewCount || 0,
      thumbnail: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
    };
  }

  function extractVideosFromInnerTube(payload, limit = 30, allowShort = false) {
    const results = [];
    const seen = new Set();

    const addItem = (item) => {
      if (!item || seen.has(item.id) || results.length >= limit) return;
      seen.add(item.id);
      results.push(item);
    };

    const hasAdBadge = (obj) => {
      const s = JSON.stringify(obj || {});
      return s.includes('"adBadgeViewModel"') || s.includes('"Sponsored"');
    };

    const findWatchId = (obj) => {
      if (!obj || typeof obj !== "object") return "";
      if (obj.watchEndpoint?.videoId) return obj.watchEndpoint.videoId;
      for (const val of Object.values(obj)) {
        if (val && typeof val === "object") {
          const found = findWatchId(val);
          if (found) return found;
        }
      }
      return "";
    };

    const walk = (node) => {
      if (results.length >= limit || !node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (const el of node) {
          walk(el);
          if (results.length >= limit) return;
        }
        return;
      }

      if (node.adSlotRenderer || node.inFeedAdLayoutRenderer || node.adBadgeViewModel) {
        return;
      }

      if (node.lockupViewModel && typeof node.lockupViewModel === "object") {
        const vm = node.lockupViewModel;
        const ctype = vm.contentType || "";
        const vid = vm.contentId || findWatchId(vm);
        if (
          ![
            "LOCKUP_CONTENT_TYPE_SHORT",
            "LOCKUP_CONTENT_TYPE_CHANNEL",
            "LOCKUP_CONTENT_TYPE_PLAYLIST",
            "LOCKUP_CONTENT_TYPE_ALBUM",
          ].includes(ctype) &&
          !hasAdBadge(vm)
        ) {
          const meta = vm.metadata?.lockupMetadataViewModel || {};
          const title = extractYtText(meta.title);
          const rows = meta.metadata?.contentMetadataViewModel?.metadataRows || [];
          const texts = [];
          for (const r of rows) {
            for (const part of r.metadataParts || []) {
              const t = extractYtText(part?.text);
              if (t) texts.push(t);
            }
          }
          const channel = texts[0] || "Kênh YouTube";
          const viewTxt = texts.slice(1).find((t) => /lượt xem|view/i.test(t)) || "";
          let durText = "";
          for (const ov of vm.contentImage?.thumbnailViewModel?.overlays || []) {
            for (const b of ov.thumbnailBottomOverlayViewModel?.badges || []) {
              const tb = b?.thumbnailBadgeViewModel?.text || "";
              if (tb.includes(":")) {
                durText = tb;
                break;
              }
            }
          }
          addItem(buildItem(String(vid || ""), title, channel, durText, parseViewCountText(viewTxt), allowShort));
        }
      }

      if (node.tileRenderer && typeof node.tileRenderer === "object") {
        const tr = node.tileRenderer;
        if (!hasAdBadge(tr)) {
          const vid = tr.contentId || findWatchId(tr.onSelectCommand);
          const tmeta = tr.metadata?.tileMetadataRenderer || {};
          const title = extractYtText(tmeta.title);
          const lineTexts = [];
          for (const line of tmeta.lines || []) {
            for (const item of line?.lineRenderer?.items || []) {
              const txt = extractYtText(item?.lineItemRenderer?.text);
              if (txt && txt !== "•" && txt !== "·") {
                lineTexts.push(txt);
              }
            }
          }
          const channel = lineTexts[0] || "Kênh YouTube";
          const viewTxt = lineTexts.find((t) => /lượt xem|view/i.test(t)) || "";
          let durText = "";
          for (const ov of tr.header?.tileHeaderRenderer?.thumbnailOverlays || []) {
            const ts = ov?.thumbnailOverlayTimeStatusRenderer?.text;
            if (ts) {
              durText = extractYtText(ts);
              break;
            }
          }
          addItem(buildItem(String(vid || ""), title, channel, durText, parseViewCountText(viewTxt), allowShort));
        }
      }

      for (const key of ["videoRenderer", "compactVideoRenderer", "gridVideoRenderer", "playlistVideoRenderer"]) {
        if (node[key] && typeof node[key] === "object") {
          const vr = node[key];
          const vid = vr.videoId || "";
          const title = extractYtText(vr.title || vr.headline);
          const channel = extractYtText(vr.ownerText || vr.shortBylineText || vr.longBylineText);
          const durText = extractYtText(vr.lengthText);
          const views = parseViewCountText(extractYtText(vr.viewCountText || vr.shortViewCountText));
          addItem(buildItem(String(vid), title, channel, durText, views, allowShort));
        }
      }

      for (const val of Object.values(node)) {
        if (val && typeof val === "object") walk(val);
      }
    };

    walk(payload);
    return results;
  }

  async function nativeHttpGet(url, headers = {}) {
    const p = plugin();
    if (!p) throw new Error("PureTubeNative plugin không khả dụng.");
    return p.httpGet({ url, headers });
  }

  async function nativeHttpPostJson(url, payload, headers = {}) {
    const p = plugin();
    if (!p) throw new Error("PureTubeNative plugin không khả dụng.");
    return p.httpPostJson({
      url,
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json", ...headers },
    });
  }

  async function nativeHttpPostForm(url, form, headers = {}) {
    const p = plugin();
    if (!p) throw new Error("PureTubeNative plugin không khả dụng.");
    return p.httpPostForm({ url, form, headers });
  }

  async function getVisitorData() {
    const now = Date.now();
    if (visitorCache.value && now < visitorCache.expiresAt) return visitorCache.value;
    try {
      const res = await nativeHttpGet("https://www.youtube.com/sw.js_data", {
        "User-Agent": "Mozilla/5.0",
      });
      if (res.status === 200 && res.body) {
        const m = res.body.match(/Cg[A-Za-z0-9_-]{10,}/);
        if (m) {
          visitorCache = { value: m[0], expiresAt: now + 3600 * 1000 };
          return m[0];
        }
      }
    } catch (_) {}
    return visitorCache.value || "";
  }

  async function searchInnerTube(query, limit = 18) {
    const key = `s:${query.toLowerCase()}:${limit}`;
    const cached = searchCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.items;

    const visitorData = await getVisitorData();
    const res = await nativeHttpPostJson(
      "https://www.youtube.com/youtubei/v1/search?prettyPrint=false",
      {
        query,
        context: {
          client: {
            clientName: "WEB",
            clientVersion: "2.20250312.04.00",
            hl: "vi",
            gl: "VN",
            ...(visitorData ? { visitorData } : {}),
          },
        },
      },
      { "User-Agent": WEB_UA }
    );
    if (res.status !== 200) throw new Error(`Lỗi tìm kiếm YouTube (${res.status})`);
    const items = extractVideosFromInnerTube(JSON.parse(res.body), limit);
    searchCache.set(key, { expiresAt: Date.now() + 10 * 60 * 1000, items });
    return items;
  }

  function classifyStreams(streamingData) {
    const combinedByHeight = new Map();
    const videoOnlyByHeight = new Map();
    const audioByLang = new Map();

    const processFormat = (fmt, isAdaptive) => {
      const streamUrl = fmt?.url;
      const fmtId = String(fmt?.itag ?? "");
      if (!streamUrl || !fmtId) return;

      const mimeRaw = fmt.mimeType || "";
      const mimeBase = mimeRaw.split(";")[0].trim().toLowerCase();
      const codecMatch = mimeRaw.match(/codecs="([^"]+)"/);
      const codecs = codecMatch ? codecMatch[1] : "";
      const isAudioOnly = mimeBase.startsWith("audio/");
      const isVideoOnly = isAdaptive && mimeBase.startsWith("video/");
      const vcodec = isAudioOnly ? "none" : codecs.split(",")[0].trim() || "avc1";
      const acodec = isAudioOnly
        ? codecs
        : isVideoOnly
          ? "none"
          : codecs.split(",").pop()?.trim() || "mp4a";
      const ext = mimeBase === "audio/mp4" ? "m4a" : mimeBase.includes("mp4") ? "mp4" : "webm";
      const height = fmt.height || 0;
      const fps = fmt.fps || 30;
      const tbr = (fmt.bitrate || 0) / 1000;
      const contentLen = Number(fmt.contentLength || 0) || 0;
      const cleanMime = mimeBase || (isAudioOnly ? "audio/mp4" : "video/mp4");

      if (!isAudioOnly && acodec !== "none" && height >= 144) {
        const score = (ext === "mp4" ? 1000 : 0) + (vcodec.startsWith("avc1") ? 500 : 0) + tbr;
        const prev = combinedByHeight.get(height);
        if (!prev || score > prev._score) {
          combinedByHeight.set(height, {
            id: fmtId,
            height,
            fps,
            has_audio: true,
            ext,
            vcodec,
            stream_url: streamUrl,
            _mime: cleanMime,
            _len: contentLen,
            _score: score,
          });
        }
      } else if (isVideoOnly && height >= 144) {
        const score =
          (ext === "mp4" && vcodec.startsWith("avc1") ? 2000 : 0) +
          (ext === "mp4" ? 1000 : 0) +
          (vcodec.includes("vp9") ? 200 : 0) +
          (fps >= 50 ? 100 : 0) +
          tbr;
        const prev = videoOnlyByHeight.get(height);
        if (!prev || score > prev._score) {
          videoOnlyByHeight.set(height, {
            id: fmtId,
            height,
            fps,
            has_audio: false,
            ext,
            vcodec,
            stream_url: streamUrl,
            _mime: cleanMime,
            _len: contentLen,
            _score: score,
          });
        }
      } else if (isAudioOnly) {
        const audioTrack = fmt.audioTrack || {};
        const trackId = String(audioTrack.id || "");
        const lang = trackId ? trackId.split(".")[0].toLowerCase() : "";
        const displayName = String(audioTrack.displayName || "").toLowerCase();
        const isOrig = Boolean(audioTrack.audioIsDefault) || !lang;
        const langKey = lang.startsWith("vi") ? "vi" : isOrig ? "original" : lang;
        const fmtNote = audioTrack.audioIsDefault
          ? "original"
          : trackId || displayName.includes("lồng tiếng") || displayName.includes("dubbed")
            ? "dubbed"
            : "";
        const score = (ext === "m4a" || acodec.includes("mp4a") ? 2500 : 0) + (ext === "mp4" ? 500 : 0) + tbr;
        const prev = audioByLang.get(langKey);
        if (!prev || score > prev._score) {
          audioByLang.set(langKey, {
            id: fmtId,
            lang: langKey,
            raw_lang: lang,
            label: formatLangLabel(lang || "original", fmtNote),
            is_vi: langKey === "vi",
            is_original: isOrig,
            ext,
            stream_url: streamUrl,
            _mime: cleanMime,
            _len: contentLen,
            _score: score,
          });
        }
      }
    };

    (streamingData?.formats || []).forEach((f) => processFormat(f, false));
    (streamingData?.adaptiveFormats || []).forEach((f) => processFormat(f, true));

    const audioTracks = Array.from(audioByLang.values()).sort((a, b) => {
      const rank = (x) => (x.is_vi ? 0 : x.is_original ? 1 : 2);
      return rank(a) - rank(b) || b._score - a._score;
    });
        audioTracks.forEach((t) => {
          delete t._score;
        });

    const viAudio = audioTracks.find((t) => t.is_vi) || null;
    const origAudio = audioTracks.find((t) => t.is_original) || null;
    const defaultAudio = viAudio || origAudio || audioTracks[0] || null;

    const targetHeights = [2160, 1440, 1080, 720, 480, 360, 240, 144];
    const allHeights = Array.from(new Set([...combinedByHeight.keys(), ...videoOnlyByHeight.keys()])).sort(
      (a, b) => b - a
    );
    const seenHeights = new Set();
    const qualities = [];

    for (const h of allHeights) {
      const nearest = targetHeights.reduce((best, t) => (Math.abs(t - h) < Math.abs(best - h) ? t : best), targetHeights[0]);
      const bucket = Math.abs(nearest - h) <= 40 ? nearest : h;
      if (seenHeights.has(bucket)) continue;

      let chosen = null;
      if (h <= 720 && combinedByHeight.has(h) && !viAudio) {
        chosen = combinedByHeight.get(h);
      } else if (videoOnlyByHeight.has(h) && defaultAudio) {
        chosen = videoOnlyByHeight.get(h);
      } else if (combinedByHeight.has(h)) {
        chosen = combinedByHeight.get(h);
      }

      if (chosen) {
        seenHeights.add(bucket);
        qualities.push({
          id: chosen.id,
          height: bucket,
          label: labelForHeight(bucket, chosen.fps),
          fps: chosen.fps,
          has_audio: chosen.has_audio,
          ext: chosen.ext,
          stream_url: chosen.stream_url,
          _mime: chosen._mime,
          _len: chosen._len,
        });
      }
    }

    let defaultQuality = null;
    if (viAudio) {
      defaultQuality = qualities.find((q) => !q.has_audio && q.height <= 1080) || null;
    }
    if (!defaultQuality) {
      defaultQuality = qualities.find((q) => q.has_audio && q.height >= 720) || qualities.find((q) => q.has_audio) || null;
    }
    if (!defaultQuality && qualities.length) {
      defaultQuality = qualities.find((q) => q.height <= 1080) || qualities[0];
    }

    return {
      qualities,
      default_quality: defaultQuality,
      audio_tracks: audioTracks,
      has_youtube_vi_dub: Boolean(viAudio),
      default_audio_track: defaultAudio,
      audio_stream_url: defaultAudio ? defaultAudio.stream_url : null,
    };
  }

  function readOAuth() {
    try {
      const raw = localStorage.getItem(OAUTH_STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function writeOAuth(obj) {
    if (!obj) {
      localStorage.removeItem(OAUTH_STORAGE_KEY);
      return;
    }
    localStorage.setItem(OAUTH_STORAGE_KEY, JSON.stringify(obj));
  }

  async function getValidAccessToken(forceRefresh = false) {
    const tok = readOAuth();
    if (!tok?.access_token) return null;
    if (!forceRefresh && Date.now() < (tok.expires_at || 0) - 60_000) {
      return tok.access_token;
    }
    if (!tok.refresh_token) return tok.access_token;
    try {
      const res = await nativeHttpPostForm("https://www.youtube.com/o/oauth2/token", {
        client_id: YT_TV_CLIENT_ID,
        client_secret: YT_TV_CLIENT_SECRET,
        refresh_token: tok.refresh_token,
        grant_type: "refresh_token",
      });
      if (res.status === 200) {
        const refreshed = JSON.parse(res.body);
        if (refreshed.access_token) {
          tok.access_token = refreshed.access_token;
          tok.expires_at = Date.now() + Number(refreshed.expires_in || 3600) * 1000;
          writeOAuth(tok);
          return tok.access_token;
        }
      }
    } catch (_) {}
    return tok.access_token;
  }

  async function detectAccountName(token) {
    try {
      const res = await nativeHttpPostJson(
        "https://www.youtube.com/youtubei/v1/account/account_menu?prettyPrint=false",
        {
          context: { client: { clientName: "WEB", clientVersion: "2.20250312.04.00", hl: "vi", gl: "VN" } },
        },
        { Authorization: `Bearer ${token}`, "User-Agent": WEB_UA }
      );
      if (res.status === 200 && res.body) {
        const m =
          res.body.match(/"accountName"\s*:\s*\{\s*"simpleText"\s*:\s*"([^"]+)"/) ||
          res.body.match(/"channelHandle"\s*:\s*\{\s*"simpleText"\s*:\s*"([^"]+)"/);
        if (m) return m[1];
      }
    } catch (_) {}
    return "Tài khoản Google (YouTube)";
  }

  async function syncWatchHistory(videoId, playbackData = null) {
    const token = await getValidAccessToken();
    if (!token) return;
    try {
      const headers = {
        Authorization: `Bearer ${token}`,
        "User-Agent": TV_UA,
        Origin: "https://www.youtube.com",
      };
      const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
      let cpn = "";
      for (let i = 0; i < 16; i += 1) cpn += chars[Math.floor(Math.random() * chars.length)];

      let pt = playbackData?.playbackTracking || null;
      let len = playbackData?.videoDetails?.lengthSeconds || "60";
      if (!pt?.videostatsPlaybackUrl?.baseUrl) {
        const res = await nativeHttpPostJson(
          "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
          {
            context: { client: { clientName: "TVHTML5", clientVersion: "7.20250312.16.00", hl: "vi", gl: "VN" } },
            videoId,
            cpn,
          },
          headers
        );
        if (res.status === 200) {
          const pdata = JSON.parse(res.body);
          pt = pdata?.playbackTracking || null;
          len = pdata?.videoDetails?.lengthSeconds || len;
        }
      }
      let pbUrl = pt?.videostatsPlaybackUrl?.baseUrl;
      if (!pbUrl) return;
      if (!pbUrl.startsWith("http")) pbUrl = `https://www.youtube.com${pbUrl}`;
      const sep1 = pbUrl.includes("?") ? "&" : "?";
      await nativeHttpGet(`${pbUrl}${sep1}cpn=${cpn}&ver=2&cmt=0&len=${len}&el=leanback&ns=yt`, headers);

      let wtUrl = pt?.videostatsWatchtimeUrl?.baseUrl;
      if (wtUrl) {
        if (!wtUrl.startsWith("http")) wtUrl = `https://www.youtube.com${wtUrl}`;
        const sep2 = wtUrl.includes("?") ? "&" : "?";
        await nativeHttpGet(
          `${wtUrl}${sep2}cpn=${cpn}&ver=2&cmt=10.0&st=0.0&et=10.0&rt=10.2&len=${len}&state=playing&el=leanback&ns=yt&final=1`,
          headers
        );
      }
    } catch (_) {}
  }

  async function fetchInnerTubeBrowse(browseId, limit = 36, allowShort = false) {
    let token = await getValidAccessToken();
    if (!token) throw new Error("Bạn chưa đăng nhập tài khoản Google/YouTube.");
    const clients = [
      { name: "TVHTML5", ver: "7.20250312.16.00", ua: TV_UA },
      { name: "WEB", ver: "2.20250312.04.00", ua: WEB_UA },
    ];
    for (const cl of clients) {
      let res = await nativeHttpPostJson(
        "https://www.youtube.com/youtubei/v1/browse?prettyPrint=false",
        { context: { client: { clientName: cl.name, clientVersion: cl.ver, hl: "vi", gl: "VN" } }, browseId },
        { Authorization: `Bearer ${token}`, "User-Agent": cl.ua }
      );
      if (res.status === 401) {
        token = (await getValidAccessToken(true)) || token;
        res = await nativeHttpPostJson(
          "https://www.youtube.com/youtubei/v1/browse?prettyPrint=false",
          { context: { client: { clientName: cl.name, clientVersion: cl.ver, hl: "vi", gl: "VN" } }, browseId },
          { Authorization: `Bearer ${token}`, "User-Agent": cl.ua }
        );
      }
      if (res.status === 200) {
        const items = extractVideosFromInnerTube(JSON.parse(res.body), limit, allowShort);
        if (items.length) return items;
      }
    }
    return [];
  }

  function mergeJson3IntoSentences(json3Data) {
    const rawItems = [];
    for (const ev of json3Data?.events || []) {
      const text = (ev.segs || [])
        .map((s) => s?.utf8 || "")
        .join("")
        .replace(/\s+/g, " ")
        .trim();
      if (!text || ["[Music]", "[Applause]", "[Laughter]", "[Âm nhạc]", "[Vỗ tay]"].includes(text)) continue;
      const start = Number(ev.tStartMs || 0) / 1000;
      const dur = Number(ev.dDurationMs || 2000) / 1000;
      rawItems.push({ start, end: start + Math.max(0.8, dur), text });
    }
    if (!rawItems.length) return [];

    const sentences = [];
    let bufText = rawItems[0].text;
    let bufStart = rawItems[0].start;
    let bufEnd = rawItems[0].end;

    for (let i = 1; i < rawItems.length; i += 1) {
      const item = rawItems[i];
      const gap = item.start - bufEnd;
      const durSoFar = bufEnd - bufStart;
      const endsPunct = /[.!?。！？]$/.test(bufText);
      if (item.text === bufText || bufText.endsWith(item.text)) {
        bufEnd = Math.max(bufEnd, item.end);
        continue;
      }
      if (endsPunct || gap > 0.75 || durSoFar >= 5.2 || bufText.length + item.text.length > 135) {
        sentences.push({
          start: Math.round(bufStart * 100) / 100,
          end: Math.round(Math.max(bufEnd, bufStart + 1.2) * 100) / 100,
          text: bufText.trim(),
        });
        bufText = item.text;
        bufStart = item.start;
        bufEnd = item.end;
      } else {
        bufText = `${bufText} ${item.text}`.trim();
        bufEnd = Math.max(bufEnd, item.end);
      }
    }
    if (bufText.trim()) {
      sentences.push({
        start: Math.round(bufStart * 100) / 100,
        end: Math.round(Math.max(bufEnd, bufStart + 1.2) * 100) / 100,
        text: bufText.trim(),
      });
    }
    return sentences;
  }

  async function translateTextsToVi(texts) {
    if (!texts.length) return [];
    const results = [...texts];
    const batchSize = 10;
    const tasks = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      const chunk = texts.slice(i, i + batchSize);
      const startIdx = i;
      tasks.push(
        (async () => {
          try {
            const joined = chunk.join("\n|||PT_SEP|||\n");
            const url = `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=vi&q=${encodeURIComponent(joined)}`;
            const res = await nativeHttpGet(url, { "User-Agent": WEB_UA });
            if (res.status === 200) {
              const data = JSON.parse(res.body);
              if (Array.isArray(data) && data.length) {
                const tr = Array.isArray(data[0]) ? data[0][0] : String(data[0]);
                const parts = String(tr)
                  .split(/\|\|\|\s*PT_SEP\s*\|\|\|/)
                  .map((p) => p.trim());
                if (parts.length === chunk.length) {
                  parts.forEach((v, idx) => {
                    results[startIdx + idx] = v || chunk[idx];
                  });
                  return;
                }
              }
            }
          } catch (_) {}
        })()
      );
    }
    await Promise.all(tasks);
    return results;
  }

  async function requestPlayerClient(vid, visitorData, clientConfig, ua, extraHeaders = {}) {
    const res = await nativeHttpPostJson(
      "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
      {
        videoId: vid,
        context: {
          client: {
            ...clientConfig,
            hl: "vi",
            gl: "VN",
            ...(visitorData ? { visitorData } : {}),
          },
        },
        contentCheckOk: true,
        racyCheckOk: true,
      },
      {
        "User-Agent": ua,
        ...(visitorData ? { "X-Goog-Visitor-Id": visitorData } : {}),
        ...extraHeaders,
      }
    );
    if (res.status !== 200) {
      throw new Error(`Không thể tải luồng phát (${res.status})`);
    }
    const data = JSON.parse(res.body);
    const status = data?.playabilityStatus?.status;
    if (status !== "OK") {
      throw new Error(data?.playabilityStatus?.reason || "Video không khả dụng để phát.");
    }
    return { data, ua };
  }

  async function fetchPlayerWithFallback(vid, visitorData) {
    // VISIONOS unlocks non-403 seekable adaptive streams (45KB indexRange) & VOD/Live HLS without PoToken caps
    const clients = [
      {
        client: {
          clientName: "VISIONOS",
          clientVersion: "1.02",
          deviceMake: "Apple",
          deviceModel: "RealityDevice17,1",
          osName: "visionOS",
          osVersion: "26.5.23O471",
        },
        ua: VISIONOS_UA,
        extraHeaders: {
          Origin: "https://www.youtube.com",
          "X-YouTube-Client-Name": "101",
          "X-YouTube-Client-Version": "1.02",
        },
      },
      {
        client: {
          clientName: "ANDROID",
          clientVersion: "20.10.38",
          androidSdkVersion: 34,
          osName: "Android",
          osVersion: "14",
        },
        ua: AND_UA,
        extraHeaders: {},
      },
      {
        client: {
          clientName: "IOS",
          clientVersion: "20.10.4",
          deviceMake: "Apple",
          deviceModel: "iPhone16,2",
          osName: "iPhone",
          osVersion: "18.3.1.22D72",
        },
        ua: IOS_UA,
        extraHeaders: {},
      },
    ];

    let lastErr = null;
    for (const candidate of clients) {
      try {
        const result = await requestPlayerClient(
          vid,
          visitorData,
          candidate.client,
          candidate.ua,
          candidate.extraHeaders || {}
        );
        const sd = result.data?.streamingData || {};
        const hasStreams =
          (sd.formats || []).length > 0 || (sd.adaptiveFormats || []).length > 0 || Boolean(sd.hlsManifestUrl);
        if (hasStreams) return result;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error("Không thể tải luồng phát từ YouTube.");
  }

  async function webInnerTubePost(endpoint, body = {}) {
    const visitorData = await getVisitorData();
    const res = await nativeHttpPostJson(
      `https://www.youtube.com/youtubei/v1/${endpoint}?prettyPrint=false`,
      {
        ...body,
        context: {
          client: {
            clientName: "WEB",
            clientVersion: "2.20250312.04.00",
            hl: "vi",
            gl: "VN",
            ...(visitorData ? { visitorData } : {}),
          },
        },
      },
      {
        "User-Agent": WEB_UA,
        ...(visitorData ? { "X-Goog-Visitor-Id": visitorData } : {}),
      }
    );
    if (res.status !== 200) throw new Error(`YouTube phản hồi lỗi (${res.status}).`);
    return JSON.parse(res.body);
  }

  async function tvInnerTubePost(endpoint, body = {}) {
    let token = await getValidAccessToken();
    if (!token) throw new Error("Vui lòng đăng nhập Tài khoản Google để sử dụng tính năng này.");
    const send = (tok) =>
      nativeHttpPostJson(
        `https://www.youtube.com/youtubei/v1/${endpoint}?prettyPrint=false`,
        {
          ...body,
          context: { client: { clientName: "TVHTML5", clientVersion: "7.20250312.14.00", hl: "vi", gl: "VN" } },
        },
        { Authorization: `Bearer ${tok}`, "User-Agent": TV_UA }
      );
    let res = await send(token);
    if (res.status === 401) {
      token = (await getValidAccessToken(true)) || token;
      res = await send(token);
    }
    if (res.status !== 200) throw new Error(`YouTube từ chối thao tác (${res.status}).`);
    return JSON.parse(res.body);
  }

  function extractShortsFromInnerTube(payload, limit = 30) {
    const results = [];
    const seen = new Set();
    const addShort = (vid, title, channel = "YouTube Shorts", viewTxt = "") => {
      if (!vid || !/^[A-Za-z0-9_-]{11}$/.test(vid) || seen.has(vid) || results.length >= limit) return;
      seen.add(vid);
      results.push({
        id: vid,
        title: title || "YouTube Short",
        channel: channel || "YouTube Shorts",
        channel_id: "",
        duration: 60,
        duration_text: "Short",
        view_count: parseViewCountText(viewTxt),
        is_short: true,
        thumbnail: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
      });
    };
    const walk = (node) => {
      if (results.length >= limit || !node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (const el of node) walk(el);
        return;
      }
      if (node.shortsLockupViewModel && typeof node.shortsLockupViewModel === "object") {
        const vm = node.shortsLockupViewModel;
        const vid = vm.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId || "";
        const acc = String(vm.accessibilityText || "").split("– phát video")[0].trim();
        addShort(String(vid), acc || "YouTube Short", "YouTube Shorts", acc);
      }
      if (node.reelItemRenderer && typeof node.reelItemRenderer === "object") {
        const rr = node.reelItemRenderer;
        addShort(String(rr.videoId || ""), extractYtText(rr.headline), "YouTube Shorts", extractYtText(rr.viewCountText));
      }
      if (node.videoRenderer && typeof node.videoRenderer === "object") {
        const vr = node.videoRenderer;
        const vid = String(vr.videoId || "");
        if (vid && JSON.stringify(vr).includes("reelWatchEndpoint")) {
          const chName = extractYtText(vr.ownerText || vr.longBylineText || vr.shortBylineText) || "YouTube Shorts";
          addShort(vid, extractYtText(vr.title), chName, extractYtText(vr.shortViewCountText || vr.viewCountText));
        }
      }
      if (node.lockupViewModel?.contentType === "LOCKUP_CONTENT_TYPE_SHORT") {
        const vm = node.lockupViewModel;
        addShort(String(vm.contentId || ""), extractYtText(vm.metadata?.lockupMetadataViewModel?.title));
      }
      for (const val of Object.values(node)) {
        if (val && typeof val === "object") walk(val);
      }
    };
    walk(payload);
    return results;
  }

  function extractPlaylistsFromInnerTube(payload) {
    const results = [];
    const seen = new Set();
    const walk = (node) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (const el of node) walk(el);
        return;
      }
      if (node.playlistAddToOptionRenderer) {
        const opt = node.playlistAddToOptionRenderer;
        const pid = opt.playlistId || "";
        if (pid && !seen.has(pid)) {
          seen.add(pid);
          results.push({
            id: pid,
            title: extractYtText(opt.title) || pid,
            privacy: String(opt.privacy || ""),
            contains_selected: opt.containsSelectedVideos === "ALL",
            count_text: "",
            thumbnail: "",
          });
        }
      }
      if (node.lockupViewModel && ["LOCKUP_CONTENT_TYPE_PLAYLIST", "LOCKUP_CONTENT_TYPE_ALBUM"].includes(node.lockupViewModel.contentType)) {
        const vm = node.lockupViewModel;
        const pid = vm.contentId || "";
        if (pid && !seen.has(pid)) {
          seen.add(pid);
          results.push({
            id: pid,
            title: extractYtText(vm.metadata?.lockupMetadataViewModel?.title) || pid,
            privacy: "",
            contains_selected: false,
            count_text: "",
            thumbnail: "",
          });
        }
      }
      for (const pk of ["gridPlaylistRenderer", "playlistRenderer", "compactPlaylistRenderer"]) {
        if (node[pk] && typeof node[pk] === "object") {
          const pr = node[pk];
          const pid = pr.playlistId || "";
          if (pid && !seen.has(pid)) {
            seen.add(pid);
            const thumbs = pr.thumbnail?.thumbnails || pr.thumbnails?.[0]?.thumbnails || [];
            results.push({
              id: pid,
              title: extractYtText(pr.title) || pid,
              privacy: "",
              contains_selected: false,
              count_text: extractYtText(pr.videoCountText || pr.videoCountShortText),
              thumbnail: thumbs.length ? thumbs[thumbs.length - 1].url || "" : "",
            });
          }
        }
      }
      for (const val of Object.values(node)) {
        if (val && typeof val === "object") walk(val);
      }
    };
    walk(payload);
    return results;
  }

  function parseCommentsPayload(data) {
    const muts = data?.frameworkUpdates?.entityBatchUpdate?.mutations || [];
    const comments = [];
    const map = new Map();
    for (const mut of muts) {
      const cep = mut?.payload?.commentEntityPayload;
      if (!cep) continue;
      const props = cep.properties || {};
      const cid = props.commentId || "";
      if (!cid) continue;
      const author = cep.author || {};
      const tb = cep.toolbar || {};
      const entry = {
        id: cid,
        author: author.displayName || "Người xem",
        author_channel_id: author.channelId || "",
        avatar: author.avatarThumbnailUrl || "",
        is_creator: Boolean(author.isCreator),
        text: props.content?.content || "",
        published: props.publishedTime || "",
        likes: String(tb.likeCountNotliked || "").trim(),
        reply_count: String(tb.replyCount || "").trim(),
        hearted: Boolean(tb.heartActiveTooltip),
        reply_token: "",
      };
      comments.push(entry);
      map.set(cid, entry);
    }

    let nextToken = "";
    const walkEps = (node) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (const el of node) walkEps(el);
        return;
      }
      if (node.commentThreadRenderer) {
        const ct = node.commentThreadRenderer;
        const ckey = ct.commentViewModel?.commentViewModel?.commentId || "";
        const reps = ct.replies?.commentRepliesRenderer?.contents || [];
        for (const rc of reps) {
          const tok = rc?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token || "";
          if (tok) {
            if (ckey && map.has(ckey)) {
              map.get(ckey).reply_token = tok;
            } else {
              const rawS = JSON.stringify(ct);
              const found = comments.find((c) => !c.reply_token && rawS.includes(c.id));
              if (found) found.reply_token = tok;
            }
          }
        }
        return;
      }
      if (node.continuationItemRenderer && !nextToken) {
        const ci = node.continuationItemRenderer;
        const tok =
          ci.continuationEndpoint?.continuationCommand?.token ||
          ci.button?.buttonRenderer?.command?.continuationCommand?.token ||
          "";
        if (tok) nextToken = tok;
      }
      for (const val of Object.values(node)) {
        if (val && typeof val === "object") walkEps(val);
      }
    };
    walkEps(data?.onResponseReceivedEndpoints || []);
    return { comments, next_continuation: nextToken };
  }

  async function fetchVideoNextMeta(vid) {
    try {
      const data = await webInnerTubePost("next", { videoId: vid });
      const rawS = JSON.stringify(data);
      const chMatch = rawS.match(/"channelId"\s*:\s*"(UC[A-Za-z0-9_-]{22})"/);
      const subMatch = rawS.match(/"subscriberCountText"\s*:\s*\{\s*"accessibility"\s*:\s*\{\s*"accessibilityData"\s*:\s*\{\s*"label"\s*:\s*"([^"]+)"/);
      const likeMatch =
        rawS.match(/"iconName"\s*:\s*"LIKE"\s*,\s*"title"\s*:\s*"([^"]+)"/) ||
        rawS.match(/"accessibilityText"\s*:\s*"[^"]*?([\d.,]+\s*[NTKMBtr]*)\s*(?:người khác thích|lượt thích|likes?)"/i);
      const avatarMatch = rawS.match(/"videoOwnerRenderer".*?"url"\s*:\s*"(https:\/\/yt3\.[^"]+)"/);
      const cmtCountMatch = rawS.match(/"commentsHeaderRenderer".*?"countText"\s*:\s*\{[^}]*?"(?:simpleText|text)"\s*:\s*"([^"]+)"/);
      let cmtToken = "";
      for (const p of data?.engagementPanels || []) {
        const ps = JSON.stringify(p);
        if (ps.includes("engagement-panel-comments-section")) {
          const m = ps.match(/"token"\s*:\s*"([^"]+)"/);
          if (m) {
            cmtToken = m[1];
            break;
          }
        }
      }
      const related = extractVideosFromInnerTube(data, 14).filter((it) => it.id !== vid).slice(0, 8);
      return {
        channel_id: chMatch ? chMatch[1] : "",
        subscriber_count_text: subMatch ? subMatch[1] : "",
        like_count_text: likeMatch ? likeMatch[1].trim() : "",
        channel_avatar: avatarMatch ? avatarMatch[1] : "",
        comment_count_text: cmtCountMatch ? cmtCountMatch[1] : "",
        comments_token: cmtToken,
        related,
      };
    } catch (_) {
      return {};
    }
  }

  async function wrapStreamsWithNativeProxy(classified, ua) {
    const p = plugin();
    const canProxy = Boolean(p && typeof p.registerStream === "function");
    const urlMap = new Map();

    const registerItem = async (item) => {
      if (!item || !item.stream_url) return;
      const rawUrl = item.stream_url;
      item.raw_url = rawUrl;
      item.raw_ua = ua;
      item.raw_len = item._len || 0;
      item.raw_mime = item._mime || "video/mp4";
      if (canProxy) {
        let proxyPromise = urlMap.get(rawUrl);
        if (!proxyPromise) {
          proxyPromise = p
            .registerStream({
              url: rawUrl,
              headers: { "User-Agent": ua },
              contentLength: item._len || 0,
              mimeType: item._mime || "video/mp4",
            })
            .then((r) => r?.proxyUrl || rawUrl)
            .catch(() => rawUrl);
          urlMap.set(rawUrl, proxyPromise);
        }
        item.stream_url = await proxyPromise;
      }
      delete item._mime;
      delete item._len;
    };

    await Promise.all([
      ...(classified.qualities || []).map(registerItem),
      ...(classified.audio_tracks || []).map(registerItem),
    ]);
    classified.audio_stream_url = classified.default_audio_track ? classified.default_audio_track.stream_url : null;
  }

  const PureStandaloneBridge = {
    isAvailable,

    getInfo() {
      return {
        ip: "127.0.0.1",
        port: 0,
        lan_url: "PureTube App Độc Lập (4G/5G)",
        public_url: "app://puretube",
        server_mode: "standalone",
        yt_dlp_version: "innertube-native",
        ffmpeg_available: false,
      };
    },

    async getTrending(category = "all") {
      if (category === "all" && readOAuth()?.access_token) {
        try {
          const items = await fetchInnerTubeBrowse("FEwhat_to_watch", 32);
          if (items.length) return { category, personalized: true, items };
        } catch (_) {}
      }
      const q = TRENDING_QUERIES[category] || TRENDING_QUERIES.all;
      return { category, personalized: false, items: await searchInnerTube(q, 16) };
    },

    async getShorts(q = "") {
      try {
        const cleanQ = (q || "").trim();
        const queries = cleanQ ? [cleanQ] : ["#shorts", "shorts hài hước việt nam"];
        const items = [];
        const seen = new Set();
        for (const query of queries) {
          try {
            const data = await webInnerTubePost("search", { query });
            for (const it of extractShortsFromInnerTube(data, 30)) {
              if (it?.id && !seen.has(it.id)) {
                seen.add(it.id);
                items.push(it);
              }
            }
          } catch (_) {}
          if (items.length >= 24) break;
        }
        return { items: items.slice(0, 24) };
      } catch (_) {
        return { items: [] };
      }
    },

    async search(query, limit = 18) {
      const directId = extractVideoIdFromText(query);
      if (directId) return { query, direct_video_id: directId, items: [] };
      return { query, items: await searchInnerTube(query, limit) };
    },

    async suggest(query) {
      try {
        const res = await nativeHttpGet(
          `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&hl=vi&q=${encodeURIComponent(query.trim())}`
        );
        if (res.status === 200) {
          const d = JSON.parse(res.body);
          return { suggestions: Array.isArray(d?.[1]) ? d[1].slice(0, 8) : [] };
        }
      } catch (_) {}
      return { suggestions: [] };
    },

    async getChannel(channelQuery, tab = "videos") {
      const clean = String(channelQuery || "").trim();
      const tabKey = CHANNEL_TAB_PARAMS[tab] ? tab : "videos";
      let cid = /^UC[A-Za-z0-9_-]{22}$/.test(clean) ? clean : "";
      if (!cid) {
        try {
          const sr = await webInnerTubePost("search", { query: clean, params: "EgIQAg%3D%3D" });
          const m = JSON.stringify(sr).match(/"channelId"\s*:\s*"(UC[A-Za-z0-9_-]{22})"/);
          if (m) cid = m[1];
        } catch (_) {}
      }

      const out = {
        channel: clean,
        channel_id: cid || clean,
        name: clean,
        avatar: "",
        banner: "",
        subscribers: "",
        active_tab: tabKey,
        items: [],
      };
      if (cid) {
        try {
          const data = await webInnerTubePost("browse", { browseId: cid, params: CHANNEL_TAB_PARAMS[tabKey] });
          const rawS = JSON.stringify(data);
          const mName =
            rawS.match(/"pageHeaderViewModel"\s*:\s*\{\s*"title".*?"content"\s*:\s*"([^"]+)"/) ||
            rawS.match(/"c4TabbedHeaderRenderer".*?"title"\s*:\s*"([^"]+)"/);
          const mSub = rawS.match(/(\d[\d.,]*\s*(?:Tr|N|K|M|B)?\s*người đăng ký|[\d.,]+[KMB]?\s*subscribers?)/i);
          const mAv = rawS.match(/"avatarViewModel".*?"url"\s*:\s*"(https:\/\/yt3\.[^"]+)"/) || rawS.match(/"url"\s*:\s*"(https:\/\/yt3\.[^"]+)"/);
          const mBan = rawS.match(/"banner".*?"url"\s*:\s*"(https:\/\/yt3\.[^"]+)"/);
          if (mName) out.name = mName[1];
          if (mSub) out.subscribers = mSub[1];
          if (mAv) out.avatar = mAv[1];
          if (mBan) out.banner = mBan[1];
          if (tabKey === "shorts") out.items = extractShortsFromInnerTube(data, 30);
          else if (tabKey === "playlists") out.items = extractPlaylistsFromInnerTube(data);
          else out.items = extractVideosFromInnerTube(data, 30);
        } catch (_) {}
      }
      if (!out.items.length && tabKey === "videos") {
        out.items = await searchInnerTube(clean, 14);
      }
      return out;
    },

    async subscribeChannel(channelId, subscribe = true) {
      if (!/^UC[A-Za-z0-9_-]{22}$/.test(String(channelId || "").trim())) {
        throw new Error("Không xác định được ID kênh để đồng bộ YouTube.");
      }
      const ep = subscribe ? "subscription/subscribe" : "subscription/unsubscribe";
      await tvInnerTubePost(ep, { channelIds: [channelId.trim()] });
      return { subscribed: Boolean(subscribe), channel_id: channelId.trim() };
    },

    async getVideo(videoId, forceRefresh = false) {
      const vid = extractVideoIdFromText(videoId);
      if (!vid) throw new Error("Video ID không hợp lệ.");

      if (!forceRefresh) {
        const cached = videoCache.get(vid);
        if (cached && cached.expiresAt > Date.now()) {
          syncWatchHistory(vid);
          return cached.data;
        }
      }

      const visitorData = await getVisitorData();
      const { data, ua } = await fetchPlayerWithFallback(vid, visitorData);
      const sd = data.streamingData || {};
      const details = data.videoDetails || {};
      const hlsManifest = sd.hlsManifestUrl || "";
      const dur = parseInt(details.lengthSeconds || "0", 10) || 0;
      const isLive = Boolean(details.isLive || (dur === 0 && Boolean(hlsManifest)));
      const classified = classifyStreams(sd);
      await wrapStreamsWithNativeProxy(classified, ua);

      let hlsUrl = isLive ? hlsManifest : "";
      const p = plugin();
      if (isLive && hlsManifest && p && typeof p.registerHls === "function") {
        try {
          const r = await p.registerHls({ url: hlsManifest, headers: { "User-Agent": ua } });
          if (r?.proxyUrl) hlsUrl = r.proxyUrl;
        } catch (_) {}
      }

      const views = parseInt(details.viewCount || "0", 10) || 0;
      const h = Math.floor(dur / 3600);
      const m = Math.floor((dur % 3600) / 60);
      const s = dur % 60;
      const durText = isLive
        ? "TRỰC TIẾP"
        : h > 0
          ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
          : `${m}:${String(s).padStart(2, "0")}`;

      const capTracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      captionsCache.set(vid, capTracks);

      const videoData = {
        id: vid,
        title: details.title || "Video không tiêu đề",
        channel: details.author || "Kênh YouTube",
        channel_id: details.channelId || details.author || "Kênh YouTube",
        channel_url: details.channelId ? `https://www.youtube.com/channel/${details.channelId}` : "",
        language: "",
        duration: dur,
        duration_text: durText,
        view_count: views,
        like_count: 0,
        upload_date: "",
        description: (details.shortDescription || "").slice(0, 3000),
        thumbnail: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
        is_live: isLive,
        hls_url: hlsUrl,
        ...classified,
        chapters: [],
      };

      videoCache.set(vid, { expiresAt: Date.now() + 45 * 60 * 1000, data: videoData });
      syncWatchHistory(vid);
      return videoData;
    },

    prefetchVideo(videoId) {
      const vid = extractVideoIdFromText(videoId);
      if (!vid || videoCache.has(vid)) return;
      this.getVideo(vid).catch(() => {});
    },

    async getVideoExtras(videoId, channel = "", title = "") {
      const vid = extractVideoIdFromText(videoId);
      if (!vid) return { sponsor_segments: [], related: [] };

      const sbPromise = (async () => {
        try {
          const cats = JSON.stringify(Object.keys(SPONSOR_META));
          const url = `https://sponsor.ajay.app/api/skipSegments?videoID=${vid}&categories=${encodeURIComponent(cats)}`;
          const res = await nativeHttpGet(url);
          if (res.status !== 200) return [];
          const raw = JSON.parse(res.body);
          return raw
            .filter((seg) => SPONSOR_META[seg.category] && Array.isArray(seg.segment) && seg.segment.length === 2)
            .map((seg) => ({
              uuid: seg.UUID || `${seg.category}-${seg.segment[0]}`,
              category: seg.category,
              label: SPONSOR_META[seg.category].label,
              color: SPONSOR_META[seg.category].color,
              start: Number(seg.segment[0]),
              end: Number(seg.segment[1]),
            }))
            .filter((seg) => seg.end > seg.start)
            .sort((a, b) => a.start - b.start);
        } catch (_) {
          return [];
        }
      })();

      const [sponsor_segments, nextMeta] = await Promise.all([sbPromise, fetchVideoNextMeta(vid)]);
      let related = nextMeta.related || [];
      if (!related.length) {
        try {
          const q = `${channel} ${title.slice(0, 40)}`.trim() || vid;
          related = (await searchInnerTube(q, 10)).filter((it) => it.id !== vid).slice(0, 8);
        } catch (_) {
          related = [];
        }
      }
      return {
        sponsor_segments,
        related,
        channel_id: nextMeta.channel_id || "",
        subscriber_count_text: nextMeta.subscriber_count_text || "",
        like_count_text: nextMeta.like_count_text || "",
        channel_avatar: nextMeta.channel_avatar || "",
        comment_count_text: nextMeta.comment_count_text || "",
        comments_token: nextMeta.comments_token || "",
      };
    },

    async getComments(videoId, continuation = "") {
      const vid = extractVideoIdFromText(videoId);
      if (!vid) return { comments: [], next_continuation: "" };
      let tok = String(continuation || "").trim();
      if (!tok) {
        const meta = await fetchVideoNextMeta(vid);
        tok = meta.comments_token || "";
      }
      if (!tok) return { comments: [], next_continuation: "" };
      const data = await webInnerTubePost("next", { continuation: tok });
      return parseCommentsPayload(data);
    },

    async reactVideo(videoId, action = "like") {
      const vid = extractVideoIdFromText(videoId);
      if (!vid) throw new Error("Video ID không hợp lệ.");
      const epMap = { like: "like/like", dislike: "like/dislike", none: "like/removelike" };
      const ep = epMap[action] || "like/like";
      await tvInnerTubePost(ep, { target: { videoId: vid } });
      return { video_id: vid, action };
    },

    async getYoutubePlaylists(videoId = "") {
      const vids = videoId && /^[A-Za-z0-9_-]{11}$/.test(videoId) ? [videoId] : ["jNQXAC9IVRw"];
      const data = await tvInnerTubePost("playlist/get_add_to_playlist", { videoIds: vids });
      const playlists = extractPlaylistsFromInnerTube(data);
      try {
        const lib = await tvInnerTubePost("browse", { browseId: "FElibrary" });
        for (const extra of extractPlaylistsFromInnerTube(lib)) {
          if (!playlists.some((p) => p.id === extra.id)) {
            playlists.push(extra);
          } else {
            const target = playlists.find((p) => p.id === extra.id);
            if (target && !target.thumbnail && extra.thumbnail) target.thumbnail = extra.thumbnail;
            if (target && !target.count_text && extra.count_text) target.count_text = extra.count_text;
          }
        }
      } catch (_) {}
      if (!playlists.some((p) => p.id === "WL")) {
        playlists.unshift({ id: "WL", title: "Xem sau", privacy: "PRIVATE", contains_selected: false, count_text: "", thumbnail: "" });
      }
      if (!playlists.some((p) => p.id === "LL")) {
        const wlIdx = playlists.findIndex((p) => p.id === "WL");
        const llObj = { id: "LL", title: "Video đã thích", privacy: "PRIVATE", contains_selected: false, count_text: "", thumbnail: "" };
        if (wlIdx >= 0) playlists.splice(wlIdx + 1, 0, llObj);
        else playlists.unshift(llObj);
      }
      return { playlists };
    },

    async getYoutubePlaylistItems(playlistId) {
      const pid = String(playlistId || "").trim();
      const browseId = pid.startsWith("VL") ? pid : `VL${pid}`;
      const data = await tvInnerTubePost("browse", { browseId });
      return { playlist_id: pid, items: extractVideosFromInnerTube(data, 60, true) };
    },

    async addVideoToYoutubePlaylist(playlistId, videoId, remove = false) {
      const pid = String(playlistId || "").trim();
      const vid = extractVideoIdFromText(videoId);
      if (!pid || !vid) throw new Error("Thiếu thông tin playlist hoặc video.");
      const act = remove
        ? { action: "ACTION_REMOVE_VIDEO_BY_VIDEO_ID", removedVideoId: vid }
        : { action: "ACTION_ADD_VIDEO", addedVideoId: vid };
      await tvInnerTubePost("browse/edit_playlist", { playlistId: pid, actions: [act] });
      return { playlist_id: pid, video_id: vid, added: !remove };
    },

    async downloadToDevice(videoData, mode = "video") {
      const p = plugin();
      if (!p || typeof p.downloadToDevice !== "function") {
        throw new Error("Thiết bị chưa hỗ trợ tải trực tiếp.");
      }
      const cleanTitle = String(videoData?.title || videoData?.id || "puretube")
        .replace(/[\\/:*?"<>|]+/g, " ")
        .trim()
        .slice(0, 60) || "puretube";
      if (mode === "audio") {
        const track = (videoData.audio_tracks || []).find((t) => t.raw_url) || videoData.default_audio_track;
        if (!track?.raw_url) throw new Error("Không tìm thấy luồng âm thanh để tải.");
        return p.downloadToDevice({
          url: track.raw_url,
          headers: { "User-Agent": track.raw_ua || AND_UA },
          filename: `${cleanTitle}.${track.ext === "webm" ? "webm" : "m4a"}`,
          mimeType: track.raw_mime || "audio/mp4",
          contentLength: track.raw_len || 0,
        });
      }
      const qs = videoData.qualities || [];
      let pick = qs.find((q) => q.has_audio && q.raw_url);
      if (!pick && videoData?.id) {
        // VISIONOS streams are adaptive-only; fetch ANDROID progressive MP4 (itag=18 with audio) on demand for offline video download
        try {
          const visitorData = await getVisitorData();
          const resAnd = await requestPlayerClient(
            videoData.id,
            visitorData,
            { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 34, osName: "Android", osVersion: "14" },
            AND_UA
          );
          const fmts = resAnd.data?.streamingData?.formats || [];
          const prog = fmts.find((f) => f.url && String(f.mimeType || "").includes("mp4")) || fmts.find((f) => f.url);
          if (prog?.url) {
            pick = {
              raw_url: prog.url,
              raw_ua: AND_UA,
              raw_mime: (prog.mimeType || "video/mp4").split(";")[0].trim(),
              raw_len: Number(prog.contentLength || 0) || 0,
              height: prog.height || 360,
            };
          }
        } catch (_) {}
      }
      if (!pick) pick = qs.find((q) => q.raw_url);
      if (!pick?.raw_url) throw new Error("Không tìm thấy luồng video MP4 trực tiếp để tải.");
      return p.downloadToDevice({
        url: pick.raw_url,
        headers: { "User-Agent": pick.raw_ua || AND_UA },
        filename: `${cleanTitle}_${pick.height || 360}p.mp4`,
        mimeType: pick.raw_mime || "video/mp4",
        contentLength: pick.raw_len || 0,
      });
    },

    updateMediaNotification(opts) {
      const p = plugin();
      if (p && typeof p.updateMediaNotification === "function") {
        p.updateMediaNotification(opts).catch(() => {});
      }
    },

    addNativeListener(eventName, cb) {
      const p = plugin();
      if (p && typeof p.addListener === "function") {
        return p.addListener(eventName, cb);
      }
      return null;
    },

    async getDubbing(videoId) {
      const vid = extractVideoIdFromText(videoId);
      if (!vid) return { video_id: videoId, source_lang: "", translated: false, segments: [] };
      const cached = dubbingCache.get(vid);
      if (cached && cached.expiresAt > Date.now()) return cached.data;

      if (!captionsCache.has(vid)) {
        await this.getVideo(vid);
      }
      const tracks = captionsCache.get(vid) || [];
      if (!tracks.length) {
        return { video_id: vid, source_lang: "", translated: false, segments: [] };
      }

      const pick =
        tracks.find((c) => (c.languageCode || "").toLowerCase().startsWith("vi")) ||
        tracks.find((c) => (c.languageCode || "").toLowerCase().startsWith("en") && c.kind !== "asr") ||
        tracks.find((c) => (c.languageCode || "").toLowerCase().startsWith("en")) ||
        tracks[0];
      if (!pick?.baseUrl) {
        return { video_id: vid, source_lang: "", translated: false, segments: [] };
      }

      const sep = pick.baseUrl.includes("?") ? "&" : "?";
      const res = await nativeHttpGet(`${pick.baseUrl}${sep}fmt=json3`, { "User-Agent": WEB_UA });
      if (res.status !== 200) throw new Error("Không tải được phụ đề gốc từ YouTube.");

      const sentences = mergeJson3IntoSentences(JSON.parse(res.body));
      const isVi = (pick.languageCode || "").toLowerCase().startsWith("vi");
      const originals = sentences.map((s) => s.text);
      const viTexts = isVi ? originals : await translateTextsToVi(originals);

      const out = {
        video_id: vid,
        source_lang: pick.languageCode || "",
        translated: !isVi,
        segments: sentences.map((s, idx) => ({
          start: s.start,
          end: s.end,
          text: viTexts[idx] || originals[idx],
          original: originals[idx],
        })),
      };
      dubbingCache.set(vid, { expiresAt: Date.now() + 60 * 60 * 1000, data: out });
      return out;
    },

    async fetchTtsDataUri(text) {
      const clean = (text || "").replace(/\s+/g, " ").trim().slice(0, 195);
      if (!clean) return "";
      if (ttsDataCache.has(clean)) return ttsDataCache.get(clean);

      const p = plugin();
      if (!p) return "";
      const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(clean)}&tl=vi&client=tw-ob`;
      const res = await p.httpGetBase64({ url, headers: { "User-Agent": "Mozilla/5.0" } });
      if (res.status !== 200 || !res.base64) throw new Error("TTS failed");
      const dataUri = `data:audio/mpeg;base64,${res.base64}`;
      if (ttsDataCache.size >= 180) {
        const firstKey = ttsDataCache.keys().next().value;
        ttsDataCache.delete(firstKey);
      }
      ttsDataCache.set(clean, dataUri);
      return dataUri;
    },

    getAuthStatus() {
      const tok = readOAuth();
      if (!tok?.access_token) return { logged_in: false, account_name: "", method: "" };
      return {
        logged_in: true,
        account_name: tok.account_name || "Tài khoản Google",
        method: "google_oauth_device",
      };
    },

    async launchGoogleLogin() {
      const devId = (crypto?.randomUUID && crypto.randomUUID()) || `pt-${Date.now()}`;
      const res = await nativeHttpPostForm(
        "https://www.youtube.com/o/oauth2/device/code",
        {
          client_id: YT_TV_CLIENT_ID,
          scope: "http://gdata.youtube.com https://www.googleapis.com/auth/youtube-paid-content",
          device_id: devId,
          device_model: "PureTube",
        },
        { "User-Agent": "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version" }
      );
      if (res.status !== 200) throw new Error(`Google từ chối cấp mã đăng nhập (${res.status}).`);
      const d = JSON.parse(res.body);
      pendingDeviceFlow = {
        device_code: d.device_code,
        user_code: d.user_code,
        verification_url: d.verification_url || "https://www.google.com/device",
        expires_at: Date.now() + Number(d.expires_in || 1800) * 1000,
      };
      return {
        status: "device_code",
        user_code: pendingDeviceFlow.user_code,
        verification_url: pendingDeviceFlow.verification_url,
      };
    },

    async pollGoogleLogin() {
      if (!pendingDeviceFlow?.device_code) {
        return { status: "none", logged_in: false, message: "Chưa tạo mã kết nối Google." };
      }
      if (Date.now() > pendingDeviceFlow.expires_at) {
        pendingDeviceFlow = null;
        return { status: "expired", logged_in: false, message: "Mã kết nối đã hết hạn." };
      }
      const res = await nativeHttpPostForm("https://www.youtube.com/o/oauth2/token", {
        client_id: YT_TV_CLIENT_ID,
        client_secret: YT_TV_CLIENT_SECRET,
        code: pendingDeviceFlow.device_code,
        grant_type: "http://oauth.net/grant_type/device/1.0",
      });
      const tokData = JSON.parse(res.body || "{}");
      if (tokData.access_token) {
        const accountName = await detectAccountName(tokData.access_token);
        writeOAuth({
          access_token: tokData.access_token,
          refresh_token: tokData.refresh_token || "",
          expires_at: Date.now() + Number(tokData.expires_in || 3600) * 1000,
          account_name: accountName,
        });
        pendingDeviceFlow = null;
        return { status: "completed", logged_in: true, account_name: accountName };
      }
      if (tokData.error === "authorization_pending" || tokData.error === "slow_down") {
        return { status: "waiting", logged_in: false };
      }
      pendingDeviceFlow = null;
      return { status: "expired", logged_in: false, message: "Mã kết nối đã hết hạn hoặc bị từ chối." };
    },

    async completeGoogleLogin() {
      const r = await this.pollGoogleLogin();
      if (r.status === "completed") return r;
      throw new Error(r.message || "Bạn chưa bấm Cho phép trên trang Google.");
    },

    logoutGoogle() {
      pendingDeviceFlow = null;
      writeOAuth(null);
      return { logged_in: false };
    },

    async getYoutubeHistory() {
      return { items: await fetchInnerTubeBrowse("FEhistory", 50, true) };
    },

    async getYoutubeSubscriptions() {
      return { items: await fetchInnerTubeBrowse("FEsubscriptions", 36, true) };
    },
  };

  window.PureStandaloneBridge = PureStandaloneBridge;
})();
