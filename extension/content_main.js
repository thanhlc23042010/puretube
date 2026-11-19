(function () {
  "use strict";

  var host = (window.location && window.location.hostname) || "";
  var isYtHost = /(^|\.)youtube\.com$/i.test(host) || host === "youtu.be";
  if (!isYtHost && !window.__PURETUBE_TEST_MODE__) {
    return;
  }
  if (window.__PURETUBE_EXT_MAIN__) {
    return;
  }
  window.__PURETUBE_EXT_MAIN__ = true;

  var prefs = {
    adblock: true,
    sponsorBlock: true,
    backgroundPlay: true,
    antiIdle: true,
  };

  function postStats(adsDelta, sponsorsDelta, secondsDelta) {
    if (!adsDelta && !sponsorsDelta && !secondsDelta) return;
    try {
      var targetOrigin =
        window.location && window.location.origin && window.location.origin !== "null"
          ? window.location.origin
          : "*";
      window.postMessage(
        {
          source: "puretube-ext",
          type: "PURETUBE_EXT_STATS",
          adsDelta: adsDelta || 0,
          sponsorsDelta: sponsorsDelta || 0,
          secondsDelta: secondsDelta || 0,
        },
        targetOrigin
      );
    } catch (_) {}
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window || !event.data || event.data.type !== "PURETUBE_EXT_PREFS") {
      return;
    }
    var incoming = event.data.prefs;
    if (!incoming || typeof incoming !== "object") return;
    if (typeof incoming.adblock === "boolean") prefs.adblock = incoming.adblock;
    if (typeof incoming.sponsorBlock === "boolean") prefs.sponsorBlock = incoming.sponsorBlock;
    if (typeof incoming.backgroundPlay === "boolean") prefs.backgroundPlay = incoming.backgroundPlay;
    if (typeof incoming.antiIdle === "boolean") prefs.antiIdle = incoming.antiIdle;
  });

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
    var removedCount = 0;
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
            removedCount += 1;
          } else {
            walk(item, depth + 1);
          }
        }
        return;
      }

      if (Array.isArray(node.adPlacements) && node.adPlacements.length > 0) {
        removedCount += node.adPlacements.length;
        node.adPlacements = [];
      }
      if (Array.isArray(node.playerAds) && node.playerAds.length > 0) {
        removedCount += node.playerAds.length;
        node.playerAds = [];
      }
      if (Array.isArray(node.adSlots) && node.adSlots.length > 0) {
        removedCount += node.adSlots.length;
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
          removedCount += 1;
          continue;
        }
        var child = node[key];
        if (child && typeof child === "object") {
          walk(child, depth + 1);
        }
      }
    }

    walk(root, 0);
    if (removedCount > 0) {
      postStats(removedCount, 0, 0);
    }
    return root;
  }

  function isYouTubeApiUrl(urlStr) {
    if (!urlStr || typeof urlStr !== "string") return false;
    if (/\/api\/stats\/(watchtime|playback)|googlevideo\.com|sponsor\.ajay\.app/i.test(urlStr)) {
      return false;
    }
    return /\/youtubei\/v1\/(player|next|browse|search|reel\/|get_watch|guide)/i.test(urlStr);
  }

  window.__PureTubeExtTestAPI = {
    pruneYouTubeAds: pruneYouTubeAds,
    isYouTubeApiUrl: isYouTubeApiUrl,
    getPrefs: function () {
      return prefs;
    },
  };

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
              var cleaned = JSON.stringify(pruneYouTubeAds(JSON.parse(raw)));
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
                var cleaned = JSON.stringify(pruneYouTubeAds(JSON.parse(val)));
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

  function installVisibilitySpoof() {
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
      Object.defineProperty(Document.prototype, "webkitHidden", {
        configurable: true,
        get: function () {
          return prefs.backgroundPlay ? false : undefined;
        },
      });
      Object.defineProperty(Document.prototype, "webkitVisibilityState", {
        configurable: true,
        get: function () {
          return prefs.backgroundPlay ? "visible" : undefined;
        },
      });
    } catch (_) {}

    var blockedVisEvents = {
      visibilitychange: true,
      webkitvisibilitychange: true,
      pagehide: true,
      freeze: true,
    };

    try {
      var docAdd = Document.prototype.addEventListener;
      Document.prototype.addEventListener = function (type) {
        if (prefs.backgroundPlay && blockedVisEvents[String(type || "").toLowerCase()]) {
          return;
        }
        return docAdd.apply(this, arguments);
      };
    } catch (_) {}

    try {
      var winAdd = Window.prototype.addEventListener;
      Window.prototype.addEventListener = function (type) {
        if (prefs.backgroundPlay && blockedVisEvents[String(type || "").toLowerCase()]) {
          return;
        }
        return winAdd.apply(this, arguments);
      };
    } catch (_) {}
  }
  installVisibilitySpoof();

  function findPrimaryVideo() {
    var vids = document.querySelectorAll ? document.querySelectorAll("video") : [];
    for (var i = 0; i < vids.length; i++) {
      if (vids[i] && (vids[i].currentSrc || vids[i].src || vids[i].readyState > 0)) {
        return vids[i];
      }
    }
    return vids[0] || null;
  }

  var savedMuteBeforeAd = null;
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
        postStats(1, 0, 15);
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

  function runAntiIdleTick() {
    if (!prefs.antiIdle || !document.querySelectorAll) return;
    var dialogs = document.querySelectorAll("tp-yt-paper-dialog yt-confirm-dialog-renderer");
    for (var i = 0; i < dialogs.length; i++) {
      var dlg = dialogs[i];
      if (!dlg || dlg.dataset.ptHandled === "1") continue;
      var paper = dlg.closest ? dlg.closest("tp-yt-paper-dialog") : null;
      if (paper && (paper.getAttribute("aria-hidden") === "true" || paper.style.display === "none")) {
        continue;
      }
      var txt = (dlg.textContent || "").trim();
      if (
        /tiếp tục xem|continue watching|video paused|đã tạm dừng/i.test(txt) &&
        !/xóa|hủy đăng ký|đăng xuất|delete|remove|sign out/i.test(txt)
      ) {
        var confirmBtn = dlg.querySelector("#confirm-button button, yt-button-renderer#confirm-button");
        if (confirmBtn) {
          dlg.dataset.ptHandled = "1";
          try {
            confirmBtn.click();
          } catch (_) {}
        }
      }
    }
  }

  var sbCache = {};
  var sbSkippedUuids = {};
  var sbLastVideoId = "";
  var sbToastTimer = null;

  function getActiveVideoId() {
    var href = (window.location && window.location.href) || "";
    var watchM = href.match(/[?&]v=([A-Za-z0-9_-]{11})/);
    if (watchM) return watchM[1];
    var shortsM = href.match(/\/shorts\/([A-Za-z0-9_-]{11})/);
    if (shortsM) return shortsM[1];
    return "";
  }

  function showSponsorToast(seg, videoEl) {
    if (!document.body) return;
    var old = document.getElementById("puretube-ext-sb-toast");
    if (old) old.remove();
    var toast = document.createElement("div");
    toast.id = "puretube-ext-sb-toast";
    var savedSec = Math.max(1, Math.round(seg.segment[1] - seg.segment[0]));

    var dot = document.createElement("span");
    dot.className = "pt-toast-badge";
    var txt = document.createElement("span");
    txt.textContent = "PureTube Shield · Đã bỏ qua đoạn tài trợ (+" + savedSec + "s)";
    var undoBtn = document.createElement("button");
    undoBtn.type = "button";
    undoBtn.textContent = "Xem lại";
    undoBtn.addEventListener("click", function () {
      if (videoEl) videoEl.currentTime = seg.segment[0];
      toast.remove();
    });

    toast.appendChild(dot);
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
        var savedSec = Math.max(1, Math.round(e - t));
        postStats(0, 1, savedSec);
        try {
          v.currentTime = e;
          showSponsorToast(seg, v);
        } catch (_) {}
        break;
      }
    }
  }

  if (typeof document !== "undefined" && typeof setInterval === "function") {
    setInterval(function () {
      runAdSkipTick();
      runAntiIdleTick();
      runSponsorBlockTick();
    }, 300);
  }
})();
