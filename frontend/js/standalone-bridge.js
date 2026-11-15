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
  const WEB_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36";

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

  function buildItem(vid, title, channel, durText = "", viewCount = 0) {
    if (!vid || vid.length !== 11 || !title) return null;
    const dur = parseDurationText(durText);
    if (dur > 0 && dur < 45) return null;
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

  function extractVideosFromInnerTube(payload, limit = 30) {
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
          addItem(buildItem(String(vid || ""), title, channel, durText, parseViewCountText(viewTxt)));
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
          addItem(buildItem(String(vid), title, channel, durText, views));
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
    audioTracks.forEach((t) => delete t._score);

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

  async function syncWatchHistory(videoId) {
    const token = await getValidAccessToken();
    if (!token) return;
    try {
      const headers = {
        Authorization: `Bearer ${token}`,
        "User-Agent": "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version",
      };
      const res = await nativeHttpPostJson(
        "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
        {
          context: { client: { clientName: "TVHTML5", clientVersion: "7.20250312.16.00", hl: "vi", gl: "VN" } },
          videoId,
        },
        headers
      );
      if (res.status !== 200) return;
      const pdata = JSON.parse(res.body);
      let baseUrl = pdata?.playbackTracking?.videostatsPlaybackUrl?.baseUrl;
      if (!baseUrl) return;
      if (!baseUrl.startsWith("http")) baseUrl = `https://www.youtube.com${baseUrl}`;
      const sep = baseUrl.includes("?") ? "&" : "?";
      const len = pdata?.videoDetails?.lengthSeconds || "60";
      await nativeHttpGet(`${baseUrl}${sep}cpn=PureTubeApp123&ver=2&cmt=0&len=${len}`, headers);
    } catch (_) {}
  }

  async function fetchInnerTubeBrowse(browseId, limit = 36) {
    let token = await getValidAccessToken();
    if (!token) throw new Error("Bạn chưa đăng nhập tài khoản Google/YouTube.");
    const clients = [
      { name: "TVHTML5", ver: "7.20250312.16.00", ua: "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version" },
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
        const items = extractVideosFromInnerTube(JSON.parse(res.body), limit);
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
      const q = TRENDING_QUERIES[category] || TRENDING_QUERIES.all;
      return { category, items: await searchInnerTube(q, 16) };
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

    async getChannel(channelName) {
      return { channel: channelName, items: await searchInnerTube(channelName, 14) };
    },

    async getVideo(videoId) {
      const vid = extractVideoIdFromText(videoId);
      if (!vid) throw new Error("Video ID không hợp lệ.");

      const cached = videoCache.get(vid);
      if (cached && cached.expiresAt > Date.now()) {
        syncWatchHistory(vid);
        return cached.data;
      }

      const visitorData = await getVisitorData();
      const res = await nativeHttpPostJson(
        "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
        {
          videoId: vid,
          context: {
            client: {
              clientName: "IOS",
              clientVersion: "20.10.4",
              deviceMake: "Apple",
              deviceModel: "iPhone16,2",
              osName: "iPhone",
              osVersion: "18.3.1.22D72",
              hl: "vi",
              gl: "VN",
              ...(visitorData ? { visitorData } : {}),
            },
          },
          contentCheckOk: true,
          racyCheckOk: true,
        },
        {
          "User-Agent": IOS_UA,
          ...(visitorData ? { "X-Goog-Visitor-Id": visitorData } : {}),
        }
      );

      if (res.status !== 200) throw new Error(`Không thể tải luồng phát (${res.status})`);
      const data = JSON.parse(res.body);
      const status = data?.playabilityStatus?.status;
      if (status !== "OK") {
        throw new Error(data?.playabilityStatus?.reason || "Video không khả dụng để phát.");
      }

      const classified = classifyStreams(data.streamingData || {});
      const details = data.videoDetails || {};
      const dur = parseInt(details.lengthSeconds || "0", 10) || 0;
      const views = parseInt(details.viewCount || "0", 10) || 0;
      const h = Math.floor(dur / 3600);
      const m = Math.floor((dur % 3600) / 60);
      const s = dur % 60;
      const durText = h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;

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

      const relatedPromise = (async () => {
        try {
          const res = await nativeHttpPostJson(
            "https://www.youtube.com/youtubei/v1/next?prettyPrint=false",
            {
              videoId: vid,
              context: { client: { clientName: "WEB", clientVersion: "2.20250312.04.00", hl: "vi", gl: "VN" } },
            },
            { "User-Agent": WEB_UA }
          );
          if (res.status === 200) {
            const items = extractVideosFromInnerTube(JSON.parse(res.body), 12).filter((it) => it.id !== vid);
            if (items.length) return items.slice(0, 8);
          }
          const q = `${channel} ${title.slice(0, 40)}`.trim() || vid;
          return (await searchInnerTube(q, 10)).filter((it) => it.id !== vid).slice(0, 8);
        } catch (_) {
          return [];
        }
      })();

      const [sponsor_segments, related] = await Promise.all([sbPromise, relatedPromise]);
      return { sponsor_segments, related };
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
      return { items: await fetchInnerTubeBrowse("FEhistory", 36) };
    },

    async getYoutubeSubscriptions() {
      return { items: await fetchInnerTubeBrowse("FEsubscriptions", 28) };
    },
  };

  window.PureStandaloneBridge = PureStandaloneBridge;
})();
