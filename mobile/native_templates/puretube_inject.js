(function () {
  "use strict";

  var host = (window.location && window.location.hostname) || "";
  var isYtHost = /(^|\.)youtube\.com$/i.test(host) || host === "youtu.be";
  var allowHostlessTest = Boolean(window.__PURETUBE_TEST_MODE__);
  if (!isYtHost && !allowHostlessTest) {
    return;
  }
  if (window.__PURETUBE_INJECTED__) {
    return;
  }
  window.__PURETUBE_INJECTED__ = true;

  var PREFS_KEY = "puretube_yt_prefs_v1";
  var prefs = {
    adblock: true,
    backgroundPlay: true,
    sponsorBlock: true,
  };
  try {
    var saved = JSON.parse(localStorage.getItem(PREFS_KEY) || "null");
    if (saved && typeof saved === "object") {
      if (typeof saved.adblock === "boolean") prefs.adblock = saved.adblock;
      if (typeof saved.backgroundPlay === "boolean") prefs.backgroundPlay = saved.backgroundPlay;
      if (typeof saved.sponsorBlock === "boolean") prefs.sponsorBlock = saved.sponsorBlock;
    }
  } catch (_) {}

  function savePrefs() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch (_) {}
    syncPrefsToNative();
  }

  function syncPrefsToNative() {
    try {
      if (window.PureTubeHost) {
        if (typeof window.PureTubeHost.setBackgroundPlay === "function") {
          window.PureTubeHost.setBackgroundPlay(Boolean(prefs.backgroundPlay));
        }
        if (typeof window.PureTubeHost.setAdBlockEnabled === "function") {
          window.PureTubeHost.setAdBlockEnabled(Boolean(prefs.adblock));
        }
      }
    } catch (_) {}
  }

  var stats = {
    adsBlocked: 0,
    sponsorsSkipped: 0,
  };

  var AD_ITEM_KEYS = {
    adSlotRenderer: true,
    promotedSparklesWebRenderer: true,
    promotedSparklesTextSearchRenderer: true,
    compactPromotedVideoRenderer: true,
    compactPromotedItemRenderer: true,
    promotedVideoRenderer: true,
    inFeedAdLayoutRenderer: true,
    statementBannerRenderer: true,
    bannerPromoRenderer: true,
    mealbarPromoRenderer: true,
    brandVideoShelfRenderer: true,
    brandVideoSingletonRenderer: true,
    primetimePromoRenderer: true,
    displayAdRenderer: true,
    actionCompanionAdRenderer: true,
    searchPyvRenderer: true,
    carouselAdRenderer: true,
    merchandiseShelfRenderer: true,
  };

  function hasAdRendererKey(obj) {
    if (!obj || typeof obj !== "object") return false;
    if (obj.isAd === true) return true;
    for (var k in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, k) && AD_ITEM_KEYS[k]) {
        return true;
      }
    }
    return false;
  }

  function isAdListEntry(entry) {
    if (!entry || typeof entry !== "object") return false;
    if (hasAdRendererKey(entry)) return true;
    if (entry.richItemRenderer && hasAdRendererKey(entry.richItemRenderer.content)) {
      return true;
    }
    if (entry.reelWatchEndpoint && entry.adSlotRenderer) {
      return true;
    }
    return false;
  }

  function pruneYouTubeAds(root) {
    if (!root || typeof root !== "object") return root;
    var visited = typeof WeakSet === "function" ? new WeakSet() : null;

    function walk(node, depth) {
      if (!node || typeof node !== "object" || depth > 26) return;
      if (visited) {
        if (visited.has(node)) return;
        visited.add(node);
      }

      if (Array.isArray(node)) {
        for (var i = node.length - 1; i >= 0; i--) {
          var item = node[i];
          if (isAdListEntry(item)) {
            node.splice(i, 1);
            stats.adsBlocked += 1;
          } else {
            walk(item, depth + 1);
          }
        }
        return;
      }

      if (Array.isArray(node.adPlacements) && node.adPlacements.length > 0) {
        stats.adsBlocked += node.adPlacements.length;
        node.adPlacements = [];
      }
      if (Array.isArray(node.playerAds) && node.playerAds.length > 0) {
        stats.adsBlocked += node.playerAds.length;
        node.playerAds = [];
      }
      if (Array.isArray(node.adSlots) && node.adSlots.length > 0) {
        stats.adsBlocked += node.adSlots.length;
        node.adSlots = [];
      }
      if ("adBreakHeartbeatParams" in node) delete node.adBreakHeartbeatParams;
      if ("adBreakParams" in node) delete node.adBreakParams;
      if ("enforcementMessageViewModel" in node) delete node.enforcementMessageViewModel;
      if ("bkaEnforcementMessageViewModel" in node) delete node.bkaEnforcementMessageViewModel;

      var keys = Object.keys(node);
      for (var j = 0; j < keys.length; j++) {
        var key = keys[j];
        if (AD_ITEM_KEYS[key]) {
          delete node[key];
          stats.adsBlocked += 1;
          continue;
        }
        var child = node[key];
        if (child && typeof child === "object") {
          walk(child, depth + 1);
        }
      }
    }

    walk(root, 0);
    return root;
  }

  function isYouTubeApiUrl(urlStr) {
    if (!urlStr || typeof urlStr !== "string") return false;
    if (/\/api\/stats\/(watchtime|playback)|googlevideo\.com|sponsor\.ajay\.app/i.test(urlStr)) {
      return false;
    }
    return /\/youtubei\/v1\/(player|next|browse|search|reel\/|get_watch|guide)/i.test(urlStr);
  }

  window.__PureTubeInjectAPI = {
    pruneYouTubeAds: pruneYouTubeAds,
    isYouTubeApiUrl: isYouTubeApiUrl,
    getPrefs: function () {
      return prefs;
    },
    getStats: function () {
      return stats;
    },
  };

  // Layer 1: Initial global payload traps at document_start
  function trapGlobalPayload(propName) {
    try {
      var existing = window[propName];
      var internalVal = existing && prefs.adblock ? pruneYouTubeAds(existing) : existing;
      Object.defineProperty(window, propName, {
        configurable: true,
        enumerable: true,
        get: function () {
          return internalVal;
        },
        set: function (val) {
          internalVal = val && prefs.adblock ? pruneYouTubeAds(val) : val;
        },
      });
    } catch (_) {}
  }
  trapGlobalPayload("ytInitialPlayerResponse");
  trapGlobalPayload("ytInitialData");

  // Layer 2: Intercept fetch for YouTube InnerTube JSON APIs
  if (typeof window.fetch === "function" && typeof window.Response === "function") {
    var origFetch = window.fetch;
    window.fetch = function (input, init) {
      var urlStr = typeof input === "string" ? input : (input && input.url) || "";
      var p = origFetch.apply(this, arguments);
      if (!prefs.adblock || !isYouTubeApiUrl(urlStr)) {
        return p;
      }
      return p.then(function (res) {
        if (!res || !res.ok || typeof res.clone !== "function") return res;
        var ct = (res.headers && res.headers.get && res.headers.get("content-type")) || "";
        if (ct && ct.toLowerCase().indexOf("json") === -1) return res;
        return res
          .clone()
          .json()
          .then(function (data) {
            var pruned = pruneYouTubeAds(data);
            return new Response(JSON.stringify(pruned), {
              status: res.status,
              statusText: res.statusText,
              headers: res.headers,
            });
          })
          .catch(function () {
            return res;
          });
      });
    };
  }

  // Layer 3: Intercept XHR responses for YouTube InnerTube JSON APIs
  if (typeof window.XMLHttpRequest === "function") {
    try {
      var origXhrOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (method, url) {
        this._ptPruneJson = isYouTubeApiUrl(String(url || ""));
        return origXhrOpen.apply(this, arguments);
      };

      var textDesc = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, "responseText");
      if (textDesc && typeof textDesc.get === "function") {
        Object.defineProperty(XMLHttpRequest.prototype, "responseText", {
          configurable: true,
          get: function () {
            var raw = textDesc.get.call(this);
            if (!this._ptPruneJson || !prefs.adblock || !raw || this.readyState !== 4) {
              return raw;
            }
            if (this._ptRawText === raw && this._ptCleanedText !== undefined) {
              return this._ptCleanedText;
            }
            try {
              var parsed = JSON.parse(raw);
              var cleaned = JSON.stringify(pruneYouTubeAds(parsed));
              this._ptRawText = raw;
              this._ptCleanedText = cleaned;
              return cleaned;
            } catch (_) {
              return raw;
            }
          },
        });
      }

      var respDesc = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, "response");
      if (respDesc && typeof respDesc.get === "function") {
        Object.defineProperty(XMLHttpRequest.prototype, "response", {
          configurable: true,
          get: function () {
            var val = respDesc.get.call(this);
            if (!this._ptPruneJson || !prefs.adblock || !val || this.readyState !== 4) {
              return val;
            }
            if (typeof val === "string") {
              if (this._ptRawText === val && this._ptCleanedText !== undefined) {
                return this._ptCleanedText;
              }
              try {
                var parsed = JSON.parse(val);
                var cleaned = JSON.stringify(pruneYouTubeAds(parsed));
                this._ptRawText = val;
                this._ptCleanedText = cleaned;
                return cleaned;
              } catch (_) {
                return val;
              }
            }
            if (typeof val === "object") {
              return pruneYouTubeAds(val);
            }
            return val;
          },
        });
      }
    } catch (_) {}
  }

  // Layer 4: Background Playback Protection (Page Visibility Spoof + Event Filter)
  function installVisibilitySpoof() {
    var spoofProp = function (target, prop, value) {
      try {
        Object.defineProperty(target, prop, {
          configurable: true,
          get: function () {
            return prefs.backgroundPlay ? value : undefined;
          },
        });
      } catch (_) {}
    };

    try {
      var origHiddenDesc = Object.getOwnPropertyDescriptor(Document.prototype, "hidden");
      var origVisDesc = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");
      Object.defineProperty(Document.prototype, "hidden", {
        configurable: true,
        get: function () {
          if (prefs.backgroundPlay) return false;
          return origHiddenDesc && origHiddenDesc.get ? origHiddenDesc.get.call(this) : false;
        },
      });
      Object.defineProperty(Document.prototype, "visibilityState", {
        configurable: true,
        get: function () {
          if (prefs.backgroundPlay) return "visible";
          return origVisDesc && origVisDesc.get ? origVisDesc.get.call(this) : "visible";
        },
      });
      spoofProp(Document.prototype, "webkitHidden", false);
      spoofProp(Document.prototype, "webkitVisibilityState", "visible");
    } catch (_) {}

    var blockedVisEvents = {
      visibilitychange: true,
      webkitvisibilitychange: true,
      pagehide: true,
      freeze: true,
    };

    try {
      var docAdd = Document.prototype.addEventListener;
      Document.prototype.addEventListener = function (type, listener, options) {
        if (prefs.backgroundPlay && blockedVisEvents[String(type || "").toLowerCase()]) {
          return;
        }
        return docAdd.apply(this, arguments);
      };
    } catch (_) {}

    try {
      var winAdd = Window.prototype.addEventListener;
      Window.prototype.addEventListener = function (type, listener, options) {
        if (prefs.backgroundPlay && blockedVisEvents[String(type || "").toLowerCase()]) {
          return;
        }
        return winAdd.apply(this, arguments);
      };
    } catch (_) {}
  }
  installVisibilitySpoof();

  // Cosmetic CSS Injection & UI Styles
  function ensureStyles() {
    if (!document || document.getElementById("puretube-adblock-css")) return;
    var root = document.head || document.documentElement;
    if (!root) return;
    var style = document.createElement("style");
    style.id = "puretube-adblock-css";
    style.textContent =
      "ytm-promoted-sparkles-web-renderer," +
      "ytm-promoted-video-renderer," +
      "ytm-companion-slot-renderer," +
      "ytm-action-companion-ad-renderer," +
      "ytm-statement-banner-renderer," +
      "ytm-banner-promo-renderer," +
      "ytm-mealbar-promo-renderer," +
      "ad-slot-renderer," +
      ".ytp-ad-module," +
      ".ytp-ad-overlay-container," +
      ".ytp-ad-player-overlay," +
      ".ytp-ad-image-overlay," +
      ".video-ads," +
      ".ad-showing .html5-video-player .ytp-ad-overlay-container {" +
      "  display: none !important;" +
      "}" +
      "#puretube-shield-btn {" +
      "  display: inline-flex; align-items: center; justify-content: center;" +
      "  width: 36px; height: 36px; border-radius: 50%; border: none;" +
      "  background: transparent; color: #2BA640; cursor: pointer;" +
      "  margin-right: 4px; flex-shrink: 0; padding: 0;" +
      "}" +
      "#puretube-shield-btn:active { background: rgba(43,166,64,0.18); }" +
      "#puretube-sb-toast {" +
      "  position: fixed; right: 12px; bottom: 72px; z-index: 2147483645;" +
      "  display: flex; align-items: center; gap: 10px; max-width: calc(100vw - 24px);" +
      "  background: rgba(24,24,24,0.96); color: #F1F1F1;" +
      "  border: 1px solid rgba(43,166,64,0.55); border-radius: 12px;" +
      "  padding: 9px 12px; font-family: Roboto, Arial, sans-serif; font-size: 13px;" +
      "  box-shadow: 0 8px 24px rgba(0,0,0,0.55);" +
      "}" +
      "#puretube-sb-toast button {" +
      "  border: none; background: rgba(255,255,255,0.16); color: #FFF;" +
      "  border-radius: 8px; padding: 4px 9px; font-size: 12px; font-weight: 600;" +
      "}" +
      "#puretube-shield-backdrop {" +
      "  position: fixed; inset: 0; z-index: 2147483646;" +
      "  background: rgba(0,0,0,0.62); display: flex; align-items: flex-end; justify-content: center;" +
      "}" +
      "#puretube-shield-sheet {" +
      "  width: min(460px, 100%); background: #212121; color: #F1F1F1;" +
      "  border-radius: 16px 16px 0 0; padding: 14px 16px 24px;" +
      "  font-family: Roboto, Arial, sans-serif; box-shadow: 0 -8px 32px rgba(0,0,0,0.7);" +
      "}" +
      ".pt-sheet-handle { width: 40px; height: 4px; border-radius: 99px; background: rgba(255,255,255,0.28); margin: 0 auto 12px; }" +
      ".pt-sheet-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }" +
      ".pt-sheet-title { font-size: 16px; font-weight: 700; display: flex; align-items: center; gap: 8px; }" +
      ".pt-sheet-stats { display: flex; gap: 10px; margin-bottom: 14px; font-size: 12px; color: #AAAAAA; }" +
      ".pt-stat-pill { background: rgba(43,166,64,0.16); color: #4ADE80; padding: 4px 10px; border-radius: 99px; font-weight: 600; }" +
      ".pt-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 0; border-top: 1px solid rgba(255,255,255,0.08); font-size: 14px; }" +
      ".pt-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 14px; }" +
      ".pt-btn { border: none; border-radius: 99px; padding: 9px 14px; font-size: 13px; font-weight: 600; background: rgba(255,255,255,0.12); color: #F1F1F1; }" +
      ".pt-btn.primary { background: #2BA640; color: #08120B; }";
    root.appendChild(style);
  }

  // Failsafe Video Ad-Skipper & Active Video Tracking
  var savedMuteBeforeAd = null;
  var boundVideo = null;
  var lastMediaSig = "";

  function findPrimaryVideo() {
    var vids = document.querySelectorAll ? document.querySelectorAll("video") : [];
    for (var i = 0; i < vids.length; i++) {
      if (vids[i] && (vids[i].currentSrc || vids[i].src || vids[i].readyState > 0)) {
        return vids[i];
      }
    }
    return vids[0] || null;
  }

  function extractWatchMeta() {
    var titleEl =
      document.querySelector("ytm-slim-video-metadata-section-renderer h2") ||
      document.querySelector(".slim-video-information-title") ||
      document.querySelector("h1.ytd-watch-metadata") ||
      document.querySelector("meta[name='title']");
    var rawTitle = titleEl
      ? (titleEl.getAttribute && titleEl.getAttribute("content")) || titleEl.textContent
      : document.title || "PureTube";
    var cleanTitle = String(rawTitle || "PureTube")
      .replace(/\s*-\s*YouTube\s*$/i, "")
      .trim() || "PureTube";

    var chEl =
      document.querySelector("ytm-slim-owner-renderer .slim-owner-channel-name") ||
      document.querySelector(".slim-owner-channel-name") ||
      document.querySelector("#channel-name");
    var cleanChannel = (chEl && chEl.textContent ? chEl.textContent.trim() : "") || "YouTube";
    return { title: cleanTitle, artist: cleanChannel };
  }

  function emitMediaState(force) {
    var v = findPrimaryVideo();
    var playing = Boolean(v && !v.paused && !v.ended);
    var meta = extractWatchMeta();
    var sig = (playing ? "1|" : "0|") + meta.title + "|" + meta.artist;
    if (!force && sig === lastMediaSig) return;
    lastMediaSig = sig;
    try {
      if (window.PureTubeHost && typeof window.PureTubeHost.onMediaState === "function") {
        window.PureTubeHost.onMediaState(meta.title, meta.artist, playing);
      }
      if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.puretube) {
        window.webkit.messageHandlers.puretube.postMessage({
          type: "mediaState",
          title: meta.title,
          artist: meta.artist,
          playing: playing,
        });
      }
    } catch (_) {}
  }

  window.__puretubeMediaControl = function (action) {
    var v = findPrimaryVideo();
    if (action === "play") {
      if (v) v.play().catch(function () {});
    } else if (action === "pause") {
      if (v) v.pause();
    } else if (action === "next") {
      var nextBtn = document.querySelector(
        ".player-controls-content [aria-label*='Tiếp' i], .player-controls-content [aria-label*='Next' i], .ytp-next-button"
      );
      if (nextBtn) nextBtn.click();
    } else if (action === "prev") {
      var prevBtn = document.querySelector(
        ".player-controls-content [aria-label*='Trước' i], .player-controls-content [aria-label*='Previous' i], .ytp-prev-button"
      );
      if (prevBtn) {
        prevBtn.click();
      } else if (v) {
        v.currentTime = 0;
      }
    }
    setTimeout(function () {
      emitMediaState(true);
    }, 120);
  };

  function bindVideoListeners(v) {
    if (!v || boundVideo === v) return;
    boundVideo = v;
    ["play", "pause", "loadedmetadata", "ended"].forEach(function (ev) {
      v.addEventListener(ev, function () {
        emitMediaState(false);
      });
    });
  }

  function runAdSkipTick() {
    if (!prefs.adblock) return;
    var player = document.querySelector("#movie_player, .html5-video-player");
    var v = findPrimaryVideo();
    if (!player || !v) return;

    var isAd =
      player.classList.contains("ad-showing") ||
      player.classList.contains("ad-interrupting");

    if (isAd) {
      if (savedMuteBeforeAd === null) {
        savedMuteBeforeAd = Boolean(v.muted);
        stats.adsBlocked += 1;
      }
      v.muted = true;
      if (isFinite(v.duration) && v.duration > 0.5 && v.currentTime < v.duration - 0.25) {
        try {
          v.currentTime = Math.max(0, v.duration - 0.05);
        } catch (_) {}
      }
      var skipBtns = document.querySelectorAll(
        ".ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button, .ytp-ad-skip-button-slot button"
      );
      for (var i = 0; i < skipBtns.length; i++) {
        try {
          skipBtns[i].click();
        } catch (_) {}
      }
    } else if (savedMuteBeforeAd !== null) {
      v.muted = savedMuteBeforeAd;
      savedMuteBeforeAd = null;
    }
  }

  // SponsorBlock Auto-Skip
  var sbCache = {};
  var sbSkippedUuids = {};
  var sbLastVideoId = "";
  var sbToastTimer = null;

  function getActiveVideoId() {
    var href = window.location.href || "";
    var watchM = href.match(/[?&]v=([A-Za-z0-9_-]{11})/);
    if (watchM) return watchM[1];
    var shortsM = href.match(/\/shorts\/([A-Za-z0-9_-]{11})/);
    if (shortsM) return shortsM[1];
    return "";
  }

  function showSponsorToast(seg, videoEl) {
    if (!document.body) return;
    var old = document.getElementById("puretube-sb-toast");
    if (old) old.remove();
    var toast = document.createElement("div");
    toast.id = "puretube-sb-toast";
    var savedSec = Math.max(1, Math.round(seg.segment[1] - seg.segment[0]));
    var txt = document.createElement("span");
    txt.textContent = "PureTube · Đã bỏ qua đoạn tài trợ (+" + savedSec + "s)";
    var undoBtn = document.createElement("button");
    undoBtn.type = "button";
    undoBtn.textContent = "Xem lại";
    undoBtn.addEventListener("click", function () {
      if (videoEl) videoEl.currentTime = seg.segment[0];
      toast.remove();
    });
    toast.appendChild(txt);
    toast.appendChild(undoBtn);
    document.body.appendChild(toast);
    clearTimeout(sbToastTimer);
    sbToastTimer = setTimeout(function () {
      if (toast.parentNode) toast.remove();
    }, 4500);
  }

  function fetchSponsorSegments(vid) {
    if (!vid || sbCache[vid] !== undefined) return;
    sbCache[vid] = null;
    if (typeof window.fetch !== "function") return;
    var url =
      "https://sponsor.ajay.app/api/skipSegments?videoID=" +
      encodeURIComponent(vid) +
      "&categories=%5B%22sponsor%22%2C%22selfpromo%22%2C%22interaction%22%2C%22intro%22%2C%22outro%22%2C%22music_offtopic%22%5D";
    window
      .fetch(url)
      .then(function (r) {
        return r && r.ok ? r.json() : [];
      })
      .then(function (arr) {
        sbCache[vid] = Array.isArray(arr) ? arr : [];
      })
      .catch(function () {
        sbCache[vid] = [];
      });
  }

  function runSponsorBlockTick() {
    if (!prefs.sponsorBlock) return;
    var vid = getActiveVideoId();
    if (!vid) return;
    if (vid !== sbLastVideoId) {
      sbLastVideoId = vid;
      sbSkippedUuids = {};
      fetchSponsorSegments(vid);
    }
    var segs = sbCache[vid];
    if (!Array.isArray(segs) || !segs.length) return;
    var player = document.querySelector("#movie_player, .html5-video-player");
    if (player && (player.classList.contains("ad-showing") || player.classList.contains("ad-interrupting"))) {
      return;
    }
    var v = findPrimaryVideo();
    if (!v || v.paused) return;
    var t = v.currentTime || 0;
    for (var i = 0; i < segs.length; i++) {
      var seg = segs[i];
      if (!seg || !seg.segment || sbSkippedUuids[seg.UUID]) continue;
      var s = seg.segment[0];
      var e = seg.segment[1];
      if (t >= s && t < e - 0.5) {
        sbSkippedUuids[seg.UUID] = true;
        stats.sponsorsSkipped += 1;
        try {
          v.currentTime = e;
          showSponsorToast(seg, v);
        } catch (_) {}
        break;
      }
    }
  }

  // Unobtrusive PureTube Shield Button inside YouTube Mobile Topbar
  function openShieldSheet() {
    if (!document.body) return;
    var existing = document.getElementById("puretube-shield-backdrop");
    if (existing) {
      existing.remove();
      return;
    }
    var bd = document.createElement("div");
    bd.id = "puretube-shield-backdrop";
    var sheet = document.createElement("div");
    sheet.id = "puretube-shield-sheet";
    sheet.addEventListener("click", function (ev) {
      ev.stopPropagation();
    });

    function toggleRow(label, key) {
      var row = document.createElement("label");
      row.className = "pt-row";
      var span = document.createElement("span");
      span.textContent = label;
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = Boolean(prefs[key]);
      cb.style.width = "18px";
      cb.style.height = "18px";
      cb.style.accentColor = "#2BA640";
      cb.addEventListener("change", function () {
        prefs[key] = cb.checked;
        savePrefs();
      });
      row.appendChild(span);
      row.appendChild(cb);
      return row;
    }

    var handle = document.createElement("div");
    handle.className = "pt-sheet-handle";

    var head = document.createElement("div");
    head.className = "pt-sheet-head";
    var title = document.createElement("div");
    title.className = "pt-sheet-title";
    title.textContent = "Khiên PureTube · YouTube Sạch QC";
    var closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "pt-btn";
    closeBtn.textContent = "Đóng";
    closeBtn.addEventListener("click", function () {
      bd.remove();
    });
    head.appendChild(title);
    head.appendChild(closeBtn);

    var statsRow = document.createElement("div");
    statsRow.className = "pt-sheet-stats";
    var p1 = document.createElement("span");
    p1.className = "pt-stat-pill";
    p1.textContent = "Đã chặn QC: " + stats.adsBlocked;
    var p2 = document.createElement("span");
    p2.className = "pt-stat-pill";
    p2.textContent = "SponsorBlock: " + stats.sponsorsSkipped;
    statsRow.appendChild(p1);
    statsRow.appendChild(p2);

    var actions = document.createElement("div");
    actions.className = "pt-actions";

    if (window.PureTubeHost && typeof window.PureTubeHost.enterPip === "function") {
      var pipBtn = document.createElement("button");
      pipBtn.type = "button";
      pipBtn.className = "pt-btn primary";
      pipBtn.textContent = "Thu nhỏ nổi (PiP)";
      pipBtn.addEventListener("click", function () {
        bd.remove();
        window.PureTubeHost.enterPip();
      });
      actions.appendChild(pipBtn);
    }

    var homeBtn = document.createElement("button");
    homeBtn.type = "button";
    homeBtn.className = "pt-btn";
    homeBtn.textContent = "Trang chủ YouTube";
    homeBtn.addEventListener("click", function () {
      bd.remove();
      window.location.href = "https://m.youtube.com";
    });
    actions.appendChild(homeBtn);

    var reloadBtn = document.createElement("button");
    reloadBtn.type = "button";
    reloadBtn.className = "pt-btn";
    reloadBtn.textContent = "Tải lại";
    reloadBtn.addEventListener("click", function () {
      bd.remove();
      window.location.reload();
    });
    actions.appendChild(reloadBtn);

    sheet.appendChild(handle);
    sheet.appendChild(head);
    sheet.appendChild(statsRow);
    sheet.appendChild(toggleRow("Chặn quảng cáo YouTube (0 QC)", "adblock"));
    sheet.appendChild(toggleRow("Phát nền khi tắt màn hình / thu nhỏ", "backgroundPlay"));
    sheet.appendChild(toggleRow("SponsorBlock tự bỏ qua đoạn tài trợ", "sponsorBlock"));
    sheet.appendChild(actions);

    bd.appendChild(sheet);
    bd.addEventListener("click", function () {
      bd.remove();
    });
    document.body.appendChild(bd);
  }

  function mountShieldButton() {
    if (!document || document.getElementById("puretube-shield-btn")) return;
    var bar =
      document.querySelector("ytm-mobile-topbar-renderer .mobile-topbar-header-content") ||
      document.querySelector(".mobile-topbar-header-content");
    if (!bar) return;

    var btn = document.createElement("button");
    btn.id = "puretube-shield-btn";
    btn.type = "button";
    btn.setAttribute("aria-label", "Mở bảng điều khiển PureTube");
    btn.title = "Khiên PureTube";
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M12 2l7.5 3.2v6c0 4.8-3.2 8.9-7.5 10.3C7.7 20.1 4.5 16 4.5 11.2v-6L12 2z"/>' +
      '<path d="M9 12l2 2 4-4"/>' +
      "</svg>";
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      openShieldSheet();
    });

    var signBtn = bar.querySelector("ytm-topbar-menu-button-renderer, .topbar-menu-button-avatar-button");
    if (signBtn && signBtn.parentNode === bar) {
      bar.insertBefore(btn, signBtn);
    } else {
      bar.appendChild(btn);
    }
  }

  function bootDomHooks() {
    ensureStyles();
    syncPrefsToNative();
    mountShieldButton();
    applyRoleAndMiniClasses();
    ensureDualStyles();
    mountBrowseReloadControl();
    emitMediaProgress();
    var v = findPrimaryVideo();
    if (v) {
      bindVideoListeners(v);
      emitMediaState(false);
    }
  }

  var isMiniModeState = false;
  var savedPlayerScrollY = 0;
  var lastEmittedPermille = -1;
  var dualHooksInstalled = false;

  function getPtRole() {
    try {
      if (typeof window !== "undefined" && window.PureTubeHost && typeof window.PureTubeHost.getRole === "function") {
        var r = String(window.PureTubeHost.getRole() || "").trim();
        if (r === "browse" || r === "player") return r;
      }
    } catch (_) {}
    return "single";
  }

  function applyRoleAndMiniClasses() {
    if (typeof document === "undefined" || !document.documentElement) return;
    var root = document.documentElement;
    var role = getPtRole();
    root.classList.remove("pt-role-browse", "pt-role-player", "pt-role-single");
    root.classList.add("pt-role-" + role);
    if (isMiniModeState) {
      root.classList.add("pt-mini-mode");
    } else {
      root.classList.remove("pt-mini-mode");
    }
  }

  function ensureDualStyles() {
    if (typeof document === "undefined") return;
    var container = document.head || document.documentElement;
    if (!container) return;
    if (document.getElementById("puretube-dual-styles")) return;
    var style = document.createElement("style");
    style.id = "puretube-dual-styles";
    style.textContent = [
      "html.pt-role-player ytm-mobile-topbar-renderer,",
      "html.pt-role-player header.mobile-topbar-header,",
      "html.pt-role-player #header-bar {",
      "  display: none !important;",
      "  height: 0 !important;",
      "  min-height: 0 !important;",
      "}",
      "html.pt-role-player ytm-app {",
      "  padding-top: 0 !important;",
      "  --ytm-header-height: 0px !important;",
      "}",
      "html.pt-role-player #player-container-id,",
      "html.pt-role-player .player-container,",
      "html.pt-role-player .player-container.sticky-player {",
      "  top: 0 !important;",
      "  margin-top: 0 !important;",
      "}",
      "html.pt-mini-mode,",
      "html.pt-mini-mode body {",
      "  overflow: hidden !important;",
      "  background: #000 !important;",
      "  margin: 0 !important;",
      "  padding: 0 !important;",
      "  width: 100vw !important;",
      "  height: 100vh !important;",
      "}",
      "html.pt-mini-mode body > *:not(ytm-app),",
      "html.pt-mini-mode ytm-mobile-topbar-renderer,",
      "html.pt-mini-mode #header-bar,",
      "html.pt-mini-mode .watch-below-the-player,",
      "html.pt-mini-mode ytm-single-column-watch-next-results-renderer,",
      "html.pt-mini-mode ytm-item-section-renderer,",
      "html.pt-mini-mode ytm-pivot-bar-renderer,",
      "html.pt-mini-mode #player-control-overlay,",
      "html.pt-mini-mode .player-controls-content,",
      "html.pt-mini-mode .ytp-chrome-top,",
      "html.pt-mini-mode .ytp-chrome-bottom,",
      "html.pt-mini-mode .ytp-gradient-top,",
      "html.pt-mini-mode .ytp-gradient-bottom,",
      "html.pt-mini-mode .ytp-watermark,",
      "html.pt-mini-mode .ytp-ce-element,",
      "html.pt-mini-mode .ytp-pause-overlay,",
      "html.pt-mini-mode .html5-endscreen {",
      "  display: none !important;",
      "  opacity: 0 !important;",
      "  pointer-events: none !important;",
      "}",
      "html.pt-mini-mode #player-container-id,",
      "html.pt-mini-mode #player,",
      "html.pt-mini-mode #movie_player,",
      "html.pt-mini-mode .html5-video-player,",
      "html.pt-mini-mode .html5-video-container {",
      "  position: fixed !important;",
      "  top: 0 !important;",
      "  left: 0 !important;",
      "  right: 0 !important;",
      "  bottom: 0 !important;",
      "  width: 100vw !important;",
      "  height: 100vh !important;",
      "  min-width: 100vw !important;",
      "  min-height: 100vh !important;",
      "  max-width: none !important;",
      "  max-height: none !important;",
      "  margin: 0 !important;",
      "  padding: 0 !important;",
      "  z-index: 2147483640 !important;",
      "  background: #000 !important;",
      "}",
      "html.pt-mini-mode #movie_player video,",
      "html.pt-mini-mode .html5-video-player video,",
      "html.pt-mini-mode video.html5-main-video,",
      "html.pt-mini-mode video {",
      "  position: fixed !important;",
      "  top: 0 !important;",
      "  left: 0 !important;",
      "  width: 100vw !important;",
      "  height: 100vh !important;",
      "  min-width: 100vw !important;",
      "  min-height: 100vh !important;",
      "  object-fit: cover !important;",
      "  transform: none !important;",
      "  background: #000 !important;",
      "}",
      "#puretube-reload-btn {",
      "  display: inline-flex !important;",
      "  align-items: center !important;",
      "  justify-content: center !important;",
      "  width: 32px !important;",
      "  height: 32px !important;",
      "  margin: 0 4px !important;",
      "  border-radius: 999px !important;",
      "  border: 1px solid rgba(255,255,255,0.18) !important;",
      "  background: rgba(255,255,255,0.1) !important;",
      "  color: #f1f1f1 !important;",
      "  font-size: 16px !important;",
      "  line-height: 1 !important;",
      "  cursor: pointer !important;",
      "  flex: 0 0 auto !important;",
      "  transition: transform 0.35s ease, background 0.15s ease !important;",
      "}",
      "#puretube-reload-btn.pt-spinning {",
      "  transform: rotate(360deg) !important;",
      "}",
      "#puretube-fallback-bar {",
      "  position: fixed !important;",
      "  top: 10px !important;",
      "  right: 12px !important;",
      "  z-index: 2147483645 !important;",
      "  display: inline-flex !important;",
      "  align-items: center !important;",
      "  gap: 6px !important;",
      "  padding: 4px 8px !important;",
      "  border-radius: 999px !important;",
      "  background: rgba(20,20,20,0.88) !important;",
      "  border: 1px solid rgba(255,255,255,0.16) !important;",
      "  box-shadow: 0 4px 16px rgba(0,0,0,0.45) !important;",
      "}"
    ].join("\n");
    container.appendChild(style);
  }

  function extractWatchUrl(rawHref) {
    try {
      if (!rawHref || typeof rawHref !== "string") return null;
      var trimmed = rawHref.trim();
      if (!trimmed || trimmed.charAt(0) === "#" || /^javascript:/i.test(trimmed)) return null;
      var base = (typeof window !== "undefined" && window.location && window.location.href)
        ? window.location.href
        : "https://m.youtube.com/";
      var parsed = new URL(trimmed, base);
      var host = (parsed.hostname || "").toLowerCase();
      if (host === "youtu.be" || host.endsWith(".youtu.be")) {
        var seg = (parsed.pathname || "").replace(/^\/+/, "").split("/")[0];
        if (!/^[A-Za-z0-9_-]{11}$/.test(seg)) return null;
        var ytOut = new URL("https://m.youtube.com/watch");
        ytOut.searchParams.set("v", seg);
        var tParam = parsed.searchParams.get("t");
        if (tParam) ytOut.searchParams.set("t", tParam);
        return ytOut.toString();
      }
      var isYtHost = host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtube-nocookie.com" || host.endsWith(".youtube-nocookie.com");
      if (!isYtHost) return null;
      if (parsed.pathname !== "/watch") return null;
      var vid = parsed.searchParams.get("v") || "";
      if (!/^[A-Za-z0-9_-]{11}$/.test(vid)) return null;
      return parsed.toString();
    } catch (_) {
      return null;
    }
  }

  function extractShortsUrl(rawHref) {
    try {
      if (!rawHref || typeof rawHref !== "string") return null;
      var base = (typeof window !== "undefined" && window.location && window.location.href)
        ? window.location.href
        : "https://m.youtube.com/";
      var parsed = new URL(rawHref, base);
      var host = (parsed.hostname || "").toLowerCase();
      var isYtHost = host === "youtube.com" || host.endsWith(".youtube.com");
      if (!isYtHost) return null;
      if (/^\/shorts(\/|$)/.test(parsed.pathname || "")) return parsed.toString();
      return null;
    } catch (_) {
      return null;
    }
  }

  function extractBrowseUrlFromPlayer(rawHref) {
    try {
      if (!rawHref || typeof rawHref !== "string") return null;
      var trimmed = rawHref.trim();
      if (!trimmed || trimmed.charAt(0) === "#" || /^javascript:/i.test(trimmed)) return null;
      var base = (typeof window !== "undefined" && window.location && window.location.href)
        ? window.location.href
        : "https://m.youtube.com/";
      var parsed = new URL(trimmed, base);
      var host = (parsed.hostname || "").toLowerCase();
      var isYtHost = host === "youtube.com" || host.endsWith(".youtube.com");
      if (!isYtHost) return null;
      var p = parsed.pathname || "/";
      if (p === "/watch") return null;
      if (
        p === "/" ||
        p.indexOf("/@") === 0 ||
        p.indexOf("/channel/") === 0 ||
        p.indexOf("/c/") === 0 ||
        p.indexOf("/user/") === 0 ||
        p.indexOf("/results") === 0 ||
        p.indexOf("/feed/") === 0 ||
        p.indexOf("/playlist") === 0 ||
        p.indexOf("/shorts") === 0 ||
        p.indexOf("/hashtag/") === 0
      ) {
        return parsed.toString();
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  function ptIsYouTubeApiUrl(url) {
    try {
      var u = String(url || "");
      return /^https?:\/\/([^/]+\.)?youtube(?:kids)?\.com\/youtubei\/v1\/(player|next|browse|search|get_watch|reel\/reel_watch_sequence)\b/i.test(u);
    } catch (_) {
      return false;
    }
  }

  function setMiniMode(isMini) {
    var nextMini = Boolean(isMini);
    if (nextMini && !isMiniModeState) {
      try {
        savedPlayerScrollY = typeof window !== "undefined" ? (window.scrollY || window.pageYOffset || 0) : 0;
      } catch (_) {
        savedPlayerScrollY = 0;
      }
    }
    isMiniModeState = nextMini;
    ensureDualStyles();
    applyRoleAndMiniClasses();
    try {
      if (typeof window !== "undefined" && typeof window.scrollTo === "function") {
        if (nextMini) {
          window.scrollTo(0, 0);
        } else if (savedPlayerScrollY > 0) {
          var restoreY = savedPlayerScrollY;
          savedPlayerScrollY = 0;
          window.scrollTo(0, restoreY);
        }
      }
    } catch (_) {}
    return isMiniModeState;
  }

  function notifyHostOpenVideo(url) {
    try {
      if (typeof window !== "undefined" && window.PureTubeHost && typeof window.PureTubeHost.openVideo === "function") {
        window.PureTubeHost.openVideo(url);
        return true;
      }
    } catch (_) {}
    return false;
  }

  function notifyHostOpenInBrowse(url) {
    try {
      if (typeof window !== "undefined" && window.PureTubeHost && typeof window.PureTubeHost.openInBrowse === "function") {
        window.PureTubeHost.openInBrowse(url);
        return true;
      }
    } catch (_) {}
    return false;
  }

  function notifyHostBrowseShorts(url) {
    if (!extractShortsUrl(url || (typeof window !== "undefined" && window.location ? window.location.href : ""))) return;
    try {
      if (typeof window !== "undefined" && window.PureTubeHost && typeof window.PureTubeHost.onBrowseShorts === "function") {
        window.PureTubeHost.onBrowseShorts();
      }
    } catch (_) {}
  }

  function emitMediaProgress() {
    try {
      if (typeof window === "undefined" || !window.PureTubeHost || typeof window.PureTubeHost.onMediaProgress !== "function") return;
      var v = typeof findPrimaryVideo === "function" ? findPrimaryVideo() : (typeof document !== "undefined" ? document.querySelector("video") : null);
      var permille = 0;
      if (v && isFinite(v.duration) && v.duration > 0 && isFinite(v.currentTime)) {
        permille = Math.max(0, Math.min(1000, Math.round((v.currentTime / v.duration) * 1000)));
      }
      if (permille !== lastEmittedPermille) {
        lastEmittedPermille = permille;
        window.PureTubeHost.onMediaProgress(permille);
      }
    } catch (_) {}
  }

  function triggerBrowseReload(btn) {
    if (btn) {
      btn.classList.add("pt-spinning");
      setTimeout(function () {
        btn.classList.remove("pt-spinning");
      }, 450);
    }
    try {
      if (typeof window !== "undefined" && window.PureTubeHost && typeof window.PureTubeHost.reloadBrowse === "function") {
        window.PureTubeHost.reloadBrowse();
        return;
      }
    } catch (_) {}
    try {
      if (typeof window !== "undefined" && window.location) window.location.reload();
    } catch (_) {}
  }

  function mountBrowseReloadControl() {
    if (typeof document === "undefined" || !document.body) return;
    if (getPtRole() !== "browse") {
      var oldBar = document.getElementById("puretube-fallback-bar");
      if (oldBar && oldBar.parentNode) oldBar.parentNode.removeChild(oldBar);
      return;
    }
    var btn = document.getElementById("puretube-reload-btn");
    if (!btn) {
      btn = document.createElement("button");
      btn.id = "puretube-reload-btn";
      btn.type = "button";
      btn.textContent = "\u21bb";
      btn.title = "T\u1ea3i l\u1ea1i trang";
      btn.setAttribute("aria-label", "T\u1ea3i l\u1ea1i trang");
      btn.addEventListener("click", function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        triggerBrowseReload(btn);
      });
    }

    var topbar =
      document.querySelector("ytm-mobile-topbar-renderer .mobile-topbar-header-content") ||
      document.querySelector("ytm-mobile-topbar-renderer header") ||
      document.querySelector("#header-bar .mobile-topbar-header-content") ||
      document.querySelector("ytm-desktop-topbar-renderer #end") ||
      document.querySelector("ytd-masthead #end");

    var shieldBtn = document.getElementById("puretube-shield-btn");
    if (topbar) {
      var staleBar = document.getElementById("puretube-fallback-bar");
      if (staleBar && staleBar.parentNode) staleBar.parentNode.removeChild(staleBar);
      if (shieldBtn && topbar.contains(shieldBtn)) {
        if (btn.parentNode !== topbar || btn.nextSibling !== shieldBtn) {
          topbar.insertBefore(btn, shieldBtn);
        }
      } else if (btn.parentNode !== topbar) {
        var searchBtn = topbar.querySelector("button, a, ytm-topbar-menu-button-renderer");
        if (searchBtn) {
          topbar.insertBefore(btn, searchBtn);
        } else {
          topbar.appendChild(btn);
        }
      }
      return;
    }

    var fallbackBar = document.getElementById("puretube-fallback-bar");
    if (!fallbackBar) {
      fallbackBar = document.createElement("div");
      fallbackBar.id = "puretube-fallback-bar";
      document.body.appendChild(fallbackBar);
    }
    if (shieldBtn && shieldBtn.parentNode !== fallbackBar) {
      fallbackBar.style.right = "60px";
    }
    if (btn.parentNode !== fallbackBar) {
      fallbackBar.appendChild(btn);
    }
  }

  function installDualWebViewBridge() {
    if (typeof window === "undefined") return;
    window.__puretubeSetMiniMode = setMiniMode;

    var exportedApi = {
      extractWatchUrl: extractWatchUrl,
      extractBrowseUrlFromPlayer: extractBrowseUrlFromPlayer,
      setMiniMode: setMiniMode,
      getRole: getPtRole,
      pruneYouTubeAds: typeof pruneYouTubeAds === "function" ? pruneYouTubeAds : function (payload) { return payload; },
      isYouTubeApiUrl: typeof isYouTubeApiUrl === "function" ? isYouTubeApiUrl : ptIsYouTubeApiUrl
    };
    window.__PureTubeExtTestAPI = Object.assign(window.__PureTubeExtTestAPI || {}, exportedApi);
    window.__PureTubeInjectAPI = Object.assign(window.__PureTubeInjectAPI || {}, exportedApi);

    if (dualHooksInstalled) return;
    dualHooksInstalled = true;

    applyRoleAndMiniClasses();
    ensureDualStyles();
    if (getPtRole() === "browse" && window.location && window.location.href) {
      notifyHostBrowseShorts(window.location.href);
    }

    if (typeof document !== "undefined") {
      document.addEventListener("click", function (ev) {
        try {
          if (!ev || ev.defaultPrevented) return;
          if (typeof ev.button === "number" && ev.button !== 0) return;
          var target = ev.target;
          if (!target || typeof target.closest !== "function") return;
          if (target.closest("ytm-menu-renderer, ytm-button-renderer, #puretube-shield-btn, #puretube-reload-btn")) return;
          var anchor = target.closest("a[href]");
          if (!anchor) return;
          var href = anchor.getAttribute("href") || anchor.href;
          var role = getPtRole();
          if (role === "browse") {
            var watchUrl = extractWatchUrl(href);
            if (watchUrl && notifyHostOpenVideo(watchUrl)) {
              ev.preventDefault();
              ev.stopPropagation();
              if (typeof ev.stopImmediatePropagation === "function") ev.stopImmediatePropagation();
              return;
            }
            notifyHostBrowseShorts(href);
          } else if (role === "player") {
            var browseUrl = extractBrowseUrlFromPlayer(href);
            if (browseUrl && notifyHostOpenInBrowse(browseUrl)) {
              ev.preventDefault();
              ev.stopPropagation();
              if (typeof ev.stopImmediatePropagation === "function") ev.stopImmediatePropagation();
            }
          }
        } catch (_) {}
      }, true);
    }

    if (typeof history !== "undefined") {
      var wrapHistoryMethod = function (methodName) {
        var orig = history[methodName];
        if (typeof orig !== "function") return;
        history[methodName] = function (state, title, url) {
          try {
            if (url !== undefined && url !== null) {
              var nextUrl = String(url);
              var role = getPtRole();
              if (role === "browse") {
                var watchUrl = extractWatchUrl(nextUrl);
                if (watchUrl && notifyHostOpenVideo(watchUrl)) {
                  return;
                }
                notifyHostBrowseShorts(nextUrl);
              } else if (role === "player") {
                var browseUrl = extractBrowseUrlFromPlayer(nextUrl);
                if (browseUrl && notifyHostOpenInBrowse(browseUrl)) {
                  return;
                }
              }
            }
          } catch (_) {}
          return orig.apply(this, arguments);
        };
      };
      wrapHistoryMethod("pushState");
      wrapHistoryMethod("replaceState");
    }
  }

  installDualWebViewBridge();

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", bootDomHooks);
    } else {
      bootDomHooks();
    }
    setInterval(function () {
      applyRoleAndMiniClasses();
      ensureStyles();
      ensureDualStyles();
      mountShieldButton();
      mountBrowseReloadControl();
      var v = findPrimaryVideo();
      if (v) bindVideoListeners(v);
      runAdSkipTick();
      runSponsorBlockTick();
      emitMediaState(false);
      emitMediaProgress();
    }, 350);
  }
})();
