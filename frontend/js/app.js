(function () {
  const SEEN_SHORTS_KEY = "puretube_seen_shorts_v1";

  const state = {
    activeTab: "home",
    category: "all",
    searchQuery: "",
    homeNextToken: "",
    homeItems: [],
    activeSubChannel: null,
    ytPlaylistItemsMap: {},
    expandedYtPlaylists: { WL: true, LL: true },
    watchLaterActive: false,
    queue: [],
    queueIndex: -1,
    queueName: "",
    shortsItems: [],
    shortsIndex: 0,
    shortsTopic: "",
    shortsSeed: Math.floor(Math.random() * 12) + 1,
    shortsLoadingMore: false,
    shortsMuted: false,
    shortsVideoData: null,
    channelPage: { ref: "", name: "", tab: "videos", data: null },
    videoReaction: "none",
    commentsNextToken: "",
    serverInfo: null,
    authStatus: { logged_in: false, account_name: "", method: "" },
    currentVideoSummary: null,
    currentVideoFull: null,
    suggestTimer: null,
    prefetchHoverTimer: null,
  };

  function getSeenShortIds() {
    try {
      const arr = JSON.parse(localStorage.getItem(SEEN_SHORTS_KEY) || "[]");
      return Array.isArray(arr) ? arr : [];
    } catch (_) {
      return [];
    }
  }

  function markShortSeen(vid) {
    if (!vid) return;
    try {
      const list = getSeenShortIds().filter((id) => id !== vid);
      list.push(vid);
      localStorage.setItem(SEEN_SHORTS_KEY, JSON.stringify(list.slice(-240)));
    } catch (_) {}
  }

  const SPONSOR_LABELS = {
    sponsor: { label: "Quảng cáo tài trợ", color: "#10B981" },
    selfpromo: { label: "Tự quảng cáo / Kêu gọi mua hàng", color: "#F59E0B" },
    interaction: { label: "Nhắc bấm Like / Đăng ký", color: "#EC4899" },
    intro: { label: "Đoạn mở đầu (Intro)", color: "#06B6D4" },
    outro: { label: "Đoạn kết (Outro)", color: "#3B82F6" },
    music_offtopic: { label: "Đoạn không phải nhạc trong MV", color: "#A855F7" },
  };

  let appToastTimer = null;
  window.showAppToast = function showAppToast(message) {
    const el = document.getElementById("app-toast");
    if (!el) return;
    el.textContent = message;
    el.classList.remove("hidden");
    clearTimeout(appToastTimer);
    appToastTimer = setTimeout(() => el.classList.add("hidden"), 3600);
  };

  function registerServiceWorker() {
    if ("serviceWorker" in navigator && !PureAPI.isNativeShell()) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }

  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text || "";
    return div.innerHTML;
  }

  function scheduleHoverPrefetch(videoId) {
    clearTimeout(state.prefetchHoverTimer);
    state.prefetchHoverTimer = setTimeout(() => {
      PureAPI.prefetchVideo(videoId);
    }, 150);
  }

  function renderSkeletonGrid(container, count = 8) {
    container.innerHTML = Array.from({ length: count })
      .map(
        () => `
      <div class="skeleton-card">
        <div class="skeleton-box skeleton-thumb"></div>
        <div class="skeleton-box skeleton-line"></div>
        <div class="skeleton-box skeleton-line short"></div>
      </div>`
      )
      .join("");
  }

  function renderVideoGrid(container, items, append = false) {
    if (!append && (!items || !items.length)) {
      container.innerHTML = `
        <div class="empty-state" style="grid-column: 1 / -1;">
          <h2>Không tìm thấy video phù hợp</h2>
          <p>Hãy thử tìm với từ khóa khác hoặc dán trực tiếp liên kết YouTube vào thanh tìm kiếm phía trên.</p>
        </div>`;
      return;
    }
    if (!items || !items.length) return;

    const html = items
      .map((item) => {
        const initial = (item.channel || "P").trim().charAt(0).toUpperCase();
        const viewText = item.view_count ? PureAPI.formatViews(item.view_count) : "Không quảng cáo";
        return `
        <button type="button" class="video-card" data-video-id="${escapeHtml(item.id)}">
          <div class="thumb-wrap">
            <img class="thumb-img" src="${escapeHtml(item.thumbnail)}" alt="${escapeHtml(item.title)}" loading="lazy" />
            ${item.duration_text && item.duration_text !== "0:00" ? `<span class="duration-badge">${escapeHtml(item.duration_text)}</span>` : ""}
          </div>
          <div class="card-meta">
            <div class="card-avatar">${escapeHtml(initial)}</div>
            <div class="card-info">
              <h3 class="card-title">${escapeHtml(item.title)}</h3>
              <div class="card-sub">${escapeHtml(item.channel)} · ${escapeHtml(viewText)}</div>
            </div>
          </div>
        </button>`;
      })
      .join("");

    const bindCard = (card, video) => {
      card.addEventListener("mouseenter", () => scheduleHoverPrefetch(video.id));
      card.addEventListener("touchstart", () => PureAPI.prefetchVideo(video.id), { passive: true });
      card.addEventListener("click", () => {
        state.queue = [];
        state.queueIndex = -1;
        state.queueName = "";
        openWatchVideo(video);
      });
    };

    if (append) {
      const startIdx = container.querySelectorAll(".video-card").length;
      container.insertAdjacentHTML("beforeend", html);
      const cards = container.querySelectorAll(".video-card");
      items.forEach((video, i) => {
        const card = cards[startIdx + i];
        if (card) bindCard(card, video);
      });
    } else {
      container.innerHTML = html;
      container.querySelectorAll(".video-card").forEach((card, idx) => bindCard(card, items[idx]));
      items.slice(0, 2).forEach((v) => PureAPI.prefetchVideo(v.id));
    }
  }

  function stopShortsPlayback() {
    const sv = document.getElementById("shorts-video");
    if (sv) {
      sv.pause();
      sv.removeAttribute("src");
      sv.load();
    }
    if (state._shortsAudio) {
      state._shortsAudio.pause();
      state._shortsAudio.removeAttribute("src");
    }
  }

  function switchTab(tabName) {
    if (state.activeTab === "shorts" && tabName !== "shorts") {
      stopShortsPlayback();
    }
    state.activeTab = tabName;
    document.querySelectorAll(".page-view").forEach((view) => {
      view.classList.toggle("active", view.id === `view-${tabName}`);
    });

    const navTab = tabName === "watch" || tabName === "channel" ? "" : tabName;
    document.querySelectorAll(".nav-item, .bottom-nav-item").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === navTab);
    });

    updateMiniPlayerVisibility();

    if (tabName === "shorts") renderShortsView();
    if (tabName === "subscriptions") renderSubscriptionsView();
    if (tabName === "playlists") renderPlaylistsView();
    if (tabName === "history") renderHistoryView();
    if (tabName === "settings") renderSettingsView();

    document.getElementById("view-container").scrollTop = 0;
  }

  function updateMiniPlayerVisibility() {
    const mini = document.getElementById("mini-player");
    const shouldShow = PurePlayer.hasActiveMedia() && state.activeTab !== "watch";
    mini.classList.toggle("hidden", !shouldShow);
  }

  function updateMiniPlayerInfo(video) {
    if (!video) return;
    document.getElementById("mini-thumb").src = video.thumbnail || "";
    document.getElementById("mini-title").textContent = video.title || "";
    document.getElementById("mini-channel").textContent = video.channel || "";
  }

  function updateShieldStatsUI() {
    const { adsBlocked, secondsSaved } = Store.state.stats;
    const adsEl = document.getElementById("sidebar-ads-blocked");
    const timeEl = document.getElementById("sidebar-time-saved");
    if (adsEl) adsEl.textContent = String(adsBlocked);
    if (timeEl) {
      if (secondsSaved >= 60) {
        const mins = Math.floor(secondsSaved / 60);
        const rem = secondsSaved % 60;
        timeEl.textContent = `${mins} phút ${rem} giây`;
      } else {
        timeEl.textContent = `${secondsSaved} giây`;
      }
    }
  }

  function updateAuthButtonUI() {
    const btn = document.getElementById("open-auth-modal-btn");
    const lbl = document.getElementById("auth-btn-label");
    if (!btn || !lbl) return;
    const logged = Boolean(state.authStatus?.logged_in);
    btn.classList.toggle("signed-in", logged);
    lbl.textContent = logged ? state.authStatus.account_name || "Google" : "Đăng nhập";
  }

  async function refreshAuthStatus() {
    try {
      state.authStatus = await PureAPI.getAuthStatus();
    } catch (_) {
      state.authStatus = { logged_in: false, account_name: "", method: "" };
    }
    updateAuthButtonUI();
  }

  async function loadTrending(category, { refresh = false, append = false } = {}) {
    state.category = category;
    state.searchQuery = "";
    const grid = document.getElementById("home-video-grid");
    const moreWrap = document.getElementById("home-load-more-wrap");
    const moreBtn = document.getElementById("home-load-more-btn");

    if (!append) {
      state.homeNextToken = "";
      state.homeItems = [];
      document.getElementById("home-title").textContent =
        category === "all"
          ? "Video thịnh hành sạch quảng cáo"
          : `Chủ đề: ${document.querySelector(`.chip[data-category="${category}"]`)?.textContent || "Khám phá"}`;
      document.getElementById("clear-search-results-btn").classList.add("hidden");
      document.getElementById("category-strip").classList.remove("hidden");
      document.getElementById("home-refresh-btn")?.classList.remove("hidden");
      moreWrap?.classList.add("hidden");
      renderSkeletonGrid(grid, 8);
    } else if (moreBtn) {
      moreBtn.disabled = true;
      moreBtn.textContent = "Đang tải thêm...";
    }

    try {
      const data = await PureAPI.getTrending(category, append ? state.homeNextToken : "", refresh);
      if (!append && category === "all" && data.personalized) {
        document.getElementById("home-title").textContent = "Đề xuất cho bạn từ YouTube (Không QC)";
      }
      const existingIds = new Set(state.homeItems.map((x) => x.id));
      const freshItems = (data.items || []).filter((x) => x?.id && !existingIds.has(x.id));
      state.homeItems.push(...freshItems);
      state.homeNextToken = data.next_continuation || "";
      renderVideoGrid(grid, append ? freshItems : state.homeItems, append);
      if (moreWrap) {
        moreWrap.classList.toggle("hidden", !state.homeNextToken);
      }
    } catch (err) {
      if (!append) {
        grid.innerHTML = `<div class="empty-state" style="grid-column: 1 / -1;"><h2>Không thể tải video</h2><p>${escapeHtml(err.message)}</p></div>`;
      } else if (window.showAppToast) {
        window.showAppToast(err.message);
      }
    } finally {
      if (moreBtn) {
        moreBtn.disabled = false;
        moreBtn.textContent = "Tải thêm video";
      }
    }
  }

  async function performSearch(query) {
    const clean = (query || "").trim();
    if (!clean) return;
    state.searchQuery = clean;
    state.homeNextToken = "";
    document.getElementById("search-suggestions").classList.add("hidden");
    switchTab("home");

    const grid = document.getElementById("home-video-grid");
    document.getElementById("home-title").textContent = `Kết quả cho "${clean}"`;
    document.getElementById("clear-search-results-btn").classList.remove("hidden");
    document.getElementById("home-refresh-btn")?.classList.add("hidden");
    document.getElementById("home-load-more-wrap")?.classList.add("hidden");
    renderSkeletonGrid(grid, 8);

    try {
      const data = await PureAPI.search(clean);
      if (data.direct_video_id) {
        openWatchVideo({
          id: data.direct_video_id,
          title: "Đang mở video từ liên kết...",
          channel: "YouTube",
          thumbnail: `https://i.ytimg.com/vi/${data.direct_video_id}/hqdefault.jpg`,
        });
        loadTrending(state.category);
        return;
      }
      renderVideoGrid(grid, data.items || []);
    } catch (err) {
      grid.innerHTML = `<div class="empty-state" style="grid-column: 1 / -1;"><h2>Lỗi tìm kiếm</h2><p>${escapeHtml(err.message)}</p></div>`;
    }
  }

  async function openWatchVideo(summary) {
    if (!summary || !summary.id) return;
    stopShortsPlayback();
    state.currentVideoSummary = summary;
    state.videoReaction = "none";
    state.commentsNextToken = "";
    updateMiniPlayerInfo(summary);
    switchTab("watch");

    document.getElementById("watch-title").textContent = summary.title || "Đang tải video...";
    document.getElementById("watch-channel-name").textContent = summary.channel || "...";
    document.getElementById("watch-channel-initial").textContent = (summary.channel || "P").trim().charAt(0).toUpperCase();
    const avImg = document.getElementById("watch-channel-avatar-img");
    if (avImg) {
      avImg.src = "";
      avImg.classList.add("hidden");
    }
    document.getElementById("watch-channel-initial").classList.remove("hidden");
    document.getElementById("watch-like-btn")?.classList.remove("active");
    document.getElementById("watch-dislike-btn")?.classList.remove("active");
    state.watchLaterActive = false;
    const wlBtnReset = document.getElementById("watch-watchlater-btn");
    if (wlBtnReset) {
      wlBtnReset.classList.remove("active");
      const wlSpan = wlBtnReset.querySelector("span");
      if (wlSpan) wlSpan.textContent = "Xem sau";
    }
    document.getElementById("watch-like-count").textContent = "Thích";
    document.getElementById("comments-header-title").textContent = "Bình luận";
    document.getElementById("comments-load-more-btn")?.classList.add("hidden");
    document.getElementById("comments-list").innerHTML = `<div class="skeleton-box skeleton-line" style="height:54px"></div>`;
    document.getElementById("watch-views").textContent = "Đang nạp luồng phát...";
    document.getElementById("watch-sponsor-summary").textContent = "Đang kiểm tra SponsorBlock...";
    document.getElementById("watch-sync-hint").textContent = state.authStatus?.logged_in
      ? `Đang đồng bộ lịch sử với ${state.authStatus.account_name}`
      : "Lưu cục bộ trên thiết bị";
    document.getElementById("watch-description").textContent = "";
    document.getElementById("watch-description").classList.add("hidden");
    document.getElementById("sponsor-legend").classList.add("hidden");
    document.getElementById("chapters-strip").classList.add("hidden");
    document.getElementById("related-list").innerHTML = `<div class="skeleton-box skeleton-line" style="height:76px"></div><div class="skeleton-box skeleton-line" style="height:76px"></div>`;

    renderQueuePanel();
    PurePlayer.showSpinner(true);

    try {
      const full = await PureAPI.getVideo(summary.id);
      state.currentVideoFull = full;
      state.currentVideoSummary = {
        id: full.id,
        title: full.title,
        channel: full.channel,
        channel_id: full.channel_id,
        duration: full.duration,
        duration_text: full.duration_text,
        thumbnail: full.thumbnail,
      };

      Store.recordAdBlocked(15);
      Store.addHistory(state.currentVideoSummary);
      updateMiniPlayerInfo(state.currentVideoSummary);

      const shieldSpan = document.querySelector("#watch-adshield-pill span");
      if (shieldSpan) {
        shieldSpan.textContent = full.is_live ? "TRỰC TIẾP · Sạch 100%" : "Luồng sạch 100%";
      }
      document.getElementById("watch-title").textContent = full.title;
      document.getElementById("watch-channel-name").textContent = full.channel;
      document.getElementById("watch-channel-initial").textContent = full.channel.trim().charAt(0).toUpperCase();
      document.getElementById("watch-views").textContent = full.is_live ? "Đang phát trực tiếp" : PureAPI.formatViews(full.view_count);
      document.getElementById("watch-description").textContent = full.description || "Video này không có mô tả.";
      updateSubscribeButton(full.channel);
      renderChapters(full.chapters || []);

      // Start playback IMMEDIATELY before waiting for SponsorBlock, comments & related search
      PurePlayer.loadVideo(full);

      if (state.queue.length && state.queueIndex + 1 < state.queue.length) {
        PureAPI.prefetchVideo(state.queue[state.queueIndex + 1].id);
      }

      // Check Watch Later membership silently when logged in
      if (state.authStatus?.logged_in) {
        PureAPI.getYoutubePlaylists(full.id)
          .then((plRes) => {
            if (!state.currentVideoFull || state.currentVideoFull.id !== full.id) return;
            const wlPl = (plRes?.playlists || []).find((p) => p.id === "WL");
            if (wlPl?.contains_selected) {
              state.watchLaterActive = true;
              const wlBtn = document.getElementById("watch-watchlater-btn");
              if (wlBtn) {
                wlBtn.classList.add("active");
                const sp = wlBtn.querySelector("span");
                if (sp) sp.textContent = "Đã thêm Xem sau";
              }
            }
          })
          .catch(() => {});
      }

      // Fetch SponsorBlock, channel/like metadata, comments token & related asynchronously
      PureAPI.getVideoExtras(full.id, full.channel, full.title)
        .then((extras) => {
          if (!state.currentVideoFull || state.currentVideoFull.id !== full.id) return;
          const segs = extras.sponsor_segments || [];
          const related = extras.related || [];
          state.currentVideoFull.sponsor_segments = segs;
          state.currentVideoFull.related = related;
          if (extras.channel_id && /^UC[A-Za-z0-9_-]{22}$/.test(extras.channel_id)) {
            state.currentVideoFull.channel_id = extras.channel_id;
          }
          if (extras.channel_avatar && avImg) {
            avImg.src = extras.channel_avatar;
            avImg.classList.remove("hidden");
            document.getElementById("watch-channel-initial").classList.add("hidden");
          }
          if (extras.subscriber_count_text) {
            document.getElementById("watch-sync-hint").textContent = extras.subscriber_count_text;
          }
          if (extras.like_count_text) {
            document.getElementById("watch-like-count").textContent = extras.like_count_text;
          }
          if (extras.comment_count_text) {
            document.getElementById("comments-header-title").textContent = `Bình luận (${extras.comment_count_text})`;
          }

          document.getElementById("watch-sponsor-summary").textContent =
            segs.length > 0
              ? `SponsorBlock: Phát hiện ${segs.length} đoạn tự động bỏ qua`
              : "Không có đoạn tài trợ được báo cáo";
          renderSponsorLegend(segs);
          renderRelatedList(related);
          PurePlayer.setSponsorSegments(segs);
          loadVideoComments(full.id, extras.comments_token || "", false);

          if (related.length > 0) {
            PureAPI.prefetchVideo(related[0].id);
          }
        })
        .catch(() => {
          document.getElementById("watch-sponsor-summary").textContent = "Luồng phát sạch quảng cáo";
          loadVideoComments(full.id, "", false);
        });
    } catch (err) {
      PurePlayer.showSpinner(false);
      window.showAppToast(err.message || "Không thể phát video này.");
    }
  }

  function renderCommentHtml(c, isReply = false) {
    const initial = (c.author || "U").trim().charAt(0).toUpperCase();
    const avatarHtml = c.avatar
      ? `<img class="comment-avatar" src="${escapeHtml(c.avatar)}" alt="" loading="lazy" />`
      : `<div class="comment-avatar comment-avatar-fallback">${escapeHtml(initial)}</div>`;
    return `
      <div class="comment-item ${isReply ? "comment-reply" : ""}" data-comment-id="${escapeHtml(c.id)}">
        ${avatarHtml}
        <div class="comment-body">
          <div class="comment-meta">
            <span class="comment-author ${c.is_creator ? "creator" : ""}">${escapeHtml(c.author)}</span>
            <span class="comment-time">${escapeHtml(c.published)}</span>
          </div>
          <div class="comment-text">${escapeHtml(c.text)}</div>
          <div class="comment-actions">
            ${c.likes ? `<span class="comment-likes">👍 ${escapeHtml(c.likes)}</span>` : ""}
            ${c.hearted ? `<span class="comment-heart" title="Chủ kênh đã thả tim">❤</span>` : ""}
            ${
              !isReply && c.reply_token
                ? `<button type="button" class="btn-subtle btn-xs comment-replies-btn" data-reply-token="${escapeHtml(c.reply_token)}">Xem ${escapeHtml(c.reply_count || "")} phản hồi</button>`
                : ""
            }
          </div>
          <div class="comment-replies-box hidden"></div>
        </div>
      </div>`;
  }

  async function loadVideoComments(videoId, continuation = "", append = false) {
    const list = document.getElementById("comments-list");
    const moreBtn = document.getElementById("comments-load-more-btn");
    if (!list) return;
    if (!append) {
      list.innerHTML = `<div class="skeleton-box skeleton-line" style="height:54px"></div>`;
    }
    try {
      const data = await PureAPI.getComments(videoId, continuation);
      if (!state.currentVideoFull || state.currentVideoFull.id !== videoId) return;
      const items = data.comments || [];
      state.commentsNextToken = data.next_continuation || "";
      if (!append) list.innerHTML = "";
      if (!items.length && !append) {
        list.innerHTML = `<p class="settings-desc">Video này chưa có bình luận hoặc đã tắt bình luận.</p>`;
        moreBtn?.classList.add("hidden");
        return;
      }
      const wrapper = document.createElement("div");
      wrapper.innerHTML = items.map((c) => renderCommentHtml(c, false)).join("");
      wrapper.querySelectorAll(".comment-replies-btn").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const itemEl = btn.closest(".comment-item");
          const repBox = itemEl?.querySelector(".comment-replies-box");
          if (!repBox) return;
          if (!repBox.classList.contains("hidden") && repBox.childElementCount > 0) {
            repBox.classList.add("hidden");
            return;
          }
          btn.disabled = true;
          const orig = btn.textContent;
          btn.textContent = "Đang tải...";
          try {
            const repData = await PureAPI.getComments(videoId, btn.dataset.replyToken);
            const reps = repData.comments || [];
            repBox.innerHTML = reps.length
              ? reps.map((r) => renderCommentHtml(r, true)).join("")
              : `<span class="settings-desc">Không có phản hồi.</span>`;
            repBox.classList.remove("hidden");
          } catch (_) {
            window.showAppToast("Không tải được phản hồi.");
          } finally {
            btn.disabled = false;
            btn.textContent = orig;
          }
        });
      });
      while (wrapper.firstChild) list.appendChild(wrapper.firstChild);
      if (moreBtn) {
        moreBtn.classList.toggle("hidden", !state.commentsNextToken);
      }
    } catch (_) {
      if (!append) list.innerHTML = `<p class="settings-desc">Không thể tải bình luận lúc này.</p>`;
    }
  }

  function updateSubscribeButton(channelName) {
    const btn = document.getElementById("watch-subscribe-btn");
    const isSub = Store.isSubscribed(channelName);
    btn.classList.toggle("subscribed", isSub);
    btn.textContent = isSub ? "Đã đăng ký" : "Đăng ký";
  }

  function renderSponsorLegend(segments) {
    const el = document.getElementById("sponsor-legend");
    if (!segments || !segments.length) {
      el.classList.add("hidden");
      el.innerHTML = "";
      return;
    }
    const uniqueCats = new Map();
    segments.forEach((s) => {
      if (!uniqueCats.has(s.category)) uniqueCats.set(s.category, s);
    });
    el.innerHTML = Array.from(uniqueCats.values())
      .map(
        (s) => `
      <span class="legend-tag">
        <span class="legend-dot" style="background:${s.color}"></span>
        <span>${escapeHtml(s.label)}</span>
      </span>`
      )
      .join("");
    el.classList.remove("hidden");
  }

  function renderChapters(chapters) {
    const el = document.getElementById("chapters-strip");
    if (!chapters || !chapters.length) {
      el.classList.add("hidden");
      el.innerHTML = "";
      return;
    }
    el.innerHTML = chapters
      .map(
        (ch) => `
      <button type="button" class="chapter-chip" data-start="${ch.start_time}">
        <strong>${PureAPI.formatTime(ch.start_time)}</strong>${escapeHtml(ch.title)}
      </button>`
      )
      .join("");
    el.querySelectorAll(".chapter-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        PurePlayer.seekTo(parseFloat(btn.dataset.start));
      });
    });
    el.classList.remove("hidden");
  }

  function renderRelatedList(items) {
    const container = document.getElementById("related-list");
    if (!items || !items.length) {
      container.innerHTML = `<p class="settings-desc">Không có video đề xuất.</p>`;
      return;
    }
    container.innerHTML = items
      .map(
        (item) => `
      <button type="button" class="compact-video-row" data-vid="${escapeHtml(item.id)}">
        <div class="compact-thumb-wrap">
          <img src="${escapeHtml(item.thumbnail)}" alt="" loading="lazy" />
          ${item.duration_text && item.duration_text !== "0:00" ? `<span class="duration-badge">${escapeHtml(item.duration_text)}</span>` : ""}
        </div>
        <div class="compact-info">
          <div class="compact-title">${escapeHtml(item.title)}</div>
          <div class="compact-sub">${escapeHtml(item.channel)}</div>
        </div>
      </button>`
      )
      .join("");

    container.querySelectorAll(".compact-video-row").forEach((row, idx) => {
      const item = items[idx];
      row.addEventListener("mouseenter", () => scheduleHoverPrefetch(item.id));
      row.addEventListener("touchstart", () => PureAPI.prefetchVideo(item.id), { passive: true });
      row.addEventListener("click", () => openWatchVideo(item));
    });
  }

  function renderQueuePanel() {
    const panel = document.getElementById("queue-panel");
    if (!state.queue.length || state.queueIndex < 0) {
      panel.classList.add("hidden");
      return;
    }
    panel.classList.remove("hidden");
    document.getElementById("queue-title").textContent = state.queueName || "Danh sách phát";
    document.getElementById("queue-progress-text").textContent = `${state.queueIndex + 1} / ${state.queue.length}`;

    const list = document.getElementById("queue-list");
    list.innerHTML = state.queue
      .map(
        (item, idx) => `
      <button type="button" class="compact-video-row ${idx === state.queueIndex ? "active" : ""}" data-qidx="${idx}">
        <div class="compact-thumb-wrap">
          <img src="${escapeHtml(item.thumbnail)}" alt="" loading="lazy" />
        </div>
        <div class="compact-info">
          <div class="compact-title">${idx + 1}. ${escapeHtml(item.title)}</div>
          <div class="compact-sub">${escapeHtml(item.channel)}</div>
        </div>
      </button>`
      )
      .join("");

    list.querySelectorAll(".compact-video-row").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.qidx, 10);
        state.queueIndex = idx;
        openWatchVideo(state.queue[idx]);
      });
    });
  }

  function playNextVideo() {
    if (state.queue.length && state.queueIndex + 1 < state.queue.length) {
      state.queueIndex += 1;
      openWatchVideo(state.queue[state.queueIndex]);
      return;
    }
    const related = state.currentVideoFull?.related || [];
    if (related.length > 0) {
      openWatchVideo(related[0]);
    }
  }

  function playPrevVideo() {
    if (state.queue.length && state.queueIndex > 0) {
      state.queueIndex -= 1;
      openWatchVideo(state.queue[state.queueIndex]);
    } else {
      PurePlayer.seekTo(0);
    }
  }

  async function renderSubscriptionsView() {
    const pillsEl = document.getElementById("subs-channel-pills");
    const contentEl = document.getElementById("subs-content");
    const statusPill = document.getElementById("subs-sync-status");
    const logged = Boolean(state.authStatus?.logged_in);

    if (statusPill) {
      statusPill.classList.toggle("hidden", !logged);
      if (logged) statusPill.textContent = `Đồng bộ · ${state.authStatus.account_name || "YouTube"}`;
    }

    const subs = Store.state.subscriptions || [];
    if (!logged && !subs.length) {
      pillsEl.innerHTML = "";
      contentEl.innerHTML = `
        <div class="empty-state">
          <h2>Chưa có kênh đăng ký</h2>
          <p>Đăng nhập Tài khoản Google để tự động đồng bộ toàn bộ kênh bạn đang theo dõi từ YouTube, hoặc bấm "Đăng ký" khi xem bất kỳ video nào.</p>
          <button type="button" class="btn-primary" id="subs-open-auth-btn">Liên kết Google để đồng bộ</button>
        </div>`;
      document.getElementById("subs-open-auth-btn")?.addEventListener("click", openAuthDialog);
      return;
    }

    const defaultChannel = logged ? "__ALL_YT__" : (subs[0]?.name || "");
    if (
      !state.activeSubChannel ||
      (state.activeSubChannel === "__ALL_YT__" && !logged) ||
      (state.activeSubChannel !== "__ALL_YT__" && !subs.some((s) => s.name === state.activeSubChannel))
    ) {
      state.activeSubChannel = defaultChannel;
    }

    const pillButtons = [];
    if (logged) {
      pillButtons.push(
        `<button type="button" class="channel-pill ${state.activeSubChannel === "__ALL_YT__" ? "active" : ""}" data-ch="__ALL_YT__"><span>Tất cả kênh YouTube</span></button>`
      );
    }
    subs.forEach((s) => {
      pillButtons.push(
        `<button type="button" class="channel-pill ${s.name === state.activeSubChannel ? "active" : ""}" data-ch="${escapeHtml(s.name)}"><span>${escapeHtml(s.name)}</span></button>`
      );
    });
    pillsEl.innerHTML = pillButtons.join("");

    pillsEl.querySelectorAll(".channel-pill").forEach((pill) => {
      pill.addEventListener("click", () => {
        state.activeSubChannel = pill.dataset.ch;
        renderSubscriptionsView();
      });
    });

    const bannerHtml = !logged
      ? `<div class="sync-inline-banner"><span>Muốn tự đồng bộ các kênh đang theo dõi trên YouTube?</span><button type="button" class="btn-primary btn-sm" id="subs-inline-auth-btn">Liên kết Google</button></div>`
      : "";
    contentEl.innerHTML = `${bannerHtml}<div class="video-grid" id="subs-video-grid"></div>`;
    document.getElementById("subs-inline-auth-btn")?.addEventListener("click", openAuthDialog);
    const grid = document.getElementById("subs-video-grid");
    renderSkeletonGrid(grid, 8);

    try {
      if (state.activeSubChannel === "__ALL_YT__") {
        const data = await PureAPI.getYoutubeSubscriptions();
        renderVideoGrid(grid, data.items || []);
      } else {
        const data = await PureAPI.getChannel(state.activeSubChannel);
        renderVideoGrid(grid, data.items || []);
      }
    } catch (err) {
      grid.innerHTML = `<div class="empty-state" style="grid-column: 1 / -1;"><p>${escapeHtml(err.message)}</p></div>`;
    }
  }

  async function loadMoreShortsBatch(reset = false) {
    if (state.shortsLoadingMore) return 0;
    state.shortsLoadingMore = true;
    try {
      if (reset) {
        state.shortsSeed = (state.shortsSeed || 0) + 1;
      }
      const seenExclude = Array.from(
        new Set([...getSeenShortIds(), ...state.shortsItems.map((x) => x.id)])
      );
      let res = await PureAPI.getShorts(state.shortsTopic, seenExclude, ++state.shortsSeed);
      let fresh = res?.items || [];
      if (!fresh.length) {
        // If user watched everything in current cache window, clear old seen memory and fetch a clean batch
        localStorage.removeItem(SEEN_SHORTS_KEY);
        res = await PureAPI.getShorts(state.shortsTopic, state.shortsItems.map((x) => x.id), ++state.shortsSeed);
        fresh = res?.items || [];
      }
      const existing = new Set(state.shortsItems.map((x) => x.id));
      const uniqueNew = fresh.filter((it) => it?.id && !existing.has(it.id));
      state.shortsItems.push(...uniqueNew);
      return uniqueNew.length;
    } catch (_) {
      return 0;
    } finally {
      state.shortsLoadingMore = false;
    }
  }

  async function renderShortsView(forceFresh = false) {
    PurePlayer.pause();
    const sv = document.getElementById("shorts-video");
    if (!sv) return;
    document.querySelectorAll("#shorts-topic-strip .chip").forEach((c) => {
      c.classList.toggle("active", (c.dataset.shortsQ || "") === state.shortsTopic);
    });
    if (forceFresh) {
      stopShortsPlayback();
      state.shortsItems = [];
      state.shortsIndex = 0;
    }
    if (!state.shortsItems.length) {
      document.getElementById("shorts-title").textContent = "Đang tải loạt Shorts mới...";
      document.getElementById("shorts-spinner")?.classList.remove("hidden");
      await loadMoreShortsBatch(true);
      state.shortsIndex = 0;
    }
    if (!state.shortsItems.length) {
      document.getElementById("shorts-spinner")?.classList.add("hidden");
      document.getElementById("shorts-title").textContent = "Không tải được danh sách Shorts lúc này.";
      return;
    }
    await playShortAtIndex(state.shortsIndex);
  }

  async function playShortAtIndex(idx) {
    if (!state.shortsItems.length) return;
    if (idx < 0) {
      window.showAppToast("Đây là Short đầu tiên.");
      return;
    }
    if (idx >= state.shortsItems.length) {
      document.getElementById("shorts-spinner")?.classList.remove("hidden");
      const added = await loadMoreShortsBatch(false);
      if (idx >= state.shortsItems.length && !added) {
        idx = state.shortsItems.length - 1;
      }
    }
    const item = state.shortsItems[idx];
    if (!item) return;
    state.shortsIndex = idx;
    markShortSeen(item.id);
    if (state.shortsIndex >= state.shortsItems.length - 6) {
      loadMoreShortsBatch(false);
    }

    const sv = document.getElementById("shorts-video");
    const spinner = document.getElementById("shorts-spinner");
    const titleEl = document.getElementById("shorts-title");
    const chEl = document.getElementById("shorts-channel-btn");
    if (!sv) return;

    stopShortsPlayback();
    spinner?.classList.remove("hidden");
    titleEl.textContent = item.title || "YouTube Short";
    chEl.textContent = item.channel || "YouTube Shorts";
    document.getElementById("shorts-like-label").textContent = "Thích";
    document.getElementById("shorts-like-btn")?.classList.remove("active");

    const nextShort = state.shortsItems[idx + 1];
    if (nextShort?.id) PureAPI.prefetchVideo(nextShort.id);

    try {
      const full = await PureAPI.getVideo(item.id);
      if (state.activeTab !== "shorts" || state.shortsItems[state.shortsIndex]?.id !== item.id) return;
      state.shortsVideoData = full;
      titleEl.textContent = full.title || item.title;
      chEl.textContent = full.channel || item.channel || "YouTube Shorts";

      const qs = full.qualities || [];
      const comb = qs.find((q) => q.has_audio) || qs.find((q) => q.height <= 720) || qs[0];
      if (!comb?.stream_url) {
        spinner?.classList.add("hidden");
        return;
      }

      sv.src = PureAPI.resolveUrl(comb.stream_url);
      sv.muted = !comb.has_audio || state.shortsMuted;
      if (!comb.has_audio && full.audio_stream_url) {
        if (!state._shortsAudio) state._shortsAudio = new Audio();
        state._shortsAudio.src = PureAPI.resolveUrl(full.audio_stream_url);
        state._shortsAudio.muted = state.shortsMuted;
        state._shortsAudio.loop = false;
        state._shortsAudio.load();
      }
      sv.oncanplay = () => spinner?.classList.add("hidden");
      sv.onerror = () => spinner?.classList.add("hidden");
      sv.onended = () => playShortAtIndex(state.shortsIndex + 1);
      sv.onplay = () => {
        if (!comb.has_audio && state._shortsAudio?.src) {
          state._shortsAudio.currentTime = sv.currentTime;
          state._shortsAudio.play().catch(() => {});
        }
      };
      sv.onpause = () => state._shortsAudio?.pause();
      sv.load();
      sv.play().catch(() => {});
    } catch (_) {
      spinner?.classList.add("hidden");
    }
  }

  async function openChannelPage(channelRef, nameHint = "", tab = "videos") {
    if (!channelRef) return;
    state.channelPage = { ref: channelRef, name: nameHint || channelRef, tab, data: null };
    switchTab("channel");
    const hero = document.getElementById("channel-hero");
    const grid = document.getElementById("channel-grid");
    document.querySelectorAll("#channel-tabs-strip .chip").forEach((c) => {
      c.classList.toggle("active", c.dataset.chTab === tab);
    });
    hero.innerHTML = `<div class="skeleton-box skeleton-line" style="height:100px"></div>`;
    renderSkeletonGrid(grid, 8);

    try {
      const data = await PureAPI.getChannel(channelRef, tab);
      state.channelPage.data = data;
      state.channelPage.ref = data.channel_id || channelRef;
      state.channelPage.name = data.name || nameHint || channelRef;

      const isSub = Store.isSubscribed(state.channelPage.name);
      const initial = (state.channelPage.name || "C").trim().charAt(0).toUpperCase();
      hero.innerHTML = `
        ${data.banner ? `<img class="channel-banner-img" src="${escapeHtml(data.banner)}" alt="" />` : ""}
        <div class="channel-hero-body">
          ${
            data.avatar
              ? `<img class="channel-hero-avatar" src="${escapeHtml(data.avatar)}" alt="" />`
              : `<div class="channel-hero-avatar channel-hero-initial">${escapeHtml(initial)}</div>`
          }
          <div class="channel-hero-info">
            <h1 class="section-title" style="margin:0;">${escapeHtml(state.channelPage.name)}</h1>
            <div class="settings-desc">${escapeHtml(data.subscribers || "Kênh YouTube sạch quảng cáo")}</div>
          </div>
          <button type="button" class="btn-subscribe ${isSub ? "subscribed" : ""}" id="channel-page-sub-btn">${
            isSub ? "Đã đăng ký" : "Đăng ký"
          }</button>
        </div>
      `;

      document.getElementById("channel-page-sub-btn")?.addEventListener("click", async (e) => {
        const subBtn = e.currentTarget;
        const added = Store.toggleSubscription({ id: state.channelPage.ref, name: state.channelPage.name });
        subBtn.classList.toggle("subscribed", added);
        subBtn.textContent = added ? "Đã đăng ký" : "Đăng ký";
        if (state.authStatus?.logged_in && /^UC[A-Za-z0-9_-]{22}$/.test(state.channelPage.ref)) {
          try {
            await PureAPI.subscribeChannel(state.channelPage.ref, added);
          } catch (_) {}
        }
        window.showAppToast(added ? `Đã đăng ký kênh ${state.channelPage.name}` : "Đã hủy đăng ký kênh");
      });

      const items = data.items || [];
      if (tab === "playlists") {
        if (!items.length) {
          grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><p>Kênh này chưa có danh sách phát công khai.</p></div>`;
          return;
        }
        grid.innerHTML = items
          .map(
            (pl) => `
          <button type="button" class="video-card yt-pl-open-card" data-yt-pl="${escapeHtml(pl.id)}" data-yt-title="${escapeHtml(pl.title)}">
            <div class="thumb-wrap">
              ${
                pl.thumbnail
                  ? `<img class="thumb-img" src="${escapeHtml(pl.thumbnail)}" alt="" loading="lazy" />`
                  : `<div class="thumb-img" style="display:flex;align-items:center;justify-content:center;color:var(--text-secondary);">Playlist</div>`
              }
              ${pl.count_text ? `<span class="duration-badge">${escapeHtml(pl.count_text)}</span>` : ""}
            </div>
            <div class="card-meta">
              <div class="card-info">
                <h3 class="card-title">${escapeHtml(pl.title)}</h3>
                <div class="card-sub">Danh sách phát YouTube</div>
              </div>
            </div>
          </button>`
          )
          .join("");
        grid.querySelectorAll(".yt-pl-open-card").forEach((card) => {
          card.addEventListener("click", () => playYoutubePlaylist(card.dataset.ytPl, card.dataset.ytTitle));
        });
      } else {
        renderVideoGrid(grid, items);
      }
    } catch (err) {
      hero.innerHTML = "";
      grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><h2>Không tải được kênh</h2><p>${escapeHtml(err.message)}</p></div>`;
    }
  }

  async function playYoutubePlaylist(playlistId, title = "Playlist YouTube") {
    window.showAppToast(`Đang nạp "${title}"...`);
    try {
      const data = await PureAPI.getYoutubePlaylistItems(playlistId);
      const items = data.items || [];
      if (!items.length) {
        window.showAppToast("Danh sách phát này hiện đang trống.");
        return;
      }
      state.queue = items;
      state.queueIndex = 0;
      state.queueName = title;
      openWatchVideo(items[0]);
    } catch (err) {
      window.showAppToast(err.message || "Không tải được danh sách phát.");
    }
  }

  async function renderPlaylistsView() {
    const container = document.getElementById("playlists-content");
    const statusPill = document.getElementById("playlists-sync-status");
    const logged = Boolean(state.authStatus?.logged_in);

    if (statusPill) {
      statusPill.classList.toggle("hidden", !logged);
      if (logged) statusPill.textContent = `Đồng bộ · ${state.authStatus.account_name || "YouTube"}`;
    }

    let ytPlaylists = [];
    let ytError = "";
    if (logged) {
      container.innerHTML = `<div class="skeleton-box skeleton-line" style="height:100px"></div>`;
      try {
        const res = await PureAPI.getYoutubePlaylists();
        ytPlaylists = res.playlists || [];
      } catch (err) {
        ytError = err.message || "Không tải được playlist từ YouTube.";
      }
    }

    const localPlaylists = (Store.state.playlists || []).filter((pl) => {
      if (!logged) return true;
      const lower = String(pl.name || "").trim().toLowerCase();
      if ((lower === "xem sau" || lower === "video đã thích") && (!pl.items || !pl.items.length)) {
        return false;
      }
      return true;
    });

    if (!ytPlaylists.length && !localPlaylists.length) {
      container.innerHTML = `
        <div class="empty-state">
          <h2>Chưa có danh sách phát nào</h2>
          <p>${ytError ? escapeHtml(ytError) : "Liên kết Google để đồng bộ Xem sau & Video đã thích từ YouTube, hoặc tạo playlist mới trên máy."}</p>
          ${!logged ? `<button type="button" class="btn-primary" id="pl-open-auth-btn">Liên kết Google ngay</button>` : ""}
        </div>`;
      document.getElementById("pl-open-auth-btn")?.addEventListener("click", openAuthDialog);
      return;
    }

    const bannerHtml = !logged
      ? `<div class="sync-inline-banner"><span>Liên kết Tài khoản Google để đồng bộ trực tiếp <strong>Xem sau</strong>, <strong>Video đã thích</strong> & playlist YouTube vào chung màn hình này.</span><button type="button" class="btn-primary btn-sm" id="pl-open-auth-btn">Liên kết Google</button></div>`
      : ytError
        ? `<div class="sync-inline-banner"><span>Không đồng bộ được playlist YouTube lúc này: ${escapeHtml(ytError)}</span></div>`
        : "";

    const renderYtPreviewHtml = (pid) => {
      if (!state.expandedYtPlaylists[pid]) {
        return `<p class="settings-desc" style="margin:4px 0 0;">Bấm "Xem video" để mở danh sách video đã đồng bộ.</p>`;
      }
      const cached = state.ytPlaylistItemsMap[pid];
      if (!cached) {
        return `<div class="skeleton-box skeleton-line" style="height:46px;"></div>`;
      }
      if (!cached.length) {
        return `<p class="settings-desc" style="margin:4px 0 0;">Danh sách này hiện đang trống.</p>`;
      }
      return cached
        .map(
          (v, idx) => `
          <div class="playlist-item-row">
            <img src="${escapeHtml(v.thumbnail)}" alt="" loading="lazy" />
            <button type="button" class="playlist-item-title yt-pl-item-play" data-yt-pl="${escapeHtml(pid)}" data-idx="${idx}" style="text-align:left;">
              ${escapeHtml(v.title)}
            </button>
            ${
              pid !== "LL"
                ? `<button type="button" class="icon-btn yt-pl-item-remove" data-yt-pl="${escapeHtml(pid)}" data-vid="${escapeHtml(v.id)}" aria-label="Xóa khỏi playlist YouTube">
                    <svg class="icon" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>
                  </button>`
                : ""
            }
          </div>`
        )
        .join("");
    };

    const ytCardsHtml = ytPlaylists
      .map(
        (pl) => `
        <article class="playlist-card" data-yt-pl-card="${escapeHtml(pl.id)}">
          <div class="playlist-card-head">
            <div>
              <h2 class="playlist-card-title">${escapeHtml(pl.title)} <span class="playlist-source-badge">YouTube</span></h2>
              <div class="playlist-card-count" id="yt-pl-count-${escapeHtml(pl.id)}">${
                state.ytPlaylistItemsMap[pl.id]
                  ? `${state.ytPlaylistItemsMap[pl.id].length} video`
                  : escapeHtml(pl.count_text || pl.privacy || "Đồng bộ YouTube")
              }</div>
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;">
              <button type="button" class="btn-subtle btn-sm yt-pl-toggle-btn" data-yt-pl="${escapeHtml(pl.id)}">${
                state.expandedYtPlaylists[pl.id] ? "Thu gọn" : "Xem video"
              }</button>
              <button type="button" class="btn-primary btn-sm yt-pl-play-btn" data-yt-pl="${escapeHtml(pl.id)}" data-yt-title="${escapeHtml(pl.title)}">Phát tất cả</button>
            </div>
          </div>
          <div class="playlist-items-preview" id="yt-pl-preview-${escapeHtml(pl.id)}">
            ${renderYtPreviewHtml(pl.id)}
          </div>
        </article>`
      )
      .join("");

    const localCardsHtml = localPlaylists
      .map(
        (pl) => `
        <article class="playlist-card" data-pl-id="${escapeHtml(pl.id)}">
          <div class="playlist-card-head">
            <div>
              <h2 class="playlist-card-title">${escapeHtml(pl.name)} <span class="playlist-source-badge local">Trên máy</span></h2>
              <div class="playlist-card-count">${pl.items.length} video</div>
            </div>
            <div style="display:flex;gap:6px;">
              ${
                pl.items.length > 0
                  ? `<button type="button" class="btn-primary btn-sm pl-play-all" data-pl-id="${escapeHtml(pl.id)}">Phát tất cả</button>`
                  : ""
              }
              <button type="button" class="btn-subtle btn-sm danger-text pl-delete" data-pl-id="${escapeHtml(pl.id)}" title="Xóa danh sách">Xóa</button>
            </div>
          </div>
          <div class="playlist-items-preview">
            ${
              pl.items.length
                ? pl.items
                    .map(
                      (v) => `
                  <div class="playlist-item-row">
                    <img src="${escapeHtml(v.thumbnail)}" alt="" />
                    <button type="button" class="playlist-item-title pl-item-play" data-pl-id="${escapeHtml(pl.id)}" data-vid="${escapeHtml(v.id)}" style="text-align:left;">
                      ${escapeHtml(v.title)}
                    </button>
                    <button type="button" class="icon-btn pl-item-remove" data-pl-id="${escapeHtml(pl.id)}" data-vid="${escapeHtml(v.id)}" aria-label="Xóa khỏi playlist">
                      <svg class="icon" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>
                    </button>
                  </div>`
                    )
                    .join("")
                : `<p class="settings-desc">Danh sách trống. Mở bất kỳ video nào và nhấn "Lưu Playlist".</p>`
            }
          </div>
        </article>`
      )
      .join("");

    container.innerHTML = `${bannerHtml}<div class="playlist-grid">${ytCardsHtml}${localCardsHtml}</div>`;
    document.getElementById("pl-open-auth-btn")?.addEventListener("click", openAuthDialog);

    const bindYtPreviewEvents = (previewBox) => {
      if (!previewBox) return;
      previewBox.querySelectorAll(".yt-pl-item-play").forEach((btn) => {
        btn.addEventListener("click", () => {
          const pid = btn.dataset.ytPl;
          const idx = parseInt(btn.dataset.idx, 10) || 0;
          const items = state.ytPlaylistItemsMap[pid] || [];
          const plMeta = ytPlaylists.find((x) => x.id === pid);
          if (items.length && items[idx]) {
            state.queue = [...items];
            state.queueIndex = idx;
            state.queueName = plMeta?.title || "YouTube Playlist";
            openWatchVideo(items[idx]);
          }
        });
      });
      previewBox.querySelectorAll(".yt-pl-item-remove").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const pid = btn.dataset.ytPl;
          const vid = btn.dataset.vid;
          btn.disabled = true;
          try {
            await PureAPI.addVideoToYoutubePlaylist(pid, vid, true);
            state.ytPlaylistItemsMap[pid] = (state.ytPlaylistItemsMap[pid] || []).filter((x) => x.id !== vid);
            previewBox.innerHTML = renderYtPreviewHtml(pid);
            bindYtPreviewEvents(previewBox);
            const cntEl = document.getElementById(`yt-pl-count-${pid}`);
            if (cntEl) cntEl.textContent = `${state.ytPlaylistItemsMap[pid].length} video`;
            window.showAppToast("Đã gỡ video khỏi danh sách phát YouTube.");
          } catch (err) {
            btn.disabled = false;
            window.showAppToast(err.message);
          }
        });
      });
    };

    const hydrateYtPlaylist = async (pl) => {
      const previewBox = document.getElementById(`yt-pl-preview-${pl.id}`);
      const cntEl = document.getElementById(`yt-pl-count-${pl.id}`);
      if (!previewBox || !state.expandedYtPlaylists[pl.id]) return;
      if (!state.ytPlaylistItemsMap[pl.id]) {
        try {
          const d = await PureAPI.getYoutubePlaylistItems(pl.id);
          state.ytPlaylistItemsMap[pl.id] = d.items || [];
        } catch (err) {
          if (state.activeTab === "playlists") {
            previewBox.innerHTML = `<p class="settings-desc">${escapeHtml(err.message)}</p>`;
          }
          return;
        }
      }
      if (state.activeTab !== "playlists") return;
      previewBox.innerHTML = renderYtPreviewHtml(pl.id);
      if (cntEl) cntEl.textContent = `${state.ytPlaylistItemsMap[pl.id].length} video`;
      bindYtPreviewEvents(previewBox);
    };

    ytPlaylists.forEach((pl) => {
      const box = document.getElementById(`yt-pl-preview-${pl.id}`);
      if (state.ytPlaylistItemsMap[pl.id]) bindYtPreviewEvents(box);
      if (state.expandedYtPlaylists[pl.id] && !state.ytPlaylistItemsMap[pl.id]) {
        hydrateYtPlaylist(pl);
      }
    });

    container.querySelectorAll(".yt-pl-toggle-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const pid = btn.dataset.ytPl;
        const nextOpen = !state.expandedYtPlaylists[pid];
        state.expandedYtPlaylists[pid] = nextOpen;
        btn.textContent = nextOpen ? "Thu gọn" : "Xem video";
        const box = document.getElementById(`yt-pl-preview-${pid}`);
        if (box) {
          box.innerHTML = renderYtPreviewHtml(pid);
          if (nextOpen && !state.ytPlaylistItemsMap[pid]) {
            const pl = ytPlaylists.find((x) => x.id === pid);
            if (pl) hydrateYtPlaylist(pl);
          } else {
            bindYtPreviewEvents(box);
          }
        }
      });
    });

    container.querySelectorAll(".yt-pl-play-btn").forEach((btn) => {
      btn.addEventListener("click", () => playYoutubePlaylist(btn.dataset.ytPl, btn.dataset.ytTitle));
    });

    container.querySelectorAll(".pl-play-all").forEach((btn) => {
      btn.addEventListener("click", () => {
        const pl = Store.state.playlists.find((p) => p.id === btn.dataset.plId);
        if (pl && pl.items.length) {
          state.queue = [...pl.items];
          state.queueIndex = 0;
          state.queueName = pl.name;
          openWatchVideo(state.queue[0]);
        }
      });
    });

    container.querySelectorAll(".pl-item-play").forEach((btn) => {
      btn.addEventListener("click", () => {
        const pl = Store.state.playlists.find((p) => p.id === btn.dataset.plId);
        if (!pl) return;
        const idx = pl.items.findIndex((i) => i.id === btn.dataset.vid);
        if (idx >= 0) {
          state.queue = [...pl.items];
          state.queueIndex = idx;
          state.queueName = pl.name;
          openWatchVideo(state.queue[idx]);
        }
      });
    });

    container.querySelectorAll(".pl-item-remove").forEach((btn) => {
      btn.addEventListener("click", () => {
        Store.removeVideoFromPlaylist(btn.dataset.plId, btn.dataset.vid);
        renderPlaylistsView();
      });
    });

    container.querySelectorAll(".pl-delete").forEach((btn) => {
      btn.addEventListener("click", () => {
        Store.deletePlaylist(btn.dataset.plId);
        renderPlaylistsView();
      });
    });
  }

  async function renderHistoryView() {
    const container = document.getElementById("history-content");
    const clearBtn = document.getElementById("clear-history-btn");
    const statusPill = document.getElementById("history-sync-status");
    const logged = Boolean(state.authStatus?.logged_in);
    const localItems = Store.state.history || [];

    if (statusPill) {
      statusPill.classList.toggle("hidden", !logged);
      if (logged) statusPill.textContent = `Đồng bộ · ${state.authStatus.account_name || "YouTube"}`;
    }
    clearBtn.classList.toggle("hidden", !localItems.length);
    clearBtn.textContent = logged ? "Xóa lịch sử cục bộ" : "Xóa lịch sử";

    if (logged) {
      container.innerHTML = `<div class="video-grid" id="history-grid"></div>`;
      const grid = document.getElementById("history-grid");
      renderSkeletonGrid(grid, 8);
      try {
        const data = await PureAPI.getYoutubeHistory();
        const ytItems = data.items || [];
        const merged = [];
        const seen = new Set();
        for (const item of [...localItems, ...ytItems]) {
          if (item?.id && !seen.has(item.id)) {
            seen.add(item.id);
            merged.push(item);
          }
        }
        renderVideoGrid(grid, merged);
      } catch (err) {
        if (localItems.length) {
          renderVideoGrid(grid, localItems);
        } else {
          grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><h2>Không đồng bộ được lịch sử</h2><p>${escapeHtml(err.message)}</p></div>`;
        }
      }
      return;
    }

    if (!localItems.length) {
      container.innerHTML = `
        <div class="empty-state">
          <h2>Lịch sử xem đang trống</h2>
          <p>Video bạn xem trên PureTube sẽ hiển thị tại đây. Liên kết Google để đồng bộ trực tiếp lịch sử YouTube từ điện thoại & máy tính.</p>
          <button type="button" class="btn-primary" id="history-open-auth-btn">Liên kết Google để đồng bộ</button>
        </div>`;
      document.getElementById("history-open-auth-btn")?.addEventListener("click", openAuthDialog);
      return;
    }

    container.innerHTML = `
      <div class="sync-inline-banner">
        <span>Liên kết Google để gộp chung lịch sử xem từ tài khoản YouTube của bạn vào đây.</span>
        <button type="button" class="btn-primary btn-sm" id="history-open-auth-btn">Liên kết Google</button>
      </div>
      <div class="video-grid" id="history-grid"></div>`;
    document.getElementById("history-open-auth-btn")?.addEventListener("click", openAuthDialog);
    renderVideoGrid(document.getElementById("history-grid"), localItems);
  }

  function renderSettingsView() {
    const container = document.getElementById("settings-content");
    const s = Store.state.settings;
    const lanUrl = state.serverInfo?.lan_url || window.location.origin;

    container.innerHTML = `
      <div class="settings-group">
        <h2>Lồng tiếng Tiếng Việt & Trình phát</h2>
        <div class="toggle-row">
          <span>Chế độ Lồng tiếng mặc định</span>
          <select id="set-dub-mode" style="background:var(--bg-elevated);color:var(--text-primary);border:1px solid var(--border-strong);border-radius:8px;padding:6px 10px;">
            <option value="auto-vi" ${s.dubbingMode === "auto-vi" ? "selected" : ""}>Tự động Tiếng Việt</option>
            <option value="ai-female" ${s.dubbingMode === "ai-female" ? "selected" : ""}>AI Nữ (Hoài My)</option>
            <option value="ai-male" ${s.dubbingMode === "ai-male" ? "selected" : ""}>AI Nam (Nam Minh)</option>
            <option value="sub-only" ${s.dubbingMode === "sub-only" ? "selected" : ""}>Chỉ hiện Phụ đề Tiếng Việt</option>
            <option value="off" ${s.dubbingMode === "off" ? "selected" : ""}>Tắt lồng tiếng</option>
          </select>
        </div>
        <label class="toggle-row">
          <span class="toggle-label-group">Mặc định mở ở chế độ Chỉ Âm Thanh</span>
          <span class="switch">
            <input type="checkbox" id="set-audio-default" ${s.audioOnlyDefault ? "checked" : ""} />
            <span class="slider"></span>
          </span>
        </label>
        <label class="toggle-row">
          <span class="toggle-label-group">Tự động chuyển sang video tiếp theo</span>
          <span class="switch">
            <input type="checkbox" id="set-auto-next" ${s.autoPlayNext ? "checked" : ""} />
            <span class="slider"></span>
          </span>
        </label>
        <div class="toggle-row">
          <span>Độ phân giải ưu tiên</span>
          <select id="set-pref-quality" style="background:var(--bg-elevated);color:var(--text-primary);border:1px solid var(--border-strong);border-radius:8px;padding:6px 10px;">
            <option value="2160" ${s.preferredQuality === 2160 ? "selected" : ""}>2160p (4K)</option>
            <option value="1080" ${s.preferredQuality === 1080 ? "selected" : ""}>1080p FHD</option>
            <option value="720" ${s.preferredQuality === 720 ? "selected" : ""}>720p HD (Nhanh & Tối ưu iOS)</option>
            <option value="360" ${s.preferredQuality === 360 ? "selected" : ""}>360p (Tiết kiệm mạng)</option>
          </select>
        </div>
      </div>

      <div class="settings-group">
        <h2>SponsorBlock — Tự động bỏ qua trong video</h2>
        <p class="settings-desc">Bỏ qua các đoạn quảng cáo do chính YouTuber chèn vào nội dung video.</p>
        <label class="toggle-row">
          <span class="toggle-label-group"><strong>Bật tự động bỏ qua SponsorBlock</strong></span>
          <span class="switch">
            <input type="checkbox" id="set-sb-master" ${s.autoSkipSponsorBlock ? "checked" : ""} />
            <span class="slider"></span>
          </span>
        </label>
        ${Object.entries(SPONSOR_LABELS)
          .map(
            ([key, info]) => `
          <label class="toggle-row">
            <span class="toggle-label-group">
              <span class="legend-dot" style="background:${info.color}"></span>
              <span>${info.label}</span>
            </span>
            <span class="switch">
              <input type="checkbox" class="set-sb-cat" data-cat="${key}" ${s.sponsorCategories[key] ? "checked" : ""} />
              <span class="slider"></span>
            </span>
          </label>`
          )
          .join("")}
      </div>

      <div class="settings-group">
        <h2>Chế độ Độc lập 4G/5G (Không cần bật PC)</h2>
        <div class="standalone-mode-pill" id="settings-mode-pill">${
          PureAPI.getConnectionMode() === "standalone"
            ? "Đang chạy: App Độc lập 100% (Chạy 4G/5G trực tiếp trên máy)"
            : PureAPI.getConnectionMode() === "cloud"
              ? `Đang chạy: Máy chủ Cloud 24/7 (${escapeHtml(PureAPI.getCloudBaseUrl())})`
              : state.serverInfo?.server_mode === "cloud"
                ? `Đang chạy: Cloud 24/7 (${escapeHtml(state.serverInfo.lan_url)})`
                : "Đang chạy: Máy chủ PC tại nhà (Wi-Fi LAN)"
        }</div>
        <p class="settings-desc">Để xem mọi nơi qua 4G/5G khi đã tắt PC: cài App gốc từ mục <code>mobile/</code> (Android APK / iOS IPA) <strong>hoặc</strong> triển khai 1 chạm PureTube lên Cloud miễn phí (Render / HuggingFace Spaces) rồi dán link <code>https://...</code> vào ô dưới:</p>
        <div class="cloud-url-row">
          <input type="url" id="set-cloud-url-input" placeholder="https://puretube-cua-ban.onrender.com (để trống = mặc định)" value="${escapeHtml(s.cloudServerUrl || "")}" />
          <button type="button" class="btn-primary btn-sm" id="btn-save-cloud-url">Kết nối</button>
          ${s.cloudServerUrl ? `<button type="button" class="btn-subtle btn-sm" id="btn-reset-cloud-url">Gỡ</button>` : ""}
        </div>
      </div>

      <div class="settings-group">
        <h2>Tài khoản Google & Mở trên iPhone / Android</h2>
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
          <span class="settings-desc">${
            state.authStatus?.logged_in
              ? `Đang đăng nhập: <strong>${escapeHtml(state.authStatus.account_name)}</strong>`
              : "Chưa liên kết tài khoản Google"
          }</span>
          <button type="button" class="btn-primary btn-sm" id="settings-open-auth-btn">${
            state.authStatus?.logged_in ? "Quản lý" : "Đăng nhập"
          }</button>
        </div>
        ${
          PureAPI.isNativeStandalone()
            ? `<p class="settings-desc">Bạn đang dùng phiên bản <strong>PureTube App Độc lập</strong> — toàn bộ tìm kiếm, bỏ quảng cáo, SponsorBlock, đồng bộ Google & lồng tiếng Tiếng Việt đang chạy trực tiếp bằng mạng 4G/5G của điện thoại!</p>`
            : `
        <div class="qr-card">
          <div class="qr-frame">
            <img src="${PureAPI.getQrUrl(lanUrl)}" alt="Mã QR truy cập PureTube trên điện thoại" />
          </div>
          <div class="lan-url-row">
            <code>${escapeHtml(lanUrl)}</code>
            <button type="button" class="btn-subtle btn-sm" id="copy-lan-url-settings">Sao chép</button>
          </div>
          <button type="button" class="btn-subtle btn-sm" id="settings-open-mobile-hub-btn">Tải file APK / IPA & Hướng dẫn cài 4G/5G</button>
        </div>`
        }
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          <button type="button" class="btn-subtle" id="btn-export-data">Xuất tệp JSON</button>
          <label class="btn-subtle" style="cursor:pointer;">
            <span>Nhập tệp JSON</span>
            <input type="file" id="input-import-data" accept=".json,application/json" class="hidden" />
          </label>
        </div>
      </div>
    `;

    document.getElementById("set-dub-mode").addEventListener("change", (e) => {
      Store.updateSetting("dubbingMode", e.target.value);
      PurePlayer.setDubbingMode(e.target.value);
    });
    document.getElementById("set-sb-master").addEventListener("change", (e) => {
      Store.updateSetting("autoSkipSponsorBlock", e.target.checked);
    });
    container.querySelectorAll(".set-sb-cat").forEach((cb) => {
      cb.addEventListener("change", (e) => {
        Store.updateSponsorCategory(e.target.dataset.cat, e.target.checked);
      });
    });
    document.getElementById("set-audio-default").addEventListener("change", (e) => {
      Store.updateSetting("audioOnlyDefault", e.target.checked);
    });
    document.getElementById("set-auto-next").addEventListener("change", (e) => {
      Store.updateSetting("autoPlayNext", e.target.checked);
    });
    document.getElementById("set-pref-quality").addEventListener("change", (e) => {
      Store.updateSetting("preferredQuality", parseInt(e.target.value, 10));
    });
    document.getElementById("settings-open-auth-btn").addEventListener("click", openAuthDialog);
    document.getElementById("settings-open-mobile-hub-btn")?.addEventListener("click", openQrDialog);
    document.getElementById("btn-save-cloud-url")?.addEventListener("click", async () => {
      const input = document.getElementById("set-cloud-url-input");
      const val = (input?.value || "").trim().replace(/\/+$/, "");
      if (!val) {
        Store.updateSetting("cloudServerUrl", "");
        window.showAppToast("Đã chuyển về máy chủ mặc định.");
        renderSettingsView();
        return;
      }
      const btn = document.getElementById("btn-save-cloud-url");
      btn.disabled = true;
      btn.textContent = "Đang thử...";
      try {
        await PureAPI.testServerUrl(val);
        Store.updateSetting("cloudServerUrl", val);
        await refreshAuthStatus();
        state.serverInfo = await PureAPI.getInfo();
        window.showAppToast("Đã kết nối Cloud 24/7 thành công!");
        renderSettingsView();
      } catch (err) {
        window.showAppToast(err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = "Kết nối";
      }
    });
    document.getElementById("btn-reset-cloud-url")?.addEventListener("click", async () => {
      Store.updateSetting("cloudServerUrl", "");
      window.showAppToast("Đã gỡ địa chỉ Cloud từ xa.");
      await refreshAuthStatus();
      renderSettingsView();
    });
    document.getElementById("copy-lan-url-settings")?.addEventListener("click", () => {
      navigator.clipboard?.writeText(lanUrl);
      window.showAppToast("Đã sao chép địa chỉ truy cập cho điện thoại.");
    });
    document.getElementById("btn-export-data").addEventListener("click", () => {
      const blob = new Blob([Store.exportBackup()], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `puretube-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });
    document.getElementById("input-import-data").addEventListener("change", (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          Store.importBackup(reader.result);
          window.showAppToast("Đã khôi phục dữ liệu thành công.");
          renderSettingsView();
        } catch (err) {
          window.showAppToast(err.message);
        }
      };
      reader.readAsText(file);
    });
  }

  function openAuthDialog() {
    const dialog = document.getElementById("auth-dialog");
    const body = document.getElementById("auth-dialog-body");
    let pollTimer = null;
    let pollInFlight = false;
    let currentUserCode = "";
    let currentVerifyUrl = "https://www.google.com/device";

    const stopPolling = () => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      pollInFlight = false;
    };

    const copyTextSafely = async (text) => {
      if (!text) return false;
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch (_) {}
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        return ok;
      } catch (_) {
        return false;
      }
    };

    const setInlineStatus = (type, message, actionLabel = "", onAction = null) => {
      const box = document.getElementById("auth-inline-status");
      if (!box) return;
      if (!message) {
        box.className = "auth-inline-status hidden";
        box.innerHTML = "";
        return;
      }
      box.className = `auth-inline-status is-${type}`;
      box.innerHTML = `
        <span class="auth-inline-dot" aria-hidden="true"></span>
        <div style="display:flex;flex-direction:column;gap:8px;align-items:flex-start;flex:1;">
          <span>${escapeHtml(message)}</span>
          ${
            actionLabel
              ? `<button type="button" class="btn-primary btn-sm" id="auth-inline-action-btn">${escapeHtml(actionLabel)}</button>`
              : ""
          }
        </div>
      `;
      if (actionLabel && typeof onAction === "function") {
        document.getElementById("auth-inline-action-btn")?.addEventListener("click", onAction);
      }
      box.scrollIntoView({ block: "nearest", behavior: "smooth" });
    };

    const completeSuccess = async (noticeMsg) => {
      stopPolling();
      state.ytPlaylistItemsMap = {};
      await refreshAuthStatus();
      if (state.activeTab === "home" && !state.searchQuery) {
        loadTrending(state.category);
      } else if (state.activeTab === "history") {
        renderHistoryView();
      } else if (state.activeTab === "playlists") {
        renderPlaylistsView();
      } else if (state.activeTab === "subscriptions") {
        renderSubscriptionsView();
      }
      window.showAppToast(noticeMsg);
      renderBody({ type: "success", text: noticeMsg });
    };

    const startPolling = () => {
      stopPolling();
      pollTimer = setInterval(async () => {
        if (!dialog.open) {
          stopPolling();
          return;
        }
        if (pollInFlight) return;
        pollInFlight = true;
        try {
          const res = await PureAPI.pollGoogleLogin();
          if (res.status === "completed" && res.logged_in) {
            await completeSuccess(`Đã kết nối thành công: ${res.account_name}. Hiện bạn có thể xem Lịch sử & Kênh YouTube!`);
          } else if (res.status === "expired") {
            stopPolling();
            setInlineStatus(
              "error",
              res.message || "Mã kết nối đã hết hạn. Hãy bấm 'Lấy mã mới' để thử lại.",
              "Lấy mã kết nối mới",
              () => loadDeviceCode(true)
            );
          }
        } catch (_) {
          // Keep polling quietly while waiting for user approval
        } finally {
          pollInFlight = false;
        }
      }, 3000);
    };

    const loadDeviceCode = async (showSpinner = false) => {
      const codeEl = document.getElementById("auth-device-code-value");
      const linkEl = document.getElementById("auth-open-google-device-btn");
      if (codeEl) codeEl.textContent = "Đang tạo...";
      if (showSpinner) {
        setInlineStatus("loading", "Đang tạo mã kết nối Google mới...");
      }
      try {
        const res = await PureAPI.launchGoogleLogin();
        currentUserCode = res.user_code || "";
        currentVerifyUrl = res.verification_url || "https://www.google.com/device";
        if (codeEl) codeEl.textContent = currentUserCode || "Lỗi";
        if (linkEl) linkEl.href = currentVerifyUrl;
        if (showSpinner) {
          setInlineStatus(
            "info",
            `Đã tạo mã ${currentUserCode}. Bấm 'Sao chép mã & Mở trang Google', dán mã rồi bấm Cho phép.`
          );
        }
        startPolling();
      } catch (err) {
        if (codeEl) codeEl.textContent = "Thử lại";
        setInlineStatus("error", err.message);
      }
    };

    const renderBody = (initialStatus = null) => {
      const logged = Boolean(state.authStatus?.logged_in);
      body.innerHTML = `
        <div id="auth-inline-status" class="auth-inline-status hidden" role="status" aria-live="polite"></div>

        ${
          logged
            ? `
          <div class="auth-status-banner">
            <div>
              <strong style="color:var(--shield);">Đã kết nối tài khoản Google</strong>
              <div class="settings-desc">${escapeHtml(state.authStatus.account_name)} · Đồng bộ lịch sử xem YouTube 2 chiều</div>
            </div>
            <button type="button" class="btn-subtle danger-text" id="auth-logout-btn">Đăng xuất</button>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button type="button" class="btn-primary btn-sm" id="auth-goto-history-btn">Xem Lịch sử YouTube ngay</button>
            <button type="button" class="btn-subtle btn-sm" id="auth-goto-subs-btn">Xem Kênh đã đăng ký</button>
          </div>
          `
            : `<p class="settings-desc">Liên kết tài khoản Google giúp PureTube đọc lịch sử xem & kênh đăng ký từ YouTube của bạn, đồng thời tự động lưu các video bạn xem trên PureTube ngược lại lịch sử YouTube.</p>`
        }

        <div class="auth-method-box">
          <h3>Cách 1: Kết nối Google chính thức bằng Mã thiết bị (Khuyên dùng)</h3>
          <p class="settings-desc">Bấm <strong>Sao chép mã & Mở trang Google</strong>, dán mã (<code>Ctrl + V</code>) vào tab Google vừa mở và bấm <strong>Cho phép</strong>. PureTube sẽ tự động đồng bộ ngay trên máy tính, iPhone & Android.</p>
          <div class="device-code-card">
            <div class="device-code-row">
              <div>
                <div class="settings-desc" style="margin-bottom:4px;">Mã kết nối Google của bạn:</div>
                <div class="device-code-value" id="auth-device-code-value">${escapeHtml(currentUserCode || "Đang tạo...")}</div>
              </div>
              <button type="button" class="btn-subtle btn-sm" id="auth-refresh-code-btn">Lấy mã mới</button>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
              <a href="${escapeHtml(currentVerifyUrl)}" target="_blank" rel="noopener noreferrer" class="btn-primary btn-sm" id="auth-open-google-device-btn" style="text-decoration:none;display:inline-flex;align-items:center;">Sao chép mã & Mở trang Google</a>
              <button type="button" class="btn-subtle btn-sm" id="auth-complete-btn">Kiểm tra ngay</button>
            </div>
          </div>
        </div>

        ${
          PureAPI.isNativeStandalone()
            ? ""
            : `
        <div class="auth-method-box">
          <h3>Cách 2: Lấy nhanh từ trình duyệt đang cài</h3>
          <p class="settings-desc">Lưu ý: Chrome & Edge trên Windows 11 khóa bảo mật tệp Cookie khi đang chạy — hãy ưu tiên <strong>Cách 1 (Mã thiết bị)</strong> ở trên (hoạt động 100% không cần đóng trình duyệt):</p>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button type="button" class="btn-subtle btn-sm auth-browser-btn" data-br="firefox">Firefox</button>
            <button type="button" class="btn-subtle btn-sm auth-browser-btn" data-br="auto">Tự động dò</button>
            <button type="button" class="btn-subtle btn-sm auth-browser-btn" data-br="edge">Edge</button>
            <button type="button" class="btn-subtle btn-sm auth-browser-btn" data-br="chrome">Chrome</button>
          </div>
        </div>

        <div class="auth-method-box">
          <h3>Cách 3: Dán Cookie YouTube thủ công</h3>
          <textarea id="auth-cookie-input" class="cookie-textarea" placeholder="Dán nội dung cookies.txt hoặc JSON cookie từ YouTube..."></textarea>
          <button type="button" class="btn-subtle btn-sm" id="auth-save-cookie-btn" style="align-self:flex-start;">Lưu Cookie & Đồng bộ</button>
        </div>`
        }
      `;

      if (initialStatus?.text) {
        setInlineStatus(initialStatus.type || "info", initialStatus.text);
      }

      document.getElementById("auth-logout-btn")?.addEventListener("click", async () => {
        stopPolling();
        setInlineStatus("loading", "Đang đăng xuất tài khoản Google...");
        await PureAPI.logoutGoogle();
        currentUserCode = "";
        await refreshAuthStatus();
        window.showAppToast("Đã đăng xuất khỏi tài khoản Google.");
        renderBody({ type: "info", text: "Đã đăng xuất khỏi tài khoản Google." });
        loadDeviceCode(false);
      });

      document.getElementById("auth-goto-history-btn")?.addEventListener("click", () => {
        dialog.close();
        switchTab("history");
      });

      document.getElementById("auth-goto-subs-btn")?.addEventListener("click", () => {
        dialog.close();
        switchTab("subscriptions");
      });

      document.getElementById("auth-refresh-code-btn")?.addEventListener("click", () => {
        loadDeviceCode(true);
      });

      document.getElementById("auth-open-google-device-btn")?.addEventListener("click", async (e) => {
        if (!currentUserCode) {
          e.preventDefault();
          await loadDeviceCode(true);
          return;
        }
        const copied = await copyTextSafely(currentUserCode);
        setInlineStatus(
          "loading",
          copied
            ? `Đã sao chép mã ${currentUserCode}! Hãy dán vào trang Google vừa mở (Ctrl+V) và bấm Cho phép — PureTube đang tự động chờ đồng bộ...`
            : `Hãy nhập mã ${currentUserCode} vào trang Google vừa mở và bấm Cho phép — PureTube đang tự động chờ đồng bộ...`
        );
        startPolling();
      });

      document.getElementById("auth-complete-btn")?.addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        const origText = btn.textContent;
        btn.disabled = true;
        btn.textContent = "Đang kiểm tra...";
        setInlineStatus("loading", "Đang kiểm tra xác nhận từ Google...");
        try {
          const res = await PureAPI.completeGoogleLogin();
          await completeSuccess(`Đã kết nối thành công: ${res.account_name}`);
        } catch (err) {
          setInlineStatus("error", err.message);
        } finally {
          btn.disabled = false;
          btn.textContent = origText;
        }
      });

      body.querySelectorAll(".auth-browser-btn").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const targetLabel = btn.textContent;
          btn.disabled = true;
          setInlineStatus("loading", `Đang dò cookie YouTube từ trình duyệt (${targetLabel})...`);
          try {
            const res = await PureAPI.importBrowserCookies(btn.dataset.br);
            await completeSuccess(`Đã đồng bộ tài khoản ${res.account_name} từ ${res.browser}`);
          } catch (err) {
            setInlineStatus("error", err.message);
          } finally {
            btn.disabled = false;
          }
        });
      });

      document.getElementById("auth-save-cookie-btn")?.addEventListener("click", async () => {
        const txt = document.getElementById("auth-cookie-input").value;
        setInlineStatus("loading", "Đang kiểm tra và lưu cookie YouTube...");
        try {
          const res = await PureAPI.saveManualCookies(txt);
          await completeSuccess(`Đã lưu cookie thành công cho ${res.account_name}`);
        } catch (err) {
          setInlineStatus("error", err.message);
        }
      });
    };

    dialog.onclose = stopPolling;
    renderBody();
    dialog.showModal();
    if (!state.authStatus?.logged_in) {
      loadDeviceCode(false);
    }
  }

  async function openQrDialog() {
    const dialog = document.getElementById("qr-dialog");
    const body = document.getElementById("qr-dialog-body");
    const lanUrl = state.serverInfo?.lan_url || window.location.origin;

    if (PureAPI.isNativeStandalone()) {
      body.innerHTML = `
        <div class="standalone-mode-pill">Đang chạy chế độ App Độc Lập 100% (4G/5G mọi nơi)</div>
        <div class="install-steps">
          <div>Bạn đang dùng PureTube trực tiếp trên điện thoại mà không cần bật PC hay kết nối Wi-Fi chung.</div>
          <div>Mọi dữ liệu Lịch sử xem, Kênh đăng ký, Lồng tiếng Tiếng Việt & SponsorBlock đều chạy trực tiếp từ thiết bị qua mạng 4G/5G.</div>
        </div>
      `;
      dialog.showModal();
      return;
    }

    body.innerHTML = `
      <div class="qr-card">
        <div class="qr-frame">
          <img src="${PureAPI.getQrUrl(lanUrl)}" alt="Mã QR cài đặt PureTube trên iPhone và Android" />
        </div>
        <div class="lan-url-row">
          <code>${escapeHtml(lanUrl)}</code>
          <button type="button" class="btn-subtle btn-sm" id="copy-lan-url-modal">Sao chép</button>
        </div>
      </div>
      <div id="qr-reference-packages" class="mobile-pkg-list">
        <div class="settings-desc">Đang kiểm tra các gói App APK / IPA độc lập (4G/5G)...</div>
      </div>
      <div class="install-steps">
        <div><strong>Dùng 4G/5G không cần bật PC:</strong></div>
        <div>1. Cài 2 app độc lập có sẵn (hoặc tự build PureTube <code>.apk</code> / <code>.ipa</code> từ thư mục <code>mobile/</code> + GitHub Actions).</div>
        <div>2. Hoặc triển khai PureTube bằng <code>Dockerfile</code> / <code>render.yaml</code> lên Cloud 24/7 miễn phí, rồi mở trên iPhone Safari → <strong>Thêm vào Màn hình chính</strong> (không bị hết hạn chứng chỉ 7 ngày như file IPA!).</div>
      </div>
    `;

    document.getElementById("copy-lan-url-modal").addEventListener("click", () => {
      navigator.clipboard?.writeText(lanUrl);
      window.showAppToast("Đã sao chép địa chỉ truy cập.");
    });
    dialog.showModal();

    try {
      const pkgData = await PureAPI.getMobilePackages();
      const box = document.getElementById("qr-reference-packages");
      if (!box) return;
      const pkgs = pkgData.packages || [];
      if (!pkgs.length) {
        box.innerHTML = `<div class="settings-desc">Đã sẵn sàng mã nguồn App độc lập (Android Kotlin & iOS Swift) trong <code>mobile/</code> và workflow tự động build APK/IPA.</div>`;
        return;
      }
      box.innerHTML = `
        <h3 style="margin:2px 0 4px;font-size:0.92rem;">Tải nhanh App Độc Lập trong Downloads qua Wi-Fi</h3>
        ${pkgs
          .map((p) => {
            const dlUrl = `${lanUrl.replace(/\/+$/, "")}${p.download_path}`;
            const tag = p.platform === "android" ? "Android APK" : "iPhone IPA";
            return `
            <div class="mobile-pkg-card">
              <div class="mobile-pkg-head">
                <div>
                  <span class="mobile-pkg-badge ${escapeHtml(p.platform)}">${tag}</span>
                  <strong>${escapeHtml(p.name)}</strong>
                  <div class="settings-desc">${escapeHtml(p.version)} · ${p.size_mb} MB</div>
                </div>
                <a class="btn-primary btn-sm" href="${PureAPI.resolveUrl(p.download_path)}" download="${escapeHtml(p.filename)}" style="text-decoration:none;">Tải file</a>
              </div>
              <div class="settings-desc">${escapeHtml(p.note)}</div>
              <div class="mobile-pkg-qr-row">
                <img class="mini-qr" src="${PureAPI.getQrUrl(dlUrl)}" alt="QR tải ${escapeHtml(p.filename)}" />
                <code>${escapeHtml(dlUrl)}</code>
              </div>
            </div>`;
          })
          .join("")}
      `;
    } catch (_) {}
  }

  function openPlaylistDialog() {
    if (!state.currentVideoSummary) return;
    const dialog = document.getElementById("playlist-dialog");
    const body = document.getElementById("playlist-dialog-body");
    const video = state.currentVideoSummary;

    const renderBody = (ytPlaylists = null, ytLoading = false) => {
      body.innerHTML = `
        ${
          state.authStatus?.logged_in
            ? `
          <div style="margin-bottom:8px;">
            <div class="settings-desc" style="font-weight:600;color:var(--text-primary);margin-bottom:6px;">Trên tài khoản YouTube (Đồng bộ Google)</div>
            <div style="display:flex;flex-direction:column;gap:6px;" id="dialog-yt-pl-box">
              ${
                ytLoading
                  ? `<div class="settings-desc">Đang tải playlist YouTube...</div>`
                  : (ytPlaylists || [])
                      .filter((p) => p.id !== "LL")
                      .map(
                        (pl) => `
                  <label class="playlist-option-row" style="cursor:pointer;">
                    <span>${escapeHtml(pl.title)}</span>
                    <input type="checkbox" class="yt-pl-dialog-cb" data-yt-pl-id="${escapeHtml(pl.id)}" ${pl.contains_selected ? "checked" : ""} style="width:18px;height:18px;accent-color:var(--accent);" />
                  </label>`
                      )
                      .join("") || `<div class="settings-desc">Không có danh sách khả dụng.</div>`
              }
            </div>
          </div>`
            : ""
        }
        <div class="settings-desc" style="font-weight:600;color:var(--text-primary);margin-bottom:4px;">Trên thiết bị này</div>
        <div style="display:flex;flex-direction:column;gap:8px;">
          ${Store.state.playlists
            .map((pl) => {
              const checked = Store.hasVideoInPlaylist(pl.id, video.id);
              return `
              <label class="playlist-option-row" style="cursor:pointer;">
                <span>${escapeHtml(pl.name)} <small style="color:var(--text-secondary);">(${pl.items.length})</small></span>
                <input type="checkbox" class="pl-dialog-cb" data-pl-id="${escapeHtml(pl.id)}" ${checked ? "checked" : ""} style="width:18px;height:18px;accent-color:var(--accent);" />
              </label>`;
            })
            .join("")}
        </div>
        <form class="create-pl-inline" id="dialog-create-pl-form">
          <input type="text" id="dialog-new-pl-name" placeholder="Tên danh sách phát mới..." required />
          <button type="submit" class="btn-primary btn-sm">Tạo</button>
        </form>
      `;

      body.querySelectorAll(".yt-pl-dialog-cb").forEach((cb) => {
        cb.addEventListener("change", async () => {
          const add = cb.checked;
          const pid = cb.dataset.ytPlId;
          cb.disabled = true;
          try {
            await PureAPI.addVideoToYoutubePlaylist(pid, video.id, !add);
            delete state.ytPlaylistItemsMap[pid];
            if (pid === "WL") {
              state.watchLaterActive = add;
              const wlBtn = document.getElementById("watch-watchlater-btn");
              if (wlBtn) {
                wlBtn.classList.toggle("active", add);
                const sp = wlBtn.querySelector("span");
                if (sp) sp.textContent = add ? "Đã thêm Xem sau" : "Xem sau";
              }
            }
            window.showAppToast(add ? "Đã lưu lên playlist YouTube của bạn." : "Đã gỡ khỏi playlist YouTube.");
          } catch (err) {
            cb.checked = !add;
            window.showAppToast(err.message);
          } finally {
            cb.disabled = false;
          }
        });
      });

      body.querySelectorAll(".pl-dialog-cb").forEach((cb) => {
        cb.addEventListener("change", () => {
          const added = Store.toggleVideoInPlaylist(cb.dataset.plId, video);
          window.showAppToast(added ? "Đã lưu vào danh sách phát." : "Đã gỡ khỏi danh sách phát.");
        });
      });

      document.getElementById("dialog-create-pl-form").addEventListener("submit", (e) => {
        e.preventDefault();
        const input = document.getElementById("dialog-new-pl-name");
        const created = Store.createPlaylist(input.value);
        if (created) {
          Store.toggleVideoInPlaylist(created.id, video);
          window.showAppToast(`Đã tạo và lưu vào "${created.name}".`);
          renderBody(ytPlaylists, false);
        }
      });
    };

    renderBody(null, Boolean(state.authStatus?.logged_in));
    dialog.showModal();
    if (state.authStatus?.logged_in) {
      PureAPI.getYoutubePlaylists(video.id)
        .then((res) => renderBody(res.playlists || [], false))
        .catch(() => renderBody([], false));
    }
  }

  function bindGlobalEvents() {
    document.querySelectorAll("[data-tab]").forEach((btn) => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });
    document.querySelectorAll("[data-nav='home']").forEach((btn) => {
      btn.addEventListener("click", () => switchTab("home"));
    });

    document.getElementById("channel-tabs-strip")?.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-ch-tab]");
      if (!btn || !state.channelPage.ref) return;
      openChannelPage(state.channelPage.ref, state.channelPage.name, btn.dataset.chTab);
    });

    // Shorts interactions & swipe navigation
    const shortsVideo = document.getElementById("shorts-video");
    if (shortsVideo) {
      let touchStartY = 0;
      const stageEl = document.getElementById("shorts-stage");
      shortsVideo.addEventListener("click", () => {
        if (shortsVideo.paused) shortsVideo.play().catch(() => {});
        else shortsVideo.pause();
      });
      stageEl?.addEventListener("touchstart", (e) => {
        touchStartY = e.touches?.[0]?.clientY || 0;
      }, { passive: true });
      stageEl?.addEventListener("touchend", (e) => {
        const dy = (e.changedTouches?.[0]?.clientY || 0) - touchStartY;
        if (Math.abs(dy) > 55) {
          playShortAtIndex(state.shortsIndex + (dy < 0 ? 1 : -1));
        }
      }, { passive: true });
    }
    document.getElementById("shorts-prev-btn")?.addEventListener("click", () => playShortAtIndex(state.shortsIndex - 1));
    document.getElementById("shorts-next-btn")?.addEventListener("click", () => playShortAtIndex(state.shortsIndex + 1));
    document.getElementById("shorts-refresh-btn")?.addEventListener("click", () => renderShortsView(true));
    document.getElementById("shorts-topic-strip")?.addEventListener("click", (e) => {
      const chip = e.target.closest("[data-shorts-q]");
      if (!chip) return;
      state.shortsTopic = chip.dataset.shortsQ || "";
      renderShortsView(true);
    });
    document.getElementById("shorts-mute-btn")?.addEventListener("click", () => {
      state.shortsMuted = !state.shortsMuted;
      const sv = document.getElementById("shorts-video");
      if (sv) sv.muted = state.shortsMuted;
      if (state._shortsAudio) state._shortsAudio.muted = state.shortsMuted;
      document.getElementById("shorts-mute-btn").textContent = state.shortsMuted ? "Đã tắt tiếng" : "Âm thanh";
    });
    document.getElementById("shorts-open-full-btn")?.addEventListener("click", () => {
      const cur = state.shortsItems[state.shortsIndex];
      if (cur) openWatchVideo(cur);
    });
    document.getElementById("shorts-comments-btn")?.addEventListener("click", () => {
      const cur = state.shortsItems[state.shortsIndex];
      if (cur) {
        openWatchVideo(cur).then(() => {
          document.getElementById("watch-comments-card")?.scrollIntoView({ behavior: "smooth" });
        });
      }
    });
    document.getElementById("shorts-channel-btn")?.addEventListener("click", () => {
      const d = state.shortsVideoData || state.shortsItems[state.shortsIndex];
      if (d) openChannelPage(d.channel_id || d.channel, d.channel);
    });
    document.getElementById("shorts-like-btn")?.addEventListener("click", async () => {
      const cur = state.shortsItems[state.shortsIndex];
      if (!cur) return;
      if (!state.authStatus?.logged_in) {
        window.showAppToast("Hãy đăng nhập Google để Thích video lên YouTube.");
        return;
      }
      try {
        await PureAPI.reactVideo(cur.id, "like");
        document.getElementById("shorts-like-btn")?.classList.add("active");
        document.getElementById("shorts-like-label").textContent = "Đã thích";
        window.showAppToast("Đã thích Short lên tài khoản YouTube.");
      } catch (err) {
        window.showAppToast(err.message);
      }
    });

    // Category chips, Home refresh & Load more
    document.getElementById("category-strip").addEventListener("click", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip) return;
      document.querySelectorAll("#category-strip .chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      loadTrending(chip.dataset.category);
    });

    document.getElementById("home-refresh-btn")?.addEventListener("click", () => {
      loadTrending(state.category, { refresh: true });
    });

    document.getElementById("home-load-more-btn")?.addEventListener("click", () => {
      if (state.homeNextToken) {
        loadTrending(state.category, { append: true });
      }
    });

    document.getElementById("clear-search-results-btn").addEventListener("click", () => {
      document.getElementById("search-input").value = "";
      document.getElementById("search-clear-btn").classList.add("hidden");
      loadTrending(state.category);
    });

    const searchForm = document.getElementById("search-form");
    const searchInput = document.getElementById("search-input");
    const searchClear = document.getElementById("search-clear-btn");
    const suggestBox = document.getElementById("search-suggestions");

    searchForm.addEventListener("submit", (e) => {
      e.preventDefault();
      performSearch(searchInput.value);
    });

    searchInput.addEventListener("input", () => {
      const val = searchInput.value.trim();
      searchClear.classList.toggle("hidden", !val);
      clearTimeout(state.suggestTimer);
      if (!val || val.startsWith("http")) {
        suggestBox.classList.add("hidden");
        return;
      }
      state.suggestTimer = setTimeout(async () => {
        try {
          const data = await PureAPI.suggest(val);
          const list = data.suggestions || [];
          if (!list.length || document.activeElement !== searchInput) {
            suggestBox.classList.add("hidden");
            return;
          }
          suggestBox.innerHTML = list
            .map(
              (sug) => `
            <button type="button" class="suggestion-item" data-q="${escapeHtml(sug)}">
              <svg class="icon" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
              <span>${escapeHtml(sug)}</span>
            </button>`
            )
            .join("");
          suggestBox.classList.remove("hidden");
          suggestBox.querySelectorAll(".suggestion-item").forEach((btn) => {
            btn.addEventListener("click", () => {
              searchInput.value = btn.dataset.q;
              searchClear.classList.remove("hidden");
              performSearch(btn.dataset.q);
            });
          });
        } catch (_) {}
      }, 240);
    });

    searchClear.addEventListener("click", () => {
      searchInput.value = "";
      searchClear.classList.add("hidden");
      suggestBox.classList.add("hidden");
      searchInput.focus();
    });

    document.addEventListener("click", (e) => {
      if (!e.target.closest("#search-wrapper")) {
        suggestBox.classList.add("hidden");
      }
      if (!e.target.closest(".download-dropdown-wrap")) {
        document.getElementById("download-menu").classList.add("hidden");
      }
    });

    document.getElementById("watch-minimize-btn").addEventListener("click", () => {
      switchTab("home");
    });

    document.getElementById("watch-channel-open-btn")?.addEventListener("click", () => {
      if (!state.currentVideoFull) return;
      openChannelPage(state.currentVideoFull.channel_id || state.currentVideoFull.channel, state.currentVideoFull.channel);
    });

    const handleReaction = async (targetAction) => {
      if (!state.currentVideoFull) return;
      if (!state.authStatus?.logged_in) {
        window.showAppToast("Hãy đăng nhập Google để Thích / Không thích đồng bộ YouTube.");
        openAuthDialog();
        return;
      }
      const next = state.videoReaction === targetAction ? "none" : targetAction;
      state.videoReaction = next;
      document.getElementById("watch-like-btn")?.classList.toggle("active", next === "like");
      document.getElementById("watch-dislike-btn")?.classList.toggle("active", next === "dislike");
      try {
        await PureAPI.reactVideo(state.currentVideoFull.id, next);
        delete state.ytPlaylistItemsMap.LL;
        window.showAppToast(next === "like" ? "Đã thích video & đồng bộ YouTube." : next === "dislike" ? "Đã đánh dấu Không thích." : "Đã bỏ tương tác.");
      } catch (err) {
        window.showAppToast(err.message);
      }
    };
    document.getElementById("watch-like-btn")?.addEventListener("click", () => handleReaction("like"));
    document.getElementById("watch-dislike-btn")?.addEventListener("click", () => handleReaction("dislike"));
    document.getElementById("comments-load-more-btn")?.addEventListener("click", () => {
      if (state.currentVideoFull && state.commentsNextToken) {
        loadVideoComments(state.currentVideoFull.id, state.commentsNextToken, true);
      }
    });

    document.getElementById("watch-subscribe-btn").addEventListener("click", async () => {
      if (!state.currentVideoFull) return;
      const cid = state.currentVideoFull.channel_id;
      const cname = state.currentVideoFull.channel;
      const added = Store.toggleSubscription({ id: cid, name: cname });
      updateSubscribeButton(cname);
      if (state.authStatus?.logged_in && /^UC[A-Za-z0-9_-]{22}$/.test(cid || "")) {
        try {
          await PureAPI.subscribeChannel(cid, added);
        } catch (_) {}
      }
      window.showAppToast(added ? `Đã đăng ký kênh ${cname}` : "Đã hủy đăng ký kênh");
    });

    document.getElementById("watch-watchlater-btn")?.addEventListener("click", async () => {
      if (!state.currentVideoFull || !state.currentVideoSummary) return;
      const btn = document.getElementById("watch-watchlater-btn");
      const nextAdd = !state.watchLaterActive;
      if (state.authStatus?.logged_in) {
        btn.disabled = true;
        try {
          await PureAPI.addVideoToYoutubePlaylist("WL", state.currentVideoFull.id, !nextAdd);
          delete state.ytPlaylistItemsMap.WL;
          state.watchLaterActive = nextAdd;
          btn.classList.toggle("active", nextAdd);
          const sp = btn.querySelector("span");
          if (sp) sp.textContent = nextAdd ? "Đã thêm Xem sau" : "Xem sau";
          window.showAppToast(nextAdd ? "Đã lưu vào Xem sau trên YouTube." : "Đã gỡ khỏi Xem sau.");
        } catch (err) {
          window.showAppToast(err.message || "Không cập nhật được Xem sau.");
        } finally {
          btn.disabled = false;
        }
        return;
      }
      let wlLocal = (Store.state.playlists || []).find((p) => String(p.name || "").trim().toLowerCase() === "xem sau");
      if (!wlLocal) wlLocal = Store.createPlaylist("Xem sau");
      if (wlLocal) {
        const added = Store.toggleVideoInPlaylist(wlLocal.id, state.currentVideoSummary);
        state.watchLaterActive = added;
        btn.classList.toggle("active", added);
        const sp = btn.querySelector("span");
        if (sp) sp.textContent = added ? "Đã thêm Xem sau" : "Xem sau";
        window.showAppToast(added ? "Đã lưu vào Xem sau (liên kết Google để đồng bộ YouTube)." : "Đã gỡ khỏi Xem sau.");
      }
    });

    document.getElementById("watch-save-playlist-btn").addEventListener("click", openPlaylistDialog);

    document.getElementById("watch-download-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      document.getElementById("download-menu").classList.toggle("hidden");
    });

    PureAPI.addNativeListener("downloadProgress", (ev) => {
      if (ev?.percent !== undefined && ev.percent % 25 === 0) {
        window.showAppToast(`Đang tải offline: ${ev.percent}%...`);
      }
    });

    document.getElementById("download-menu").querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!state.currentVideoFull) return;
        const mode = btn.dataset.dlMode;
        const height = parseInt(btn.dataset.dlHeight, 10) || 720;
        document.getElementById("download-menu").classList.add("hidden");

        if (PureAPI.isNativeStandalone()) {
          window.showAppToast("Đang tải tệp offline về bộ nhớ điện thoại...");
          try {
            const res = await PureAPI.downloadToDevice(state.currentVideoFull, mode);
            window.showAppToast(`Đã lưu thành công: ${res.savedPath || res.filename}`);
          } catch (err) {
            window.showAppToast(err.message || "Không thể tải video trực tiếp này.");
          }
          return;
        }

        const url = PureAPI.getDownloadUrl(state.currentVideoFull.id, mode, height);
        window.showAppToast("Đang xử lý tệp tải về (có thể mất vài giây)...");
        const a = document.createElement("a");
        a.href = url;
        a.download = "";
        document.body.appendChild(a);
        a.click();
        a.remove();
      });
    });

    document.getElementById("desc-toggle-btn").addEventListener("click", () => {
      document.getElementById("watch-description").classList.toggle("hidden");
    });

    document.getElementById("queue-clear-btn").addEventListener("click", () => {
      state.queue = [];
      state.queueIndex = -1;
      renderQueuePanel();
    });

    document.getElementById("mini-player-expand").addEventListener("click", () => {
      if (PurePlayer.hasActiveMedia()) switchTab("watch");
    });
    document.getElementById("mini-play-btn").addEventListener("click", () => PurePlayer.togglePlay());
    document.getElementById("mini-next-btn").addEventListener("click", playNextVideo);
    document.getElementById("mini-close-btn").addEventListener("click", () => {
      PurePlayer.stop();
      updateMiniPlayerVisibility();
    });

    document.getElementById("create-playlist-btn").addEventListener("click", () => {
      const name = window.prompt("Nhập tên danh sách phát mới:");
      if (name && name.trim()) {
        Store.createPlaylist(name);
        renderPlaylistsView();
      }
    });

    document.getElementById("clear-history-btn").addEventListener("click", () => {
      Store.clearHistory();
      renderHistoryView();
      window.showAppToast("Đã xóa toàn bộ lịch sử xem trên máy.");
    });

    document.getElementById("open-auth-modal-btn").addEventListener("click", openAuthDialog);
    document.getElementById("open-qr-modal-sidebar").addEventListener("click", openQrDialog);
    document.getElementById("open-qr-modal-top").addEventListener("click", openQrDialog);
    document.querySelectorAll("[data-close-dialog]").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.getElementById(btn.dataset.closeDialog)?.close();
      });
    });
    document.querySelectorAll("dialog.app-dialog").forEach((dlg) => {
      dlg.addEventListener("click", (e) => {
        if (e.target === dlg) dlg.close();
      });
    });
  }

  async function bootstrap() {
    registerServiceWorker();
    PurePlayer.init({
      onEnded: () => {
        if (Store.state.settings.autoPlayNext) {
          playNextVideo();
        }
      },
      onNext: playNextVideo,
      onPrev: playPrevVideo,
      onProgress: (pct) => {
        const bar = document.getElementById("mini-player-progress");
        if (bar) bar.style.width = `${pct}%`;
      },
    });

    Store.subscribe(updateShieldStatsUI);
    updateShieldStatsUI();
    bindGlobalEvents();

    await refreshAuthStatus();
    try {
      state.serverInfo = await PureAPI.getInfo();
    } catch (_) {}

    loadTrending("all");
  }

  bootstrap();
})();
