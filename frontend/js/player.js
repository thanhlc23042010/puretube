const PurePlayer = {
  els: {},
  videoData: null,
  currentQuality: null,
  currentAudioTrack: null,
  isAudioOnly: false,
  isDualStream: false,
  playbackRate: 1,
  hlsInstance: null,
  isMuted: false,
  volume: 1,
  isSeekingScrubber: false,
  skippedUuids: new Set(),
  lastUndoSegment: null,
  controlsTimer: null,
  toastTimer: null,

  // Vietnamese Auto-Dubbing & Subtitles state
  dubbingMode: "auto-vi", // auto-vi | ai-female | ai-male | sub-only | off
  dubbingSegments: [],
  dubbingLoadedForId: null,
  dubbingFetching: false,
  lastSpokenIdx: -1,
  isDubSpeaking: false,
  ttsPrefetchedUrls: new Set(),

  onEndedCallback: null,
  onNextCallback: null,
  onPrevCallback: null,
  onProgressCallback: null,

  init({ onEnded, onNext, onPrev, onProgress }) {
    this.onEndedCallback = onEnded;
    this.onNextCallback = onNext;
    this.onPrevCallback = onPrev;
    this.onProgressCallback = onProgress;
    this.dubbingMode = Store.state.settings.dubbingMode || "auto-vi";

    this.els = {
      stage: document.getElementById("player-stage"),
      video: document.getElementById("main-video"),
      audio: document.getElementById("main-audio"),
      dubAudio: document.getElementById("dub-audio"),
      subtitleOverlay: document.getElementById("subtitle-overlay"),
      audioStage: document.getElementById("audio-stage"),
      audioCoverImg: document.getElementById("audio-cover-img"),
      audioEq: document.getElementById("audio-eq"),
      audioDiscWrap: document.querySelector(".audio-disc-wrap"),
      spinner: document.getElementById("player-spinner"),
      seekFeedback: document.getElementById("seek-feedback"),
      sponsorToast: document.getElementById("sponsor-toast"),
      sponsorToastMsg: document.getElementById("sponsor-toast-msg"),
      sponsorUndoBtn: document.getElementById("sponsor-undo-btn"),
      btnAudioOnly: document.getElementById("btn-audio-only"),
      audioOnlyLabel: document.getElementById("audio-only-label"),
      btnDubbingToggle: document.getElementById("btn-dubbing-toggle"),
      currentDubbingLabel: document.getElementById("current-dubbing-label"),
      btnQualityToggle: document.getElementById("btn-quality-toggle"),
      currentQualityLabel: document.getElementById("current-quality-label"),
      btnSpeedToggle: document.getElementById("btn-speed-toggle"),
      currentSpeedLabel: document.getElementById("current-speed-label"),
      btnSeekBack: document.getElementById("btn-seek-back"),
      btnSeekFwd: document.getElementById("btn-seek-fwd"),
      btnPlayCenter: document.getElementById("btn-play-center"),
      btnPlayBar: document.getElementById("btn-play-bar"),
      btnNextBar: document.getElementById("btn-next-bar"),
      btnMuteBar: document.getElementById("btn-mute-bar"),
      volumeSlider: document.getElementById("volume-slider"),
      timeDisplay: document.getElementById("time-display"),
      progressBuffered: document.getElementById("progress-buffered"),
      progressFilled: document.getElementById("progress-filled"),
      sponsorMarkers: document.getElementById("sponsor-markers"),
      scrubber: document.getElementById("progress-scrubber"),
      btnPip: document.getElementById("btn-pip"),
      btnFullscreen: document.getElementById("btn-fullscreen"),
      popover: document.getElementById("player-popover"),
    };

    this.bindEvents();
    this.setupMediaSession();
    PureAPI.addNativeListener("mediaControlAction", (ev) => {
      const act = ev?.action;
      if (act === "play") this.play();
      else if (act === "pause") this.pause();
      else if (act === "next" && this.onNextCallback) this.onNextCallback();
      else if (act === "prev" && this.onPrevCallback) this.onPrevCallback();
    });
  },

  activeMedia() {
    return this.isAudioOnly ? this.els.audio : this.els.video;
  },

  hasActiveMedia() {
    return Boolean(this.videoData);
  },

  isPlaying() {
    const media = this.activeMedia();
    return Boolean(media && !media.paused && !media.ended);
  },

  isLikelyVietnameseVideo(videoData) {
    if (!videoData) return false;
    if ((videoData.language || "").toLowerCase().startsWith("vi")) return true;
    const viCharsRegex = /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i;
    return viCharsRegex.test(videoData.title || "");
  },

  effectiveVoice() {
    if (this.dubbingMode === "ai-male") return "vi-VN-NamMinhNeural";
    return "vi-VN-HoaiMyNeural";
  },

  shouldSpeakAiDub() {
    if (!this.videoData) return false;
    if (this.dubbingMode === "ai-female" || this.dubbingMode === "ai-male") return true;
    if (this.dubbingMode === "auto-vi") {
      // Auto-dub foreign videos that don't already have an official Vietnamese YouTube audio track
      if (this.currentAudioTrack && this.currentAudioTrack.is_vi) return false;
      if (this.isLikelyVietnameseVideo(this.videoData)) return false;
      return true;
    }
    return false;
  },

  shouldShowSubtitles() {
    if (!this.videoData) return false;
    if (this.dubbingMode === "sub-only") return true;
    return this.shouldSpeakAiDub();
  },

  bindEvents() {
    const { video, audio, dubAudio, stage, scrubber } = this.els;

    const onPlayStateChange = () => {
      const playing = this.isPlaying();
      this.updatePlayIcons();
      this.scheduleHideControls();
      if ("mediaSession" in navigator) {
        navigator.mediaSession.playbackState = playing ? "playing" : "paused";
      }
      if (this.videoData) {
        PureAPI.updateMediaNotification({
          title: this.videoData.title,
          artist: this.videoData.channel,
          playing,
          clear: false,
        });
      }
      if (!playing) {
        this.stopDubSpeech();
      }
    };

    [video, audio].forEach((media) => {
      media.addEventListener("play", onPlayStateChange);
      media.addEventListener("pause", onPlayStateChange);

      media.addEventListener("seeking", () => {
        if (media === video && !this.isAudioOnly) {
          this.showSpinner(true);
          if (this.isDualStream && !audio.paused) {
            audio.pause();
          }
        }
      });

      media.addEventListener("seeked", () => {
        if (media !== this.activeMedia() && !(this.isDualStream && !this.isAudioOnly && media === audio)) return;
        const stillSeeking = video.seeking || (this.isDualStream && !this.isAudioOnly && audio.seeking);
        if (!stillSeeking) {
          this.showSpinner(false);
          if (this.isDualStream && !this.isAudioOnly && !video.paused && audio.paused) {
            audio.play().catch(() => {});
          }
        }
      });

      media.addEventListener("waiting", () => {
        if (media === this.activeMedia()) {
          this.showSpinner(true);
          if (this.isDualStream && !this.isAudioOnly && media === video && !audio.paused) {
            audio.pause();
          }
        }
      });

      media.addEventListener("playing", () => {
        if (media === this.activeMedia()) {
          clearTimeout(this._loadWatchdogTimer);
          this.showSpinner(false);
          if (this.isDualStream && !this.isAudioOnly && media === video && audio.paused && !video.seeking && !audio.seeking) {
            if (audio.readyState >= 1 && Math.abs(audio.currentTime - video.currentTime) > 0.35) {
              audio.currentTime = video.currentTime;
            }
            audio.play().catch(() => {});
          }
        }
      });

      media.addEventListener("canplay", () => {
        if (media === this.activeMedia()) {
          clearTimeout(this._loadWatchdogTimer);
          this.showSpinner(false);
        }
      });

      media.addEventListener("error", () => {
        if (!this.videoData || !media.getAttribute("src")) return;
        const isPrimary = media === this.activeMedia();
        const isDualAudio = this.isDualStream && !this.isAudioOnly && media === audio;
        if (isPrimary || isDualAudio) {
          this.handleMediaError(isDualAudio ? "audio" : "video");
        }
      });

      media.addEventListener("timeupdate", () => {
        if (media === this.activeMedia()) {
          this.handleTimeUpdate();
        }
      });

      media.addEventListener("progress", () => {
        if (media === this.activeMedia()) {
          this.updateBufferBar();
        }
      });

      media.addEventListener("loadedmetadata", () => {
        if (media === this.activeMedia()) {
          this.renderSponsorMarkers();
          this.handleTimeUpdate();
        }
      });

      media.addEventListener("ended", () => {
        if (media === this.activeMedia()) {
          if (this.isDualStream) audio.pause();
          this.stopDubSpeech();
          this.updatePlayIcons();
          if (this.onEndedCallback) this.onEndedCallback();
        }
      });
    });

    dubAudio.addEventListener("ended", () => {
      this.isDubSpeaking = false;
      this.applyDucking(false);
    });
    dubAudio.addEventListener("error", () => {
      this.isDubSpeaking = false;
      this.applyDucking(false);
    });

    this.els.btnPlayCenter.addEventListener("click", (e) => {
      e.stopPropagation();
      this.togglePlay();
    });
    this.els.btnPlayBar.addEventListener("click", (e) => {
      e.stopPropagation();
      this.togglePlay();
    });
    this.els.btnNextBar.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.onNextCallback) this.onNextCallback();
    });
    this.els.btnSeekBack.addEventListener("click", (e) => {
      e.stopPropagation();
      this.seekRelative(-10);
    });
    this.els.btnSeekFwd.addEventListener("click", (e) => {
      e.stopPropagation();
      this.seekRelative(10);
    });
    this.els.btnAudioOnly.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleAudioOnly();
    });
    this.els.btnMuteBar.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleMute();
    });
    this.els.volumeSlider.addEventListener("input", (e) => {
      this.setVolume(parseFloat(e.target.value));
    });
    this.els.btnPip.addEventListener("click", (e) => {
      e.stopPropagation();
      this.togglePiP();
    });
    this.els.btnFullscreen.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleFullscreen();
    });

    this.els.btnDubbingToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      this.togglePopover("dubbing");
    });
    this.els.btnQualityToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      this.togglePopover("quality");
    });
    this.els.btnSpeedToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      this.togglePopover("speed");
    });

    this.els.sponsorUndoBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.lastUndoSegment) {
        this.seekTo(this.lastUndoSegment.start);
        this.els.sponsorToast.classList.add("hidden");
      }
    });

    scrubber.addEventListener("input", () => {
      this.isSeekingScrubber = true;
      const duration = this.getDuration();
      if (duration > 0) {
        const pct = parseFloat(scrubber.value) / 1000;
        this.els.progressFilled.style.width = `${pct * 100}%`;
        this.els.timeDisplay.textContent = `${PureAPI.formatTime(pct * duration)} / ${PureAPI.formatTime(duration)}`;
      }
    });

    scrubber.addEventListener("change", () => {
      const duration = this.getDuration();
      if (duration > 0) {
        const target = (parseFloat(scrubber.value) / 1000) * duration;
        this.seekTo(target);
      }
      this.isSeekingScrubber = false;
    });

    let lastTapTime = 0;
    let tapTimer = null;

    stage.addEventListener("mousemove", () => this.showControls());
    stage.addEventListener("touchstart", () => this.showControls(), { passive: true });

    stage.addEventListener("click", (e) => {
      if (
        e.target.closest(".player-bottom-controls") ||
        e.target.closest(".player-top-controls") ||
        e.target.closest(".center-ctrl-btn") ||
        e.target.closest(".player-popover") ||
        e.target.closest(".sponsor-toast")
      ) {
        return;
      }

      if (!this.els.popover.classList.contains("hidden")) {
        this.els.popover.classList.add("hidden");
        return;
      }

      const now = Date.now();
      const rect = stage.getBoundingClientRect();
      const isLeftHalf = e.clientX - rect.left < rect.width / 2;

      if (now - lastTapTime < 280) {
        clearTimeout(tapTimer);
        lastTapTime = 0;
        this.seekRelative(isLeftHalf ? -10 : 10);
        return;
      }

      lastTapTime = now;
      tapTimer = setTimeout(() => {
        if (window.matchMedia("(pointer: fine)").matches) {
          this.togglePlay();
        } else {
          stage.classList.toggle("controls-hidden");
        }
      }, 240);
    });

    stage.addEventListener("keydown", (e) => {
      if (!this.videoData) return;
      switch (e.key.toLowerCase()) {
        case " ":
        case "k":
          e.preventDefault();
          this.togglePlay();
          break;
        case "arrowleft":
          e.preventDefault();
          this.seekRelative(-5);
          break;
        case "arrowright":
          e.preventDefault();
          this.seekRelative(5);
          break;
        case "j":
          this.seekRelative(-10);
          break;
        case "l":
          this.seekRelative(10);
          break;
        case "m":
          this.toggleMute();
          break;
        case "f":
          this.toggleFullscreen();
          break;
        case "a":
          this.toggleAudioOnly();
          break;
      }
    });
  },

  setupMediaSession() {
    if (!("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    const safeHandle = (action, fn) => {
      try {
        ms.setActionHandler(action, fn);
      } catch (_) {}
    };
    safeHandle("play", () => this.play());
    safeHandle("pause", () => this.pause());
    safeHandle("seekbackward", (details) => this.seekRelative(-(details.seekOffset || 10)));
    safeHandle("seekforward", (details) => this.seekRelative(details.seekOffset || 10));
    safeHandle("seekto", (details) => {
      if (typeof details.seekTime === "number") this.seekTo(details.seekTime);
    });
    safeHandle("previoustrack", () => {
      if (this.onPrevCallback) this.onPrevCallback();
    });
    safeHandle("nexttrack", () => {
      if (this.onNextCallback) this.onNextCallback();
    });
  },

  updateMediaSessionMetadata() {
    if (!("mediaSession" in navigator) || !this.videoData) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: this.videoData.title,
      artist: this.videoData.channel,
      album: "PureTube — Không Quảng Cáo",
      artwork: [
        {
          src: this.videoData.thumbnail,
          sizes: "480x360",
          type: "image/jpeg",
        },
      ],
    });
  },

  loadVideo(videoData, preserveRecovery = false) {
    const savedRecoveryStep = preserveRecovery ? (this._recoveryStep || 0) : 0;
    this.stop();
    this._recoveryStep = savedRecoveryStep;
    this.videoData = videoData;
    this.skippedUuids = new Set();
    this.lastUndoSegment = null;
    this.dubbingSegments = [];
    this.dubbingLoadedForId = null;
    this.lastSpokenIdx = -1;
    this.ttsPrefetchedUrls.clear();
    this.els.sponsorToast.classList.add("hidden");
    this.els.popover.classList.add("hidden");
    this.els.subtitleOverlay.classList.add("hidden");

    const audioTracks = videoData.audio_tracks || [];
    const viTrack = audioTracks.find((t) => t.is_vi);
    this.currentAudioTrack =
      viTrack || videoData.default_audio_track || audioTracks[0] || null;

    const preferredH = Store.state.settings.preferredQuality || 720;
    const qualities = videoData.qualities || [];
    let chosen =
      qualities.find((q) => q.height === preferredH) ||
      videoData.default_quality ||
      qualities[0] ||
      null;

    // If official Vietnamese audio track exists, force Dual-Stream video-only if available
    if (viTrack && chosen && chosen.has_audio) {
      const videoOnly = qualities.find((q) => !q.has_audio && q.height <= 1080) || qualities.find((q) => !q.has_audio);
      if (videoOnly) chosen = videoOnly;
    }

    const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (isIOS && !viTrack && chosen && !chosen.has_audio) {
      const iosProgressive = qualities.find((q) => q.has_audio);
      if (iosProgressive) chosen = iosProgressive;
    }

    this.currentQuality = chosen;
    this.isAudioOnly = Boolean(Store.state.settings.audioOnlyDefault && this.getActiveAudioUrl());
    this.els.audioCoverImg.src = videoData.thumbnail;

    this.updateQualityUI();
    this.updateDubbingUI();
    this.updateMediaSessionMetadata();
    this.applyStreamMode(0, true);
    this.renderSponsorMarkers();

    if (viTrack && window.showAppToast) {
      window.showAppToast("Đã tự động bật âm thanh Lồng tiếng Tiếng Việt của YouTube.");
    } else if (this.shouldShowSubtitles()) {
      this.ensureDubbingLoaded();
    }
  },

  setSponsorSegments(segments) {
    if (!this.videoData) return;
    this.videoData.sponsor_segments = segments || [];
    this.renderSponsorMarkers();
  },

  getActiveAudioUrl() {
    if (this.currentAudioTrack && this.currentAudioTrack.stream_url) {
      return this.currentAudioTrack.stream_url;
    }
    return this.videoData?.audio_stream_url || null;
  },

  async ensureDubbingLoaded() {
    if (!this.videoData) return;
    const vid = this.videoData.id;
    if (this.dubbingLoadedForId === vid || this.dubbingFetching) return;
    this.dubbingFetching = true;
    try {
      const res = await PureAPI.getDubbing(vid);
      if (!this.videoData || this.videoData.id !== vid) return;
      this.dubbingLoadedForId = vid;
      this.dubbingSegments = res.segments || [];
      if (this.dubbingSegments.length > 0 && this.shouldSpeakAiDub()) {
        if (window.showAppToast) {
          window.showAppToast("Đã kích hoạt Lồng tiếng & Phụ đề Tiếng Việt tự động.");
        }
        // Preload first 2 segments
        this.prefetchTtsSegment(0);
        this.prefetchTtsSegment(1);
      } else if (
        this.dubbingSegments.length === 0 &&
        (this.dubbingMode === "ai-female" || this.dubbingMode === "ai-male" || this.dubbingMode === "sub-only")
      ) {
        if (window.showAppToast) {
          window.showAppToast("Video này không có phụ đề để dịch/lồng tiếng Tiếng Việt.");
        }
      }
    } catch (_) {
    } finally {
      this.dubbingFetching = false;
    }
  },

  prefetchTtsSegment(idx) {
    if (!this.dubbingSegments || idx < 0 || idx >= this.dubbingSegments.length) return;
    const text = this.dubbingSegments[idx]?.text;
    if (!text) return;
    const key = `${this.effectiveVoice()}:${text}`;
    if (this.ttsPrefetchedUrls.has(key)) return;
    this.ttsPrefetchedUrls.add(key);
    if (PureAPI.isNativeStandalone()) {
      PureAPI.resolveTtsPlayableUrl(text, this.effectiveVoice()).catch(() => {});
      return;
    }
    const url = PureAPI.getTtsUrl(text, this.effectiveVoice());
    fetch(url).catch(() => {});
  },

  applyDucking(duck) {
    const targetVol = duck ? Math.min(this.volume, 0.2) : this.volume;
    if (this.isAudioOnly || this.isDualStream) {
      this.els.audio.volume = targetVol;
    } else {
      this.els.video.volume = targetVol;
    }
  },

  stopDubSpeech() {
    this.els.dubAudio.pause();
    if ("speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
      } catch (_) {}
    }
    this.isDubSpeaking = false;
    this.applyDucking(false);
  },

  async speakSegment(idx) {
    const seg = this.dubbingSegments[idx];
    if (!seg || !seg.text) return;
    this.lastSpokenIdx = idx;
    const voice = this.effectiveVoice();
    this.isDubSpeaking = true;
    this.applyDucking(true);

    try {
      const playableUrl = await PureAPI.resolveTtsPlayableUrl(seg.text, voice);
      if (this.lastSpokenIdx !== idx || !this.isPlaying()) return;
      this.els.dubAudio.src = playableUrl;
      this.els.dubAudio.playbackRate = Math.min(1.5, Math.max(1.12, this.playbackRate * 1.12));
      this.els.dubAudio.volume = this.isMuted ? 0 : 1;
      await this.els.dubAudio.play();
    } catch (_) {
      if ("speechSynthesis" in window && this.isPlaying()) {
        try {
          const utter = new SpeechSynthesisUtterance(seg.text);
          utter.lang = "vi-VN";
          utter.rate = Math.min(1.5, Math.max(1.05, this.playbackRate * 1.08));
          utter.volume = this.isMuted ? 0 : 1;
          utter.onend = () => {
            this.isDubSpeaking = false;
            this.applyDucking(false);
          };
          utter.onerror = () => {
            this.isDubSpeaking = false;
            this.applyDucking(false);
          };
          window.speechSynthesis.cancel();
          window.speechSynthesis.speak(utter);
        } catch (__) {
          this.isDubSpeaking = false;
          this.applyDucking(false);
        }
      } else {
        this.isDubSpeaking = false;
        this.applyDucking(false);
      }
    }
    this.prefetchTtsSegment(idx + 1);
    this.prefetchTtsSegment(idx + 2);
  },

  applyStreamMode(resumeTime = 0, autoPlay = true) {
    if (!this.videoData) return;
    const { video, audio, audioStage, btnAudioOnly, audioOnlyLabel } = this.els;
    const audioUrl = PureAPI.resolveUrl(this.getActiveAudioUrl());

    this.showSpinner(true);
    video.pause();
    audio.pause();

    if (this.isAudioOnly && audioUrl) {
      this.isDualStream = false;
      video.removeAttribute("src");
      video.load();

      audioStage.classList.remove("hidden");
      btnAudioOnly.classList.add("active");
      audioOnlyLabel.textContent = "Đang nghe âm thanh";

      audio.src = audioUrl;
      audio.volume = this.isDubSpeaking ? Math.min(this.volume, 0.2) : this.volume;
      audio.muted = this.isMuted;
      audio.playbackRate = this.playbackRate;

      const onReady = () => {
        if (resumeTime > 0) audio.currentTime = resumeTime;
        if (autoPlay) audio.play().catch(() => {});
      };
      audio.addEventListener("loadedmetadata", onReady, { once: true });
      audio.load();
      this.showControls();
      return;
    }

    this.isAudioOnly = false;
    audioStage.classList.add("hidden");
    btnAudioOnly.classList.remove("active");
    audioOnlyLabel.textContent = "Chỉ âm thanh";

    if (this.hlsInstance) {
      try {
        this.hlsInstance.destroy();
      } catch (_) {}
      this.hlsInstance = null;
    }

    if (this.videoData.is_live && this.videoData.hls_url) {
      const hlsSrc = PureAPI.resolveUrl(this.videoData.hls_url);
      this.isDualStream = false;
      audio.removeAttribute("src");
      audio.load();
      video.muted = this.isMuted;
      video.volume = this.isDubSpeaking ? Math.min(this.volume, 0.2) : this.volume;

      if (window.Hls && window.Hls.isSupported()) {
        const hls = new window.Hls({ lowLatencyMode: true, enableWorker: true });
        this.hlsInstance = hls;
        hls.loadSource(hlsSrc);
        hls.attachMedia(video);
        hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
          clearTimeout(this._loadWatchdogTimer);
          if (autoPlay) this.play();
        });
        hls.on(window.Hls.Events.ERROR, (_ev, data) => {
          if (!data?.fatal) return;
          if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
            hls.startLoad();
          } else {
            this.handleMediaError("hls");
          }
        });
        this.showControls();
        return;
      }
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = hlsSrc;
        video.addEventListener(
          "loadedmetadata",
          () => {
            clearTimeout(this._loadWatchdogTimer);
            if (autoPlay) this.play();
          },
          { once: true }
        );
        video.load();
        return;
      }
    }

    if (!this.currentQuality) {
      this.showSpinner(false);
      return;
    }

    const forceSeparateAudio =
      this.currentAudioTrack && !this.currentAudioTrack.is_original && Boolean(audioUrl);
    this.isDualStream =
      (!this.currentQuality.has_audio || forceSeparateAudio) && Boolean(audioUrl);

    video.src = PureAPI.resolveUrl(this.currentQuality.stream_url);
    video.playbackRate = this.playbackRate;

    if (this.isDualStream) {
      video.muted = true;
      audio.src = audioUrl;
      audio.volume = this.isDubSpeaking ? Math.min(this.volume, 0.2) : this.volume;
      audio.muted = this.isMuted;
      audio.playbackRate = this.playbackRate;
      audio.addEventListener(
        "loadedmetadata",
        () => {
          if (!this.videoData || !this.isDualStream || this.isAudioOnly) return;
          if (video.currentTime > 0.1) {
            audio.currentTime = video.currentTime;
          }
          if (!video.paused) {
            audio.play().catch(() => {});
          }
        },
        { once: true }
      );
      audio.load();
    } else {
      audio.removeAttribute("src");
      audio.load();
      video.muted = this.isMuted;
      video.volume = this.isDubSpeaking ? Math.min(this.volume, 0.2) : this.volume;
    }

    const onVideoReady = () => {
      clearTimeout(this._loadWatchdogTimer);
      if (resumeTime > 0) {
        video.currentTime = resumeTime;
        if (this.isDualStream && audio.readyState >= 1) audio.currentTime = resumeTime;
      }
      if (autoPlay) {
        this.play();
      }
    };
    video.addEventListener("loadedmetadata", onVideoReady, { once: true });
    clearTimeout(this._loadWatchdogTimer);
    this._loadWatchdogTimer = setTimeout(() => {
      if (this.videoData && video.readyState === 0 && !this.isAudioOnly) {
        this.handleMediaError("timeout");
      }
    }, 18000);
    video.load();
  },

  async handleMediaError(reason = "video") {
    clearTimeout(this._loadWatchdogTimer);
    if (!this.videoData) return;
    const vid = this.videoData.id;
    const step = this._recoveryStep || 0;

    if (step === 0) {
      this._recoveryStep = 1;
      const combined = (this.videoData.qualities || []).find(
        (q) => q.has_audio && (!this.currentQuality || q.id !== this.currentQuality.id)
      );
      if (combined) {
        this.currentQuality = combined;
        this.isAudioOnly = false;
        this.updateQualityUI();
        this.applyStreamMode(this.getCurrentTime(), true);
        return;
      }
    }

    if (step <= 1) {
      this._recoveryStep = 2;
      try {
        const refreshed = await PureAPI.getVideo(vid, true);
        if (this.videoData && this.videoData.id === vid && refreshed?.qualities?.length) {
          const resumeAt = this.getCurrentTime();
          this.loadVideo(refreshed, true);
          if (resumeAt > 1) this.seekTo(resumeAt);
          return;
        }
      } catch (_) {}
    }

    this.showSpinner(false);
    if (window.showAppToast) {
      window.showAppToast(
        reason === "timeout"
          ? "Kết nối luồng phát quá chậm. Vui lòng thử lại hoặc đổi chất lượng."
          : "Không thể phát luồng video này. Vui lòng thử chất lượng khác."
      );
    }
  },

  play() {
    const media = this.activeMedia();
    if (!media || (!media.src && !media.srcObject && !this.hlsInstance)) return;
    media.play().catch(() => {});
    if (this.isDualStream && !this.isAudioOnly) {
      if (this.els.audio.readyState >= 1) {
        this.els.audio.currentTime = this.els.video.currentTime;
      }
      this.els.audio.play().catch(() => {});
    }
    this.updatePlayIcons();
  },

  pause() {
    this.els.video.pause();
    this.els.audio.pause();
    this.stopDubSpeech();
    this.updatePlayIcons();
    const cur = this.getCurrentTime();
    if (this.videoData?.id && cur >= 2) {
      PureAPI.reportWatchProgress(this.videoData.id, cur, this.getDuration());
    }
  },

  togglePlay() {
    if (this.isPlaying()) {
      this.pause();
    } else {
      this.play();
    }
  },

  stop() {
    clearTimeout(this._loadWatchdogTimer);
    this._recoveryStep = 0;
    if (this.hlsInstance) {
      try {
        this.hlsInstance.destroy();
      } catch (_) {}
      this.hlsInstance = null;
    }
    PureAPI.updateMediaNotification({ clear: true });
    this.els.video.pause();
    this.els.audio.pause();
    this.stopDubSpeech();
    this.els.video.removeAttribute("src");
    this.els.audio.removeAttribute("src");
    this.els.dubAudio.removeAttribute("src");
    this.els.video.load();
    this.els.audio.load();
    this.videoData = null;
    this.isDualStream = false;
    this.isAudioOnly = false;
    this.showSpinner(false);
    this.els.subtitleOverlay.classList.add("hidden");
    this.els.sponsorMarkers.innerHTML = "";
    this.els.progressFilled.style.width = "0%";
    this.els.progressBuffered.style.width = "0%";
    this.els.timeDisplay.textContent = "0:00 / 0:00";
  },

  getCurrentTime() {
    const media = this.activeMedia();
    return media && Number.isFinite(media.currentTime) ? media.currentTime : 0;
  },

  getDuration() {
    const media = this.activeMedia();
    if (media && Number.isFinite(media.duration) && media.duration > 0) {
      return media.duration;
    }
    return (this.videoData && this.videoData.duration) || 0;
  },

  seekTo(seconds) {
    const duration = this.getDuration();
    const clamped = Math.max(0, Math.min(seconds, duration || seconds));
    this.stopDubSpeech();
    this.lastSpokenIdx = -1;
    this._lastAudioSyncAt = Date.now();
    if (Math.abs(clamped - this.getCurrentTime()) > 2) {
      this.showSpinner(true);
    }
    if (this.isAudioOnly) {
      this.els.audio.currentTime = clamped;
    } else {
      if (this.isDualStream) {
        if (!this.els.audio.paused) this.els.audio.pause();
        if (this.els.audio.readyState >= 1) {
          this.els.audio.currentTime = clamped;
        }
      }
      this.els.video.currentTime = clamped;
    }
    this.handleTimeUpdate();
  },

  seekRelative(delta) {
    const next = this.getCurrentTime() + delta;
    this.seekTo(next);
    this.flashSeekFeedback(delta);
  },

  flashSeekFeedback(delta) {
    const el = this.els.seekFeedback;
    el.textContent = delta > 0 ? `+${delta} giây` : `${delta} giây`;
    el.className = `seek-feedback ${delta > 0 ? "right" : "left"}`;
    clearTimeout(this.seekFeedbackTimer);
    this.seekFeedbackTimer = setTimeout(() => {
      el.classList.add("hidden");
    }, 650);
  },

  toggleAudioOnly() {
    if (!this.videoData || !this.getActiveAudioUrl()) {
      if (window.showAppToast) window.showAppToast("Video này không có luồng âm thanh tách rời.");
      return;
    }
    const current = this.getCurrentTime();
    const wasPlaying = this.isPlaying();
    this.isAudioOnly = !this.isAudioOnly;
    this.applyStreamMode(current, wasPlaying);
    if (window.showAppToast) {
      window.showAppToast(
        this.isAudioOnly
          ? "Đã bật Chỉ Âm Thanh — Nghe nền ngay cả khi tắt màn hình"
          : "Đã chuyển lại chế độ Video"
      );
    }
  },

  setDubbingMode(mode) {
    this.dubbingMode = mode;
    Store.updateSetting("dubbingMode", mode);
    this.stopDubSpeech();
    this.lastSpokenIdx = -1;
    this.updateDubbingUI();
    this.els.popover.classList.add("hidden");

    if (this.shouldShowSubtitles()) {
      this.ensureDubbingLoaded();
    } else {
      this.els.subtitleOverlay.classList.add("hidden");
    }
  },

  setAudioTrack(track) {
    if (!track || (this.currentAudioTrack && this.currentAudioTrack.id === track.id)) {
      this.els.popover.classList.add("hidden");
      return;
    }
    const current = this.getCurrentTime();
    const wasPlaying = this.isPlaying();
    this.currentAudioTrack = track;
    this.stopDubSpeech();
    this.lastSpokenIdx = -1;
    if (track.is_vi) {
      this.els.subtitleOverlay.classList.add("hidden");
    }
    this.updateDubbingUI();
    this.applyStreamMode(current, wasPlaying);
    this.els.popover.classList.add("hidden");
  },

  setQuality(qualityObj) {
    if (!qualityObj || (this.currentQuality && this.currentQuality.id === qualityObj.id && !this.isAudioOnly)) {
      return;
    }
    const current = this.getCurrentTime();
    const wasPlaying = this.isPlaying();
    this.currentQuality = qualityObj;
    this.isAudioOnly = false;
    Store.updateSetting("preferredQuality", qualityObj.height);
    this.updateQualityUI();
    this.applyStreamMode(current, wasPlaying);
    this.els.popover.classList.add("hidden");
  },

  setSpeed(rate) {
    this.playbackRate = rate;
    this.els.video.playbackRate = rate;
    this.els.audio.playbackRate = rate;
    this.els.currentSpeedLabel.textContent = `${rate}x`;
    this.els.popover.classList.add("hidden");
  },

  toggleMute() {
    this.isMuted = !this.isMuted;
    if (this.isAudioOnly || this.isDualStream) {
      this.els.audio.muted = this.isMuted;
    } else {
      this.els.video.muted = this.isMuted;
    }
    this.els.dubAudio.volume = this.isMuted ? 0 : 1;
    this.updateMuteIcons();
  },

  setVolume(val) {
    this.volume = Math.max(0, Math.min(1, val));
    this.isMuted = this.volume === 0;
    const effective = this.isDubSpeaking ? Math.min(this.volume, 0.2) : this.volume;
    this.els.audio.volume = effective;
    this.els.audio.muted = this.isMuted;
    if (!this.isDualStream) {
      this.els.video.volume = effective;
      this.els.video.muted = this.isMuted;
    }
    this.els.dubAudio.volume = this.isMuted ? 0 : 1;
    this.updateMuteIcons();
  },

  async togglePiP() {
    const video = this.els.video;
    if (!this.videoData) return;

    if (this.isAudioOnly || this.isDualStream) {
      const progressive = (this.videoData.qualities || []).find((q) => q.has_audio);
      if (progressive) {
        const t = this.getCurrentTime();
        this.currentQuality = progressive;
        this.isAudioOnly = false;
        this.updateQualityUI();
        this.applyStreamMode(t, true);
        await new Promise((r) => setTimeout(r, 450));
      }
    }

    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (video.webkitSupportsPresentationMode && typeof video.webkitSetPresentationMode === "function") {
        const nextMode = video.webkitPresentationMode === "picture-in-picture" ? "inline" : "picture-in-picture";
        video.webkitSetPresentationMode(nextMode);
      } else if (document.pictureInPictureEnabled && video.requestPictureInPicture) {
        await video.requestPictureInPicture();
      } else if (window.showAppToast) {
        window.showAppToast("Trình duyệt hiện tại không hỗ trợ Picture-in-Picture.");
      }
    } catch (_) {
      if (window.showAppToast) window.showAppToast("Hãy nhấn phát video trước khi mở Hình trong hình.");
    }
  },

  async toggleFullscreen() {
    const { stage, video } = this.els;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (stage.requestFullscreen) {
        await stage.requestFullscreen();
      } else if (video.webkitEnterFullscreen) {
        video.webkitEnterFullscreen();
      }
    } catch (_) {}
  },

  togglePopover(kind) {
    const pop = this.els.popover;
    const alreadyOpen = !pop.classList.contains("hidden") && pop.dataset.kind === kind;
    if (alreadyOpen) {
      pop.classList.add("hidden");
      return;
    }

    pop.dataset.kind = kind;
    pop.innerHTML = "";

    if (kind === "dubbing") {
      const title = document.createElement("div");
      title.className = "popover-title";
      title.textContent = "Lồng tiếng & Phụ đề Tiếng Việt";
      pop.appendChild(title);

      const dubOptions = [
        { id: "auto-vi", label: "Tự động Tiếng Việt (Khuyên dùng)" },
        { id: "ai-female", label: "Lồng tiếng AI Nữ (Hoài My)" },
        { id: "ai-male", label: "Lồng tiếng AI Nam (Nam Minh)" },
        { id: "sub-only", label: "Chỉ hiện Phụ đề Tiếng Việt (CC)" },
        { id: "off", label: "Tắt lồng tiếng / Âm thanh gốc" },
      ];
      dubOptions.forEach((opt) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `popover-option ${this.dubbingMode === opt.id ? "selected" : ""}`;
        btn.innerHTML = `<span>${opt.label}</span>${this.dubbingMode === opt.id ? "<span>✓</span>" : ""}`;
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          this.setDubbingMode(opt.id);
        });
        pop.appendChild(btn);
      });

      const tracks = this.videoData?.audio_tracks || [];
      if (tracks.length > 1) {
        const trTitle = document.createElement("div");
        trTitle.className = "popover-title";
        trTitle.style.marginTop = "6px";
        trTitle.textContent = "Luồng âm thanh YouTube";
        pop.appendChild(trTitle);

        tracks.forEach((tr) => {
          const isSel = this.currentAudioTrack && this.currentAudioTrack.id === tr.id;
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = `popover-option ${isSel ? "selected" : ""}`;
          btn.innerHTML = `<span>${tr.label}</span>${isSel ? "<span>✓</span>" : ""}`;
          btn.addEventListener("click", (e) => {
            e.stopPropagation();
            this.setAudioTrack(tr);
          });
          pop.appendChild(btn);
        });
      }
    } else if (kind === "quality") {
      const title = document.createElement("div");
      title.className = "popover-title";
      title.textContent = "Độ phân giải";
      pop.appendChild(title);

      (this.videoData?.qualities || []).forEach((q) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `popover-option ${this.currentQuality && this.currentQuality.id === q.id && !this.isAudioOnly ? "selected" : ""}`;
        btn.innerHTML = `<span>${q.label}</span><span>${q.has_audio ? "MP4" : "HD Sync"}</span>`;
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          this.setQuality(q);
        });
        pop.appendChild(btn);
      });
    } else if (kind === "speed") {
      const title = document.createElement("div");
      title.className = "popover-title";
      title.textContent = "Tốc độ phát";
      pop.appendChild(title);

      [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].forEach((rate) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `popover-option ${this.playbackRate === rate ? "selected" : ""}`;
        btn.textContent = rate === 1 ? "Bình thường (1x)" : `${rate}x`;
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          this.setSpeed(rate);
        });
        pop.appendChild(btn);
      });
    }

    pop.classList.remove("hidden");
  },

  handleTimeUpdate() {
    const current = this.getCurrentTime();
    const duration = this.getDuration();

    if (
      this.isDualStream &&
      !this.isAudioOnly &&
      !this.els.video.paused &&
      !this.els.video.seeking &&
      !this.els.audio.seeking &&
      this.els.audio.readyState >= 2
    ) {
      const nowMs = Date.now();
      const drift = Math.abs(this.els.video.currentTime - this.els.audio.currentTime);
      if (drift > 0.35 && nowMs - (this._lastAudioSyncAt || 0) > 1500) {
        this._lastAudioSyncAt = nowMs;
        this.els.audio.currentTime = this.els.video.currentTime;
      }
    }

    if (duration > 0 && !this.isSeekingScrubber) {
      const pct = Math.min(100, Math.max(0, (current / duration) * 100));
      this.els.progressFilled.style.width = `${pct}%`;
      this.els.scrubber.value = Math.round(pct * 10);
      this.els.timeDisplay.textContent = `${PureAPI.formatTime(current)} / ${PureAPI.formatTime(duration)}`;

      if ("mediaSession" in navigator && typeof navigator.mediaSession.setPositionState === "function") {
        try {
          navigator.mediaSession.setPositionState({
            duration,
            playbackRate: this.playbackRate,
            position: Math.min(current, duration),
          });
        } catch (_) {}
      }

      if (this.onProgressCallback) {
        this.onProgressCallback(pct);
      }

      if (this.videoData?.id && current >= 3 && this.isPlaying()) {
        const nowTs = Date.now();
        if (this._lastReportVid !== this.videoData.id) {
          this._lastReportVid = this.videoData.id;
          this._lastReportAt = 0;
        }
        if (nowTs - (this._lastReportAt || 0) >= 25000) {
          this._lastReportAt = nowTs;
          PureAPI.reportWatchProgress(this.videoData.id, current, duration);
        }
      }
    }

    // Subtitles & Vietnamese AI Dubbing Sync
    if (this.shouldShowSubtitles() && this.dubbingSegments.length > 0) {
      let activeIdx = -1;
      for (let i = 0; i < this.dubbingSegments.length; i += 1) {
        const seg = this.dubbingSegments[i];
        if (current >= seg.start && current <= seg.end + 0.35) {
          activeIdx = i;
          break;
        }
      }
      if (activeIdx >= 0) {
        const seg = this.dubbingSegments[activeIdx];
        this.els.subtitleOverlay.textContent = seg.text;
        this.els.subtitleOverlay.classList.remove("hidden");
        if (this.shouldSpeakAiDub() && this.isPlaying() && activeIdx !== this.lastSpokenIdx) {
          this.speakSegment(activeIdx);
        }
      } else {
        this.els.subtitleOverlay.classList.add("hidden");
      }
    } else {
      this.els.subtitleOverlay.classList.add("hidden");
    }

    // SponsorBlock Auto-Skip Check
    if (Store.state.settings.autoSkipSponsorBlock && this.videoData?.sponsor_segments?.length) {
      const enabledCats = Store.state.settings.sponsorCategories || {};
      for (const seg of this.videoData.sponsor_segments) {
        if (!enabledCats[seg.category]) continue;
        if (this.skippedUuids.has(seg.uuid)) continue;
        if (current >= seg.start && current < seg.end - 0.6) {
          this.skippedUuids.add(seg.uuid);
          this.lastUndoSegment = seg;
          const savedSec = Math.max(1, Math.round(seg.end - current));
          Store.recordAdBlocked(savedSec);
          this.seekTo(seg.end);
          this.showSponsorSkipToast(seg.label, savedSec);
          break;
        }
      }
    }
  },

  showSponsorSkipToast(label, savedSec) {
    this.els.sponsorToastMsg.textContent = `Đã bỏ qua: ${label} (+${savedSec}s)`;
    this.els.sponsorToast.classList.remove("hidden");
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.els.sponsorToast.classList.add("hidden");
    }, 5500);
  },

  renderSponsorMarkers() {
    const container = this.els.sponsorMarkers;
    container.innerHTML = "";
    const duration = this.getDuration();
    const segs = this.videoData?.sponsor_segments || [];
    if (!duration || !segs.length) return;

    segs.forEach((seg) => {
      const left = Math.max(0, Math.min(100, (seg.start / duration) * 100));
      const width = Math.max(0.5, Math.min(100 - left, ((seg.end - seg.start) / duration) * 100));
      const el = document.createElement("div");
      el.className = "sponsor-marker-seg";
      el.style.left = `${left}%`;
      el.style.width = `${width}%`;
      el.style.backgroundColor = seg.color;
      el.title = `${seg.label} (${PureAPI.formatTime(seg.start)} - ${PureAPI.formatTime(seg.end)})`;
      container.appendChild(el);
    });
  },

  updateBufferBar() {
    const media = this.activeMedia();
    const duration = this.getDuration();
    if (!media || !duration || !media.buffered || media.buffered.length === 0) return;
    try {
      const end = media.buffered.end(media.buffered.length - 1);
      const pct = Math.min(100, (end / duration) * 100);
      this.els.progressBuffered.style.width = `${pct}%`;
    } catch (_) {}
  },

  updateQualityUI() {
    this.els.currentQualityLabel.textContent = this.currentQuality ? this.currentQuality.label : "Auto";
  },

  updateDubbingUI() {
    const btn = this.els.btnDubbingToggle;
    const lbl = this.els.currentDubbingLabel;
    if (!btn || !lbl) return;

    const isActive =
      (this.currentAudioTrack && this.currentAudioTrack.is_vi) ||
      this.dubbingMode === "ai-female" ||
      this.dubbingMode === "ai-male" ||
      this.dubbingMode === "sub-only" ||
      (this.dubbingMode === "auto-vi" && this.videoData && !this.isLikelyVietnameseVideo(this.videoData));

    btn.classList.toggle("dub-active", Boolean(isActive));

    if (this.currentAudioTrack && this.currentAudioTrack.is_vi) {
      lbl.textContent = "Lồng tiếng VN (YT)";
    } else if (this.dubbingMode === "ai-female") {
      lbl.textContent = "AI Nữ VN";
    } else if (this.dubbingMode === "ai-male") {
      lbl.textContent = "AI Nam VN";
    } else if (this.dubbingMode === "sub-only") {
      lbl.textContent = "Phụ đề VN";
    } else if (this.dubbingMode === "off") {
      lbl.textContent = "Âm thanh gốc";
    } else {
      lbl.textContent = "Tự động VN";
    }
  },

  updatePlayIcons() {
    const playing = this.isPlaying();
    [this.els.btnPlayCenter, this.els.btnPlayBar, document.getElementById("mini-play-btn")].forEach(
      (btn) => {
        if (!btn) return;
        const pIcon = btn.querySelector(".icon-play");
        const sIcon = btn.querySelector(".icon-pause");
        if (pIcon && sIcon) {
          pIcon.classList.toggle("hidden", playing);
          sIcon.classList.toggle("hidden", !playing);
        }
      }
    );

    if (this.els.audioEq) {
      this.els.audioEq.classList.toggle("active", playing && this.isAudioOnly);
    }
    if (this.els.audioDiscWrap) {
      this.els.audioDiscWrap.classList.toggle("spinning", playing && this.isAudioOnly);
    }
  },

  updateMuteIcons() {
    const btn = this.els.btnMuteBar;
    const vIcon = btn.querySelector(".icon-vol");
    const mIcon = btn.querySelector(".icon-muted");
    if (vIcon && mIcon) {
      vIcon.classList.toggle("hidden", this.isMuted);
      mIcon.classList.toggle("hidden", !this.isMuted);
    }
    this.els.volumeSlider.value = this.isMuted ? 0 : this.volume;
  },

  showSpinner(show) {
    this.els.spinner.classList.toggle("hidden", !show);
  },

  showControls() {
    this.els.stage.classList.remove("controls-hidden");
    this.scheduleHideControls();
  },

  scheduleHideControls() {
    clearTimeout(this.controlsTimer);
    if (!this.isPlaying() || this.isAudioOnly) return;
    this.controlsTimer = setTimeout(() => {
      if (this.els.popover.classList.contains("hidden") && this.isPlaying() && !this.isAudioOnly) {
        this.els.stage.classList.add("controls-hidden");
      }
    }, 3200);
  },
};

window.PurePlayer = PurePlayer;
