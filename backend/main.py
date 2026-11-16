import asyncio
import hashlib
import io
import json
import os
import re
import shutil
import socket
import subprocess
import time
import urllib.parse
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import edge_tts
import httpx
import segno
import websockets
import yt_dlp
from fastapi import Body, FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

BASE_DIR = Path(__file__).resolve().parent.parent
BACKEND_DIR = BASE_DIR / "backend"
FRONTEND_DIR = BASE_DIR / "frontend"
DOWNLOADS_DIR = BACKEND_DIR / "downloads"
DOWNLOADS_DIR.mkdir(parents=True, exist_ok=True)

COOKIES_FILE = BACKEND_DIR / "youtube_cookies.txt"
OAUTH_TOKEN_FILE = BACKEND_DIR / "oauth_token.json"
AUTH_STATE_FILE = BACKEND_DIR / "auth_state.json"
GOOGLE_AUTH_PROFILE_DIR = BACKEND_DIR / "google_auth_chrome"
CDP_PORT = 9229
ACTIVE_CDP_PORT = CDP_PORT
AUTH_BROWSER_PROC: Optional[subprocess.Popen] = None
YT_TV_CLIENT_ID = "861556708454-d6dlm3lh05idd8npek18k6be8ba3oc68.apps.googleusercontent.com"
YT_TV_CLIENT_SECRET = "SboVhoG9s0rNafixCSGGKXAT"
PENDING_DEVICE_FLOW: Dict[str, Any] = {}

PORT = int(os.environ.get("PORT", os.environ.get("PURETUBE_PORT", "8000")))
IS_CLOUD_ENV = bool(
    os.environ.get("PURETUBE_CLOUD_MODE")
    or os.environ.get("RENDER")
    or os.environ.get("RAILWAY_ENVIRONMENT")
    or os.environ.get("SPACE_ID")
    or os.environ.get("FLY_APP_NAME")
)
IOS_INNERTUBE_UA = "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_1 like Mac OS X;)"
ANDROID_INNERTUBE_UA = "com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip"
VISITOR_DATA_CACHE: Dict[str, Any] = {"value": "", "expires_at": 0.0}

USER_DOWNLOADS_DIR = Path.home() / "Downloads"
REFERENCE_MOBILE_PACKAGES: Dict[str, Dict[str, Any]] = {
    "android_morphe": {
        "id": "android_morphe",
        "platform": "android",
        "name": "YouTube Morphe (ReVanced Fork)",
        "version": "21.30.216 (MP v2.2.0)",
        "filename": "YouTube M_v21.30.216-MP_v2.2.0_.apk",
        "path": USER_DOWNLOADS_DIR / "YouTube M_v21.30.216-MP_v2.2.0_.apk",
        "media_type": "application/vnd.android.package-archive",
        "note": "App YouTube gốc đã vá sẵn (cần cài thêm MicroG/GmsCore để đăng nhập Google). Chạy 4G/5G không cần PC.",
    },
    "ios_ytplus": {
        "id": "ios_ytplus",
        "platform": "ios",
        "name": "YouTubePlus (YTLite + CydiaSubstrate)",
        "version": "21.44.4",
        "filename": "YouTubePlus 21.44.4.ipa",
        "path": USER_DOWNLOADS_DIR / "YouTubePlus 21.44.4.ipa",
        "media_type": "application/octet-stream",
        "note": "IPA cho iPhone kèm YTLite, YouPiP, SponsorBlock & KeychainFix (cài qua SideStore/AltStore/Sideloadly). Chạy 4G/5G không cần PC.",
    },
}

STREAM_CACHE: Dict[str, Dict[str, Any]] = {}
SEARCH_CACHE: Dict[str, Dict[str, Any]] = {}
DUBBING_CACHE: Dict[str, Dict[str, Any]] = {}
TTS_CACHE: Dict[str, bytes] = {}
PREFETCH_INFLIGHT: set = set()
PREFETCH_SEMAPHORE = asyncio.Semaphore(2)

STREAM_CACHE_TTL = 45 * 60
SEARCH_CACHE_TTL = 10 * 60
DUBBING_CACHE_TTL = 60 * 60
MAX_TTS_CACHE_ITEMS = 450

SPONSORBLOCK_META = {
    "sponsor": {"label": "Quảng cáo tài trợ", "color": "#10B981"},
    "selfpromo": {"label": "Tự quảng cáo", "color": "#F59E0B"},
    "interaction": {"label": "Nhắc bấm Like/Sub", "color": "#EC4899"},
    "intro": {"label": "Đoạn mở đầu (Intro)", "color": "#06B6D4"},
    "outro": {"label": "Đoạn kết (Outro)", "color": "#3B82F6"},
    "music_offtopic": {"label": "Đoạn không phải nhạc", "color": "#A855F7"},
}

LANGUAGE_LABELS = {
    "vi": "Tiếng Việt",
    "vi-vn": "Tiếng Việt",
    "en": "Tiếng Anh",
    "en-us": "Tiếng Anh (Mỹ)",
    "en-gb": "Tiếng Anh (Anh)",
    "ja": "Tiếng Nhật",
    "ko": "Tiếng Hàn",
    "zh": "Tiếng Trung",
    "zh-hans": "Tiếng Trung (Giản thể)",
    "zh-hant": "Tiếng Trung (Phồn thể)",
    "fr": "Tiếng Pháp",
    "de": "Tiếng Đức",
    "es": "Tiếng Tây Ban Nha",
    "ru": "Tiếng Nga",
    "th": "Tiếng Thái",
    "id": "Tiếng Indonesia",
}

TRENDING_QUERIES = {
    "all": "ytsearch16:nhạc trẻ việt nam thịnh hành mới nhất 2026",
    "music": "ytsearch16:MV ca nhạc mới nhất Vpop Chill",
    "gaming": "ytsearch16:review game mới nhất highlights tiếng việt",
    "tech": "ytsearch16:đánh giá công nghệ smartphone AI mới nhất tiếng việt",
    "chill": "ytsearch16:nhạc lofi chill không lời học bài làm việc",
}

app = FastAPI(title="PureTube API", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Length", "Content-Range", "Accept-Ranges"],
)


def get_local_ip() -> str:
    """Detect the primary LAN IPv4 address for mobile device pairing."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        ip = sock.getsockname()[0]
        if ip and not ip.startswith("127."):
            return ip
    except OSError:
        pass
    finally:
        sock.close()

    try:
        hostname_ip = socket.gethostbyname(socket.gethostname())
        if hostname_ip and not hostname_ip.startswith("127."):
            return hostname_ip
    except OSError:
        pass
    return "127.0.0.1"


def format_duration(seconds: Optional[float]) -> str:
    """Format seconds into HH:MM:SS or MM:SS."""
    if not seconds or seconds <= 0:
        return "0:00"
    total = int(seconds)
    hours, rem = divmod(total, 3600)
    minutes, secs = divmod(rem, 60)
    if hours > 0:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes}:{secs:02d}"


def extract_video_id_from_text(text: str) -> Optional[str]:
    """Extract YouTube video ID if the input is a direct URL or 11-char ID."""
    cleaned = text.strip()
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", cleaned):
        return cleaned
    patterns = [
        r"(?:youtube\.com/watch\?.*?v=|youtu\.be/|youtube\.com/shorts/|youtube\.com/embed/)([A-Za-z0-9_-]{11})"
    ]
    for pat in patterns:
        match = re.search(pat, cleaned)
        if match:
            return match.group(1)
    return None


def pick_best_thumbnail(entry: Dict[str, Any], video_id: str) -> str:
    """Ensure every video item has a crisp, reliable thumbnail URL."""
    if video_id:
        return f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"
    thumbs = entry.get("thumbnails") or []
    if thumbs:
        return thumbs[-1].get("url", "")
    return entry.get("thumbnail") or ""


def has_oauth_token() -> bool:
    """Return True if a persisted Google OAuth2 token file exists."""
    return OAUTH_TOKEN_FILE.exists() and OAUTH_TOKEN_FILE.stat().st_size > 20


def has_cookies_file() -> bool:
    """Return True if a valid YouTube cookies file exists."""
    return COOKIES_FILE.exists() and COOKIES_FILE.stat().st_size > 50


def get_ytdlp_cookie_opts() -> Dict[str, Any]:
    """Return yt-dlp cookiefile option when user has linked a Google account."""
    if has_cookies_file():
        return {"cookiefile": str(COOKIES_FILE)}
    return {}


def read_auth_state() -> Dict[str, Any]:
    """Read persisted Google/YouTube account status."""
    if not (has_oauth_token() or has_cookies_file()):
        return {"logged_in": False, "account_name": "", "method": ""}
    default_method = "google_oauth" if has_oauth_token() else "cookies"
    if AUTH_STATE_FILE.exists():
        try:
            data = json.loads(AUTH_STATE_FILE.read_text(encoding="utf-8"))
            return {
                "logged_in": True,
                "account_name": data.get("account_name") or "Tài khoản Google",
                "method": data.get("method") or default_method,
            }
        except Exception:
            pass
    return {"logged_in": True, "account_name": "Tài khoản Google", "method": default_method}


async def get_valid_oauth_token(force_refresh: bool = False) -> Optional[str]:
    """Load persisted YouTube OAuth2 access token, refreshing automatically when needed."""
    if not has_oauth_token():
        return None
    try:
        data = json.loads(OAUTH_TOKEN_FILE.read_text(encoding="utf-8"))
    except Exception:
        return None

    access_token = data.get("access_token") or ""
    refresh_token = data.get("refresh_token") or ""
    expires_at = float(data.get("expires_at") or 0)

    if access_token and not force_refresh and time.time() < expires_at - 60:
        return access_token

    if not refresh_token:
        return access_token or None

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                "https://www.youtube.com/o/oauth2/token",
                data={
                    "client_id": YT_TV_CLIENT_ID,
                    "client_secret": YT_TV_CLIENT_SECRET,
                    "refresh_token": refresh_token,
                    "grant_type": "refresh_token",
                },
            )
        if resp.status_code == 200:
            new_tok = resp.json()
            if new_tok.get("access_token"):
                data["access_token"] = new_tok["access_token"]
                data["expires_at"] = time.time() + int(new_tok.get("expires_in", 3600))
                OAUTH_TOKEN_FILE.write_text(
                    json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
                )
                return data["access_token"]
    except Exception:
        pass
    return access_token or None


def write_auth_state(account_name: str, method: str) -> None:
    """Persist account metadata."""
    AUTH_STATE_FILE.write_text(
        json.dumps(
            {
                "account_name": account_name or "Tài khoản Google",
                "method": method,
                "updated_at": int(time.time()),
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )


def clear_youtube_caches() -> None:
    """Invalidate personalized YouTube caches on login/logout."""
    for key in list(SEARCH_CACHE.keys()):
        if key.startswith("yt_"):
            SEARCH_CACHE.pop(key, None)
    STREAM_CACHE.clear()


def write_netscape_cookies_from_dicts(
    cookies: List[Dict[str, Any]], require_youtube_domain: bool = False
) -> Tuple[bool, int]:
    """Write browser cookies in Netscape format and verify YouTube auth tokens exist."""
    lines = [
        "# Netscape HTTP Cookie File",
        "# Generated by PureTube for YouTube History Sync",
    ]
    yt_cookies = []
    auth_cookie_names = {"SAPISID", "SID", "__Secure-1PSID", "__Secure-3PSID", "LOGIN_INFO"}
    has_auth = False
    has_yt_auth = False

    for c in cookies:
        domain = str(c.get("domain") or "").strip()
        name = str(c.get("name") or "").strip()
        value = str(c.get("value") or "")
        if not domain or not name:
            continue
        if "youtube.com" not in domain and "google.com" not in domain:
            continue
        if name in auth_cookie_names and value:
            has_auth = True
            if "youtube.com" in domain:
                has_yt_auth = True
        include_sub = "TRUE" if domain.startswith(".") else "FALSE"
        path = str(c.get("path") or "/")
        secure = "TRUE" if c.get("secure") else "FALSE"
        expires = int(c.get("expires") or c.get("expirationDate") or (time.time() + 86400 * 180))
        if expires <= 0:
            expires = int(time.time() + 86400 * 30)
        lines.append(f"{domain}\t{include_sub}\t{path}\t{secure}\t{expires}\t{name}\t{value}")
        yt_cookies.append(name)

    if require_youtube_domain:
        if not has_yt_auth:
            return False, len(yt_cookies)
    elif not has_auth:
        return False, len(yt_cookies)

    COOKIES_FILE.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return True, len(yt_cookies)


def normalize_flat_entry(entry: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Normalize a flat yt-dlp search/playlist entry into frontend card shape."""
    if not entry:
        return None
    video_id = entry.get("id")
    url = entry.get("url") or ""
    if not video_id or len(video_id) != 11:
        return None
    if "/shorts/" in url:
        return None

    duration = entry.get("duration")
    if isinstance(duration, (int, float)) and 0 < duration < 45:
        return None

    channel = (
        entry.get("channel")
        or entry.get("uploader")
        or entry.get("channel_id")
        or "Kênh YouTube"
    )
    return {
        "id": video_id,
        "title": entry.get("title") or "Video không tiêu đề",
        "channel": channel,
        "channel_id": entry.get("channel_id") or entry.get("uploader_id") or channel,
        "duration": int(duration) if isinstance(duration, (int, float)) else 0,
        "duration_text": format_duration(duration),
        "view_count": entry.get("view_count") or 0,
        "thumbnail": pick_best_thumbnail(entry, video_id),
    }


def run_flat_search_sync(query_str: str, use_cookies: bool = False) -> List[Dict[str, Any]]:
    """Run yt-dlp flat search synchronously for fast listing."""
    ydl_opts: Dict[str, Any] = {
        "extract_flat": "in_playlist",
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "ignoreerrors": True,
    }
    if use_cookies:
        ydl_opts.update(get_ytdlp_cookie_opts())
    items: List[Dict[str, Any]] = []
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(query_str, download=False)
        entries = (info or {}).get("entries") or []
        for entry in entries:
            item = normalize_flat_entry(entry)
            if item:
                items.append(item)
    return items


def format_lang_label(lang_code: Optional[str], note: str = "") -> str:
    """Create readable Vietnamese language label for an audio track."""
    code = (lang_code or "").strip().lower()
    if code in LANGUAGE_LABELS:
        base = LANGUAGE_LABELS[code]
    elif "-" in code and code.split("-")[0] in LANGUAGE_LABELS:
        base = LANGUAGE_LABELS[code.split("-")[0]]
    elif code:
        base = code.upper()
    else:
        base = "Âm thanh gốc"

    if "original" in note.lower():
        return f"{base} (Gốc)"
    if "dubbed" in note.lower():
        return f"{base} (Lồng tiếng YT)"
    return base


def select_best_formats(
    formats: List[Dict[str, Any]], video_id: str
) -> Dict[str, Any]:
    """Classify yt-dlp formats into progressive, video-only, and multilingual audio tracks."""
    format_map: Dict[str, Dict[str, Any]] = {}
    combined_by_height: Dict[int, Dict[str, Any]] = {}
    video_only_by_height: Dict[int, Dict[str, Any]] = {}
    audio_by_lang: Dict[str, Dict[str, Any]] = {}

    for fmt in formats:
        url = fmt.get("url")
        fmt_id = str(fmt.get("format_id") or "")
        if not url or not fmt_id:
            continue
        protocol = fmt.get("protocol") or ""
        if "m3u8" in protocol or ("dash" in protocol and not url.startswith("http")):
            continue
        if fmt.get("ext") == "mhtml":
            continue

        vcodec = fmt.get("vcodec") or "none"
        acodec = fmt.get("acodec") or "none"
        ext = fmt.get("ext") or ""
        height = fmt.get("height") or 0
        fps = fmt.get("fps") or 30
        tbr = fmt.get("tbr") or 0
        abr = fmt.get("abr") or 0
        lang = (fmt.get("language") or "").strip()
        lang_lower = lang.lower()
        fmt_note = fmt.get("format_note") or ""

        format_map[fmt_id] = {
            "url": url,
            "ext": ext,
            "http_headers": fmt.get("http_headers") or {},
            "content_length": int(fmt.get("content_length") or fmt.get("filesize") or fmt.get("filesize_approx") or 0),
            "mime_hint": (
                "audio/mp4"
                if vcodec == "none" and ext in ("m4a", "mp4")
                else "audio/webm"
                if vcodec == "none" and ext == "webm"
                else "video/mp4"
                if ext == "mp4"
                else "video/webm"
            ),
        }

        has_video = vcodec != "none"
        has_audio = acodec != "none"

        if has_video and has_audio and height >= 144:
            score = (
                (1000 if ext == "mp4" else 0)
                + (500 if vcodec.startswith("avc1") else 0)
                + tbr
            )
            prev = combined_by_height.get(height)
            if not prev or score > prev["_score"]:
                combined_by_height[height] = {
                    "id": fmt_id,
                    "height": height,
                    "fps": int(fps) if fps else 30,
                    "has_audio": True,
                    "ext": ext,
                    "vcodec": vcodec,
                    "_score": score,
                }
        elif has_video and not has_audio and height >= 144:
            score = (
                (2000 if ext == "mp4" and vcodec.startswith("avc1") else 0)
                + (1000 if ext == "mp4" else 0)
                + (200 if "vp9" in vcodec else 0)
                + (100 if fps and fps >= 50 else 0)
                + tbr
            )
            prev = video_only_by_height.get(height)
            if not prev or score > prev["_score"]:
                video_only_by_height[height] = {
                    "id": fmt_id,
                    "height": height,
                    "fps": int(fps) if fps else 30,
                    "has_audio": False,
                    "ext": ext,
                    "vcodec": vcodec,
                    "_score": score,
                }
        elif not has_video and has_audio:
            is_original = "original" in fmt_note.lower() or not lang_lower
            lang_key = "vi" if lang_lower.startswith("vi") else ("original" if is_original else lang_lower)
            score = (
                (2500 if ext == "m4a" or "mp4a" in acodec else 0)
                + (500 if ext == "mp4" else 0)
                + abr
                + tbr
            )
            prev = audio_by_lang.get(lang_key)
            if not prev or score > prev["_score"]:
                audio_by_lang[lang_key] = {
                    "id": fmt_id,
                    "lang": lang_key,
                    "raw_lang": lang,
                    "label": format_lang_label(lang or "original", fmt_note),
                    "is_vi": lang_key == "vi",
                    "is_original": is_original,
                    "ext": ext,
                    "stream_url": f"/api/stream/{video_id}?format_id={urllib.parse.quote(fmt_id)}",
                    "_score": score,
                }

    # Build ordered audio_tracks: Vietnamese first, Original second, then others
    audio_tracks = list(audio_by_lang.values())
    audio_tracks.sort(
        key=lambda t: (0 if t["is_vi"] else (1 if t["is_original"] else 2), -t["_score"])
    )
    for t in audio_tracks:
        t.pop("_score", None)

    vi_audio = next((t for t in audio_tracks if t["is_vi"]), None)
    original_audio = next((t for t in audio_tracks if t["is_original"]), None)
    default_audio = vi_audio or original_audio or (audio_tracks[0] if audio_tracks else None)

    target_heights = [2160, 1440, 1080, 720, 480, 360, 240, 144]
    qualities: List[Dict[str, Any]] = []

    def label_for_height(h: int, fps_val: int) -> str:
        fps_tag = " 60fps" if fps_val >= 50 else ""
        if h >= 2160:
            return f"2160p (4K){fps_tag}"
        if h >= 1440:
            return f"1440p (2K){fps_tag}"
        if h >= 1080:
            return f"1080p FHD{fps_tag}"
        if h >= 720:
            return f"720p HD{fps_tag}"
        return f"{h}p"

    seen_heights = set()
    all_heights = sorted(
        set(list(combined_by_height.keys()) + list(video_only_by_height.keys())),
        reverse=True,
    )
    for h in all_heights:
        nearest = min(target_heights, key=lambda t: abs(t - h))
        bucket = nearest if abs(nearest - h) <= 40 else h
        if bucket in seen_heights:
            continue

        chosen = None
        if h <= 720 and h in combined_by_height and not vi_audio:
            chosen = combined_by_height[h]
        elif h in video_only_by_height and default_audio is not None:
            chosen = video_only_by_height[h]
        elif h in combined_by_height:
            chosen = combined_by_height[h]

        if chosen:
            seen_heights.add(bucket)
            qualities.append(
                {
                    "id": chosen["id"],
                    "height": bucket,
                    "label": label_for_height(bucket, chosen["fps"]),
                    "fps": chosen["fps"],
                    "has_audio": chosen["has_audio"],
                    "ext": chosen["ext"],
                    "stream_url": f"/api/stream/{video_id}?format_id={urllib.parse.quote(chosen['id'])}",
                }
            )

    default_quality = None
    if vi_audio:
        # When official Vietnamese audio exists, choose video-only 720p/1080p for Dual-Stream sync
        for q in qualities:
            if not q["has_audio"] and q["height"] <= 1080:
                default_quality = q
                break
    if not default_quality:
        for q in qualities:
            if q["has_audio"] and q["height"] >= 720:
                default_quality = q
                break
    if not default_quality:
        for q in qualities:
            if q["has_audio"]:
                default_quality = q
                break
    if not default_quality and qualities:
        default_quality = next((q for q in qualities if q["height"] <= 1080), qualities[0])

    return {
        "format_map": format_map,
        "qualities": qualities,
        "default_quality": default_quality,
        "audio_tracks": audio_tracks,
        "has_youtube_vi_dub": bool(vi_audio),
        "default_audio_track": default_audio,
        "audio_stream_url": default_audio["stream_url"] if default_audio else None,
    }


def get_visitor_data_sync() -> str:
    """Fetch and cache YouTube InnerTube visitorData for fast direct stream requests."""
    now = time.time()
    if VISITOR_DATA_CACHE["value"] and now < float(VISITOR_DATA_CACHE["expires_at"]):
        return str(VISITOR_DATA_CACHE["value"])
    try:
        with httpx.Client(timeout=5.0, follow_redirects=True) as client:
            resp = client.get(
                "https://www.youtube.com/sw.js_data",
                headers={"User-Agent": "Mozilla/5.0"},
            )
        if resp.status_code == 200:
            match = re.search(r"Cg[A-Za-z0-9_-]{10,}", resp.text)
            if match:
                val = match.group(0)
                VISITOR_DATA_CACHE["value"] = val
                VISITOR_DATA_CACHE["expires_at"] = now + 3600
                return val
    except Exception:
        pass
    return str(VISITOR_DATA_CACHE.get("value") or "")


def extract_via_ios_innertube_sync(video_id: str) -> Optional[Dict[str, Any]]:
    """Fast-path InnerTube extractor (ANDROID + IOS fallback, inspired by Morphe & YTLite spoofing)."""
    visitor_data = get_visitor_data_sync()
    candidates = [
        (
            {
                "clientName": "ANDROID",
                "clientVersion": "20.10.38",
                "androidSdkVersion": 34,
                "hl": "vi",
                "gl": "VN",
            },
            ANDROID_INNERTUBE_UA,
        ),
        (
            {
                "clientName": "IOS",
                "clientVersion": "20.10.4",
                "deviceMake": "Apple",
                "deviceModel": "iPhone16,2",
                "osName": "iPhone",
                "osVersion": "18.3.1.22D72",
                "hl": "vi",
                "gl": "VN",
            },
            IOS_INNERTUBE_UA,
        ),
    ]

    data = None
    active_ua = ANDROID_INNERTUBE_UA
    for client_tpl, ua in candidates:
        client_ctx = dict(client_tpl)
        if visitor_data:
            client_ctx["visitorData"] = visitor_data
        headers: Dict[str, str] = {
            "Content-Type": "application/json",
            "User-Agent": ua,
        }
        if visitor_data:
            headers["X-Goog-Visitor-Id"] = visitor_data
        payload = {
            "videoId": video_id,
            "context": {"client": client_ctx},
            "contentCheckOk": True,
            "racyCheckOk": True,
        }
        try:
            with httpx.Client(timeout=7.0, follow_redirects=True) as client:
                resp = client.post(
                    "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
                    headers=headers,
                    json=payload,
                )
            if resp.status_code != 200:
                continue
            parsed = resp.json()
            if (parsed.get("playabilityStatus") or {}).get("status") == "OK":
                sd = parsed.get("streamingData") or {}
                if sd.get("formats") or sd.get("adaptiveFormats"):
                    data = parsed
                    active_ua = ua
                    break
        except Exception:
            continue

    if not data:
        return None

    streaming = data.get("streamingData") or {}
    raw_entries: List[Tuple[Dict[str, Any], bool]] = [
        *((f, False) for f in (streaming.get("formats") or [])),
        *((f, True) for f in (streaming.get("adaptiveFormats") or [])),
    ]
    ytdlp_like_formats: List[Dict[str, Any]] = []
    req_headers = {"User-Agent": active_ua}

    for fmt, is_adaptive in raw_entries:
        stream_url = fmt.get("url")
        itag = fmt.get("itag")
        if not stream_url or itag is None:
            continue

        mime_raw = fmt.get("mimeType") or ""
        mime_base = mime_raw.split(";")[0].strip().lower()
        codec_match = re.search(r'codecs="([^"]+)"', mime_raw)
        codecs = codec_match.group(1) if codec_match else ""
        is_audio_only = mime_base.startswith("audio/")
        is_video_only = is_adaptive and mime_base.startswith("video/")

        vcodec = "none" if is_audio_only else (codecs.split(",")[0].strip() if codecs else "avc1")
        acodec = (
            codecs
            if is_audio_only
            else ("none" if is_video_only else (codecs.split(",")[-1].strip() if "," in codecs else "mp4a"))
        )
        ext = "m4a" if mime_base == "audio/mp4" else ("mp4" if "mp4" in mime_base else "webm")
        bitrate_kbps = round((fmt.get("bitrate") or 0) / 1000.0, 1)

        audio_track = fmt.get("audioTrack") or {}
        track_id = str(audio_track.get("id") or "")
        lang = track_id.split(".")[0] if track_id else ""
        display_name = str(audio_track.get("displayName") or "")
        if audio_track.get("audioIsDefault"):
            fmt_note = "original"
        elif track_id or "dubbed" in display_name.lower() or "lồng tiếng" in display_name.lower():
            fmt_note = "dubbed"
        else:
            fmt_note = ""

        ytdlp_like_formats.append(
            {
                "format_id": str(itag),
                "url": stream_url,
                "ext": ext,
                "protocol": "https",
                "vcodec": vcodec,
                "acodec": acodec,
                "height": fmt.get("height") or 0,
                "fps": fmt.get("fps") or 30,
                "tbr": bitrate_kbps,
                "abr": bitrate_kbps if is_audio_only else 0,
                "language": lang,
                "format_note": fmt_note,
                "content_length": int(fmt.get("contentLength") or 0),
                "http_headers": req_headers,
            }
        )

    hls_manifest_url = str(streaming.get("hlsManifestUrl") or "")
    details = data.get("videoDetails") or {}
    is_live = bool(details.get("isLive") or details.get("isLiveContent"))
    if not ytdlp_like_formats and not hls_manifest_url:
        return None
    subtitles: Dict[str, List[Dict[str, str]]] = {}
    auto_captions: Dict[str, List[Dict[str, str]]] = {}
    cap_tracks = (
        (data.get("captions") or {})
        .get("playerCaptionsTracklistRenderer", {})
        .get("captionTracks")
        or []
    )
    for ct in cap_tracks:
        lang_code = ct.get("languageCode") or ""
        burl = ct.get("baseUrl") or ""
        if not lang_code or not burl:
            continue
        sep = "&" if "?" in burl else "?"
        entry = [{"ext": "json3", "url": f"{burl}{sep}fmt=json3"}]
        if ct.get("kind") == "asr":
            auto_captions.setdefault(lang_code, []).extend(entry)
        else:
            subtitles.setdefault(lang_code, []).extend(entry)

    try:
        view_cnt = int(details.get("viewCount") or 0)
    except (TypeError, ValueError):
        view_cnt = 0
    try:
        duration_sec = int(details.get("lengthSeconds") or 0)
    except (TypeError, ValueError):
        duration_sec = 0

    return {
        "id": video_id,
        "title": details.get("title") or "Video không tiêu đề",
        "channel": details.get("author") or "Kênh YouTube",
        "channel_id": details.get("channelId") or details.get("author") or "Kênh YouTube",
        "channel_url": f"https://www.youtube.com/channel/{details.get('channelId')}" if details.get("channelId") else "",
        "language": "",
        "duration": duration_sec,
        "view_count": view_cnt,
        "like_count": 0,
        "upload_date": "",
        "description": details.get("shortDescription") or "",
        "is_live": is_live,
        "hls_manifest_url": hls_manifest_url,
        "hls_headers": req_headers,
        "formats": ytdlp_like_formats,
        "subtitles": subtitles,
        "automatic_captions": auto_captions,
        "chapters": [],
    }


def _extract_via_ytdlp_sync(video_id: str) -> Dict[str, Any]:
    """Full yt-dlp video extraction fallback (with optional cookies)."""
    url = f"https://www.youtube.com/watch?v={video_id}"
    ydl_opts: Dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
        "extractor_args": {"youtube": {"skip": ["hls", "dash"]}},
    }
    ydl_opts.update(get_ytdlp_cookie_opts())

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=False)
        if not info:
            raise ValueError("Không thể trích xuất thông tin video.")
        return info


def extract_video_sync(video_id: str, force_refresh: bool = False) -> Dict[str, Any]:
    """Extract video formats ultra-fast via IOS InnerTube spoofing, with yt-dlp fallback."""
    if not force_refresh:
        cached = STREAM_CACHE.get(video_id)
        if cached and cached["expires_at"] > time.time() and "video_data" in cached:
            return cached["video_data"]

    info: Optional[Dict[str, Any]] = None
    used_innertube = False
    if not has_cookies_file():
        info = extract_via_ios_innertube_sync(video_id)
        used_innertube = bool(info)

    if not info:
        info = _extract_via_ytdlp_sync(video_id)

    classified = select_best_formats(info.get("formats") or [], video_id)
    if used_innertube and not classified["qualities"] and not info.get("hls_manifest_url"):
        info = _extract_via_ytdlp_sync(video_id)
        classified = select_best_formats(info.get("formats") or [], video_id)

    hls_manifest_url = info.get("hls_manifest_url") or ""
    is_live = bool(info.get("is_live") or hls_manifest_url)

    chapters = [
        {
            "title": ch.get("title") or "Chương",
            "start_time": float(ch.get("start_time") or 0),
            "end_time": float(ch.get("end_time") or 0),
        }
        for ch in (info.get("chapters") or [])
    ]

    channel_name = info.get("channel") or info.get("uploader") or "Kênh YouTube"
    video_data = {
        "id": video_id,
        "title": info.get("title") or "Video không tiêu đề",
        "channel": channel_name,
        "channel_id": info.get("channel_id") or info.get("uploader_id") or channel_name,
        "channel_url": info.get("channel_url") or info.get("uploader_url") or "",
        "language": info.get("language") or "",
        "duration": int(info.get("duration") or 0),
        "duration_text": format_duration(info.get("duration")),
        "view_count": info.get("view_count") or 0,
        "like_count": info.get("like_count") or 0,
        "upload_date": info.get("upload_date") or "",
        "description": (info.get("description") or "")[:3000],
        "thumbnail": pick_best_thumbnail(info, video_id),
        "qualities": classified["qualities"],
        "default_quality": classified["default_quality"],
        "audio_tracks": classified["audio_tracks"],
        "has_youtube_vi_dub": classified["has_youtube_vi_dub"],
        "default_audio_track": classified["default_audio_track"],
        "audio_stream_url": classified["audio_stream_url"],
        "is_live": is_live,
        "hls_url": f"/api/hls/{video_id}" if hls_manifest_url else "",
        "chapters": chapters,
    }

    STREAM_CACHE[video_id] = {
        "expires_at": time.time() + STREAM_CACHE_TTL,
        "format_map": classified["format_map"],
        "video_data": video_data,
        "hls_manifest_url": hls_manifest_url,
        "hls_headers": info.get("hls_headers") or {"User-Agent": ANDROID_INNERTUBE_UA},
        "captions_info": {
            "language": info.get("language") or "",
            "subtitles": info.get("subtitles") or {},
            "automatic_captions": info.get("automatic_captions") or {},
        },
    }
    return video_data


def mark_video_watched_sync(video_id: str) -> None:
    """Sync playback back to signed-in YouTube watch history."""
    cookie_opts = get_ytdlp_cookie_opts()
    if not cookie_opts:
        return
    url = f"https://www.youtube.com/watch?v={video_id}"
    opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "simulate": True,
        "mark_watched": True,
        "extractor_args": {"youtube": {"skip": ["hls", "dash"]}},
        **cookie_opts,
    }
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.extract_info(url, download=False)
    except Exception:
        pass


async def fetch_sponsorblock(video_id: str) -> List[Dict[str, Any]]:
    """Fetch SponsorBlock segments asynchronously with a tight timeout."""
    categories = json.dumps(list(SPONSORBLOCK_META.keys()))
    url = f"https://sponsor.ajay.app/api/skipSegments?videoID={video_id}&categories={urllib.parse.quote(categories)}"
    try:
        async with httpx.AsyncClient(timeout=2.5) as client:
            resp = await client.get(url)
            if resp.status_code != 200:
                return []
            raw_segments = resp.json()
            segments = []
            for seg in raw_segments:
                cat = seg.get("category")
                span = seg.get("segment") or []
                if cat in SPONSORBLOCK_META and len(span) == 2:
                    start, end = float(span[0]), float(span[1])
                    if end > start:
                        segments.append(
                            {
                                "uuid": seg.get("UUID") or f"{cat}-{start}",
                                "category": cat,
                                "label": SPONSORBLOCK_META[cat]["label"],
                                "color": SPONSORBLOCK_META[cat]["color"],
                                "start": start,
                                "end": end,
                            }
                        )
            segments.sort(key=lambda s: s["start"])
            return segments
    except Exception:
        return []


def pick_caption_source(captions_info: Dict[str, Any]) -> Tuple[Optional[str], str, bool]:
    """Select best available subtitle/auto-caption json3 URL and return (url, lang, is_vi)."""
    subs = captions_info.get("subtitles") or {}
    auto_caps = captions_info.get("automatic_captions") or {}
    vid_lang = (captions_info.get("language") or "").lower().split("-")[0]

    def find_json3(entries: List[Dict[str, Any]]) -> Optional[str]:
        for e in entries:
            if e.get("ext") == "json3" and e.get("url"):
                return e["url"]
        return None

    # 1. Official Vietnamese subtitle
    for code in ("vi", "vi-VN"):
        if code in subs:
            u = find_json3(subs[code])
            if u:
                return u, "vi", True

    # 2. Official subtitle in video's language or English
    preferred_order = [vid_lang, "en", "en-US", "en-GB"]
    for code in preferred_order:
        if code and code in subs:
            u = find_json3(subs[code])
            if u:
                return u, code, code.startswith("vi")

    for code, entries in subs.items():
        u = find_json3(entries)
        if u:
            return u, code, code.startswith("vi")

    # 3. Original auto-caption (prefer original language / non-translated timedtext URL to avoid 429)
    for code in preferred_order + ["vi", "ja", "ko", "zh-Hans", "zh", "fr", "es", "de"]:
        if code and code in auto_caps:
            u = find_json3(auto_caps[code])
            if u and "&tlang=" not in u:
                return u, code, code.startswith("vi")

    for code, entries in auto_caps.items():
        u = find_json3(entries)
        if u and "&tlang=" not in u:
            return u, code, code.startswith("vi")

    return None, "", False


def merge_json3_into_sentences(json3_data: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Convert raw YouTube json3 caption events into natural dubbing sentences."""
    raw_items: List[Dict[str, Any]] = []
    for ev in json3_data.get("events") or []:
        segs = ev.get("segs") or []
        text = "".join(s.get("utf8", "") for s in segs)
        text = re.sub(r"\s+", " ", text).strip()
        if not text or text in ("[Music]", "[Applause]", "[Laughter]", "[Âm nhạc]", "[Vỗ tay]"):
            continue
        start = float(ev.get("tStartMs") or 0) / 1000.0
        dur = float(ev.get("dDurationMs") or 2000) / 1000.0
        raw_items.append({"start": start, "end": start + max(0.8, dur), "text": text})

    if not raw_items:
        return []

    sentences: List[Dict[str, Any]] = []
    buf_text = raw_items[0]["text"]
    buf_start = raw_items[0]["start"]
    buf_end = raw_items[0]["end"]

    for item in raw_items[1:]:
        gap = item["start"] - buf_end
        dur_so_far = buf_end - buf_start
        ends_punct = buf_text.endswith((".", "!", "?", "。", "！", "？"))
        # Deduplicate overlapping rolling auto-caption lines
        if item["text"] == buf_text or buf_text.endswith(item["text"]):
            buf_end = max(buf_end, item["end"])
            continue
        if (
            ends_punct
            or gap > 0.75
            or dur_so_far >= 5.2
            or len(buf_text) + len(item["text"]) > 135
        ):
            sentences.append(
                {
                    "start": round(buf_start, 2),
                    "end": round(max(buf_end, buf_start + 1.2), 2),
                    "text": buf_text.strip(),
                }
            )
            buf_text = item["text"]
            buf_start = item["start"]
            buf_end = item["end"]
        else:
            buf_text = f"{buf_text} {item['text']}".strip()
            buf_end = max(buf_end, item["end"])

    if buf_text.strip():
        sentences.append(
            {
                "start": round(buf_start, 2),
                "end": round(max(buf_end, buf_start + 1.2), 2),
                "text": buf_text.strip(),
            }
        )
    return sentences


async def translate_texts_to_vi(texts: List[str]) -> List[str]:
    """Translate caption sentences to Vietnamese fast via Chrome Translate endpoint."""
    if not texts:
        return []
    results = list(texts)
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    }
    sem = asyncio.Semaphore(6)

    async def translate_chunk(client: httpx.AsyncClient, start_idx: int, chunk: List[str]) -> None:
        # Join with unique marker so batch stays 1-1
        joined = "\n|||PT_SEP|||\n".join(chunk)
        async with sem:
            try:
                resp = await client.get(
                    "https://clients5.google.com/translate_a/t",
                    params={
                        "client": "dict-chrome-ex",
                        "sl": "auto",
                        "tl": "vi",
                        "q": joined,
                    },
                    headers=headers,
                )
                if resp.status_code == 200:
                    data = resp.json()
                    if isinstance(data, list) and data:
                        translated_joined = data[0][0] if isinstance(data[0], list) else str(data[0])
                        parts = [p.strip() for p in re.split(r"\|\|\|\s*PT_SEP\s*\|\|\|", translated_joined)]
                        if len(parts) == len(chunk):
                            for offset, val in enumerate(parts):
                                results[start_idx + offset] = val or chunk[offset]
                            return
                # Fallback individual requests for this small chunk if delimiter altered
                for offset, sentence in enumerate(chunk):
                    r_single = await client.get(
                        "https://clients5.google.com/translate_a/t",
                        params={"client": "dict-chrome-ex", "sl": "auto", "tl": "vi", "q": sentence},
                        headers=headers,
                    )
                    if r_single.status_code == 200:
                        d_s = r_single.json()
                        if isinstance(d_s, list) and d_s:
                            results[start_idx + offset] = (
                                d_s[0][0] if isinstance(d_s[0], list) else str(d_s[0])
                            )
            except Exception:
                pass

    async with httpx.AsyncClient(timeout=8.0) as client:
        tasks = []
        batch_size = 10
        for i in range(0, len(texts), batch_size):
            tasks.append(translate_chunk(client, i, texts[i : i + batch_size]))
        await asyncio.gather(*tasks)

    return results


def sanitize_filename(name: str) -> str:
    """Create a filesystem-safe filename preserving readable characters."""
    cleaned = re.sub(r'[\\/*?:"<>|]+', "", name).strip()
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned[:90] or "puretube_media"


def cleanup_old_downloads(max_age_sec: int = 7200) -> None:
    """Delete downloaded temporary files older than max_age_sec."""
    now = time.time()
    for f in DOWNLOADS_DIR.iterdir():
        if f.is_file() and now - f.stat().st_mtime > max_age_sec:
            try:
                f.unlink()
            except OSError:
                pass


def download_media_sync(video_id: str, mode: str, height: int) -> Dict[str, str]:
    """Download and mux MP4 video or extract MP3 audio via yt-dlp + ffmpeg."""
    cleanup_old_downloads()
    url = f"https://www.youtube.com/watch?v={video_id}"
    out_stem = str(DOWNLOADS_DIR / f"{video_id}_{mode}_{height}")
    cookie_opts = get_ytdlp_cookie_opts()

    if mode == "audio":
        target_path = Path(f"{out_stem}.mp3")
        ydl_opts = {
            "format": "bestaudio/best",
            "outtmpl": f"{out_stem}.%(ext)s",
            "quiet": True,
            "no_warnings": True,
            "postprocessors": [
                {
                    "key": "FFmpegExtractAudio",
                    "preferredcodec": "mp3",
                    "preferredquality": "192",
                }
            ],
            **cookie_opts,
        }
        ext = "mp3"
        media_type = "audio/mpeg"
    else:
        target_path = Path(f"{out_stem}.mp4")
        ydl_opts = {
            "format": f"bestvideo[height<=?{height}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=?{height}]+bestaudio/best[height<=?{height}]/best",
            "outtmpl": f"{out_stem}.%(ext)s",
            "merge_output_format": "mp4",
            "quiet": True,
            "no_warnings": True,
            **cookie_opts,
        }
        ext = "mp4"
        media_type = "video/mp4"

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=True)
        title = sanitize_filename((info or {}).get("title") or video_id)

    if not target_path.exists():
        matches = list(DOWNLOADS_DIR.glob(f"{video_id}_{mode}_{height}.*"))
        if not matches:
            raise FileNotFoundError("Không tìm thấy tệp sau khi tải xuống.")
        target_path = matches[0]
        ext = target_path.suffix.lstrip(".") or ext

    return {
        "path": str(target_path),
        "filename": f"{title}.{ext}",
        "media_type": media_type,
    }


def find_windows_browsers() -> List[str]:
    """Locate Chrome/Edge executables on Windows, preferring Chrome for reliable CDP isolation."""
    candidates = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe"),
        shutil.which("chrome") or "",
        shutil.which("msedge") or "",
    ]
    found: List[str] = []
    for p in candidates:
        if p and os.path.exists(p) and p not in found:
            found.append(p)
    return found


def pick_free_cdp_port(start_port: int = CDP_PORT) -> int:
    """Select an available localhost TCP port for Chrome DevTools Protocol."""
    for port in range(start_port, start_port + 10):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex(("127.0.0.1", port)) != 0:
                return port
    return start_port


def create_visible_startupinfo() -> Optional[Any]:
    """Ensure spawned Chrome/Edge windows open visibly instead of inheriting SW_HIDE."""
    if os.name != "nt":
        return None
    si = subprocess.STARTUPINFO()
    si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    si.wShowWindow = 1  # SW_SHOWNORMAL
    return si


def bring_process_window_to_front(pid: Optional[int]) -> None:
    """Restore and focus any visible window belonging to pid on Windows."""
    if os.name != "nt" or not pid:
        return
    try:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.windll.user32
        target_hwnds: List[int] = []
        enum_proc = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)

        def callback(hwnd: int, _lparam: int) -> bool:
            if not user32.IsWindowVisible(hwnd):
                return True
            proc_id = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(proc_id))
            if proc_id.value == pid:
                target_hwnds.append(hwnd)
            return True

        user32.EnumWindows(enum_proc(callback), 0)
        for hwnd in target_hwnds:
            user32.ShowWindow(hwnd, 9)  # SW_RESTORE
            user32.SetForegroundWindow(hwnd)
    except Exception:
        pass


def terminate_auth_browser() -> None:
    """Close the dedicated PureTube Google-login browser process if still running."""
    global AUTH_BROWSER_PROC
    if AUTH_BROWSER_PROC and AUTH_BROWSER_PROC.poll() is None:
        try:
            AUTH_BROWSER_PROC.terminate()
        except Exception:
            pass
    AUTH_BROWSER_PROC = None


def extract_yt_text(node: Any) -> str:
    """Extract plain text from YouTube InnerTube simpleText/runs/content structures."""
    if not node:
        return ""
    if isinstance(node, str):
        return node.strip()
    if isinstance(node, dict):
        if "simpleText" in node:
            return str(node["simpleText"]).strip()
        if "content" in node:
            return str(node["content"]).strip()
        if "runs" in node and isinstance(node["runs"], list):
            return "".join(str(r.get("text") or "") for r in node["runs"] if isinstance(r, dict)).strip()
    return ""


def parse_duration_text(text: str) -> int:
    """Convert duration text like '3:48' or '1:02:15' into integer seconds."""
    cleaned = re.sub(r"[^\d:]", "", text or "")
    if ":" not in cleaned:
        return 0
    parts = [int(p) for p in cleaned.split(":") if p.isdigit()]
    if len(parts) == 2:
        return parts[0] * 60 + parts[1]
    if len(parts) == 3:
        return parts[0] * 3600 + parts[1] * 60 + parts[2]
    return 0


def parse_view_count_text(text: str) -> int:
    """Estimate numeric view count from localized YouTube view strings."""
    raw = (text or "").lower().replace("\xa0", " ").strip()
    m = re.search(r"([\d.,]+)\s*(tr|m|n|k|b|t)?", raw)
    if not m:
        return 0
    num_str = m.group(1)
    if "," in num_str and "." not in num_str:
        num_str = num_str.replace(",", ".")
    else:
        num_str = num_str.replace(",", "")
    try:
        val = float(num_str)
    except ValueError:
        return 0
    unit = m.group(2) or ""
    mult = {"k": 1_000, "n": 1_000, "m": 1_000_000, "tr": 1_000_000, "b": 1_000_000_000, "t": 1_000_000_000}.get(unit, 1)
    return int(val * mult)


def build_puretube_item(
    video_id: str,
    title: str,
    channel: str,
    duration_sec: int = 0,
    duration_text: str = "",
    view_count: int = 0,
) -> Optional[Dict[str, Any]]:
    """Build normalized frontend video card dictionary if video_id is valid."""
    if not video_id or not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
        return None
    if not duration_sec and duration_text:
        duration_sec = parse_duration_text(duration_text)
    return {
        "id": video_id,
        "title": title or "Video không tiêu đề",
        "channel": channel or "Kênh YouTube",
        "channel_id": channel or "Kênh YouTube",
        "duration": duration_sec,
        "duration_text": duration_text or format_duration(duration_sec),
        "view_count": view_count,
        "thumbnail": pick_best_thumbnail({}, video_id),
    }


def extract_videos_from_innertube(payload: Any, limit: int = 40) -> List[Dict[str, Any]]:
    """Recursively extract non-ad video cards from YouTube InnerTube browse JSON."""
    results: List[Dict[str, Any]] = []
    seen: set = set()

    def _add(item: Optional[Dict[str, Any]]) -> None:
        if not item or item["id"] in seen or len(results) >= limit:
            return
        seen.add(item["id"])
        results.append(item)

    def _find_watch_video_id(obj: Any) -> str:
        if isinstance(obj, dict):
            if "watchEndpoint" in obj and isinstance(obj["watchEndpoint"], dict):
                vid = obj["watchEndpoint"].get("videoId") or ""
                if re.fullmatch(r"[A-Za-z0-9_-]{11}", str(vid)):
                    return str(vid)
            for v in obj.values():
                res = _find_watch_video_id(v)
                if res:
                    return res
        elif isinstance(obj, list):
            for el in obj:
                res = _find_watch_video_id(el)
                if res:
                    return res
        return ""

    def _has_ad_badge(obj: Any) -> bool:
        if isinstance(obj, dict):
            if "adBadgeViewModel" in obj or "adSlotRenderer" in obj:
                return True
            return any(_has_ad_badge(v) for v in obj.values())
        if isinstance(obj, list):
            return any(_has_ad_badge(el) for el in obj)
        return False

    def _walk(node: Any) -> None:
        if len(results) >= limit:
            return
        if isinstance(node, list):
            for el in node:
                _walk(el)
            return
        if not isinstance(node, dict):
            return
        if (
            "adSlotRenderer" in node
            or "inFeedAdLayoutRenderer" in node
            or "adBadgeViewModel" in node
        ):
            return

        if "lockupViewModel" in node and isinstance(node["lockupViewModel"], dict):
            vm = node["lockupViewModel"]
            ctype = vm.get("contentType") or ""
            vid = vm.get("contentId") or _find_watch_video_id(vm)
            if ctype not in (
                "LOCKUP_CONTENT_TYPE_SHORT",
                "LOCKUP_CONTENT_TYPE_CHANNEL",
                "LOCKUP_CONTENT_TYPE_PLAYLIST",
                "LOCKUP_CONTENT_TYPE_ALBUM",
            ) and not _has_ad_badge(vm):
                meta = (vm.get("metadata") or {}).get("lockupMetadataViewModel") or {}
                title = extract_yt_text(meta.get("title"))
                rows = (meta.get("metadata") or {}).get("contentMetadataViewModel", {}).get("metadataRows") or []
                texts: List[str] = []
                for r in rows:
                    for part in r.get("metadataParts") or []:
                        t = extract_yt_text(part.get("text"))
                        if t:
                            texts.append(t)
                channel = texts[0] if texts else "Kênh YouTube"
                views = next((parse_view_count_text(t) for t in texts[1:] if "lượt xem" in t.lower() or "view" in t.lower()), 0)
                dur_text = ""
                for ov in (vm.get("contentImage") or {}).get("thumbnailViewModel", {}).get("overlays") or []:
                    for b in (ov.get("thumbnailBottomOverlayViewModel") or {}).get("badges") or []:
                        tb = (b.get("thumbnailBadgeViewModel") or {}).get("text") or ""
                        if ":" in tb:
                            dur_text = tb
                            break
                _add(build_puretube_item(str(vid), title, channel, duration_text=dur_text, view_count=views))

        if "tileRenderer" in node and isinstance(node["tileRenderer"], dict):
            tr = node["tileRenderer"]
            if not _has_ad_badge(tr):
                vid = tr.get("contentId") or _find_watch_video_id(tr.get("onSelectCommand"))
                tmeta = (tr.get("metadata") or {}).get("tileMetadataRenderer") or {}
                title = extract_yt_text(tmeta.get("title"))
                line_texts: List[str] = []
                for line in tmeta.get("lines") or []:
                    for item in (line.get("lineRenderer") or {}).get("items") or []:
                        txt = extract_yt_text((item.get("lineItemRenderer") or {}).get("text"))
                        if txt and txt not in ("•", "·"):
                            line_texts.append(txt)
                channel = line_texts[0] if line_texts else "Kênh YouTube"
                views = next((parse_view_count_text(t) for t in line_texts if "lượt xem" in t.lower() or "view" in t.lower()), 0)
                dur_text = ""
                for ov in (tr.get("header") or {}).get("tileHeaderRenderer", {}).get("thumbnailOverlays") or []:
                    ts = (ov.get("thumbnailOverlayTimeStatusRenderer") or {}).get("text")
                    if ts:
                        dur_text = extract_yt_text(ts)
                        break
                _add(build_puretube_item(str(vid), title, channel, duration_text=dur_text, view_count=views))

        for rk in ("videoRenderer", "compactVideoRenderer", "gridVideoRenderer", "playlistVideoRenderer"):
            if rk in node and isinstance(node[rk], dict):
                vr = node[rk]
                vid = vr.get("videoId") or ""
                title = extract_yt_text(vr.get("title"))
                channel = extract_yt_text(vr.get("ownerText") or vr.get("shortBylineText") or vr.get("longBylineText"))
                dur_text = extract_yt_text(vr.get("lengthText"))
                views = parse_view_count_text(extract_yt_text(vr.get("viewCountText") or vr.get("shortViewCountText")))
                _add(build_puretube_item(str(vid), title, channel, duration_text=dur_text, view_count=views))

        for v in node.values():
            _walk(v)

    _walk(payload)
    return results


WEB_INNERTUBE_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36"
TV_INNERTUBE_UA = "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version"


async def innertube_web_post(endpoint: str, body: Dict[str, Any]) -> Dict[str, Any]:
    """Send an unauthenticated YouTube WEB InnerTube request with cached visitorData."""
    vd = await asyncio.to_thread(get_visitor_data_sync)
    payload = dict(body)
    ctx_client = {"clientName": "WEB", "clientVersion": "2.20250312.04.00", "hl": "vi", "gl": "VN"}
    if vd:
        ctx_client["visitorData"] = vd
    payload["context"] = {"client": ctx_client}
    headers = {"User-Agent": WEB_INNERTUBE_UA, "Content-Type": "application/json"}
    if vd:
        headers["X-Goog-Visitor-Id"] = vd
    async with httpx.AsyncClient(timeout=12.0) as client:
        resp = await client.post(
            f"https://www.youtube.com/youtubei/v1/{endpoint}?prettyPrint=false",
            headers=headers,
            json=payload,
        )
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"YouTube phản hồi lỗi ({resp.status_code}).")
    return resp.json()


async def innertube_tv_post(endpoint: str, body: Dict[str, Any]) -> Dict[str, Any]:
    """Send an OAuth-authenticated TVHTML5 InnerTube request (auto-refreshing expired tokens)."""
    token = await get_valid_oauth_token()
    if not token:
        raise HTTPException(status_code=401, detail="Vui lòng đăng nhập Tài khoản Google để dùng tính năng này.")
    payload = dict(body)
    payload["context"] = {"client": {"clientName": "TVHTML5", "clientVersion": "7.20250312.14.00", "hl": "vi", "gl": "VN"}}
    async with httpx.AsyncClient(timeout=12.0) as client:
        resp = await client.post(
            f"https://www.youtube.com/youtubei/v1/{endpoint}?prettyPrint=false",
            headers={"Authorization": f"Bearer {token}", "User-Agent": TV_INNERTUBE_UA, "Content-Type": "application/json"},
            json=payload,
        )
        if resp.status_code == 401:
            token = await get_valid_oauth_token(force_refresh=True) or token
            resp = await client.post(
                f"https://www.youtube.com/youtubei/v1/{endpoint}?prettyPrint=false",
                headers={"Authorization": f"Bearer {token}", "User-Agent": TV_INNERTUBE_UA, "Content-Type": "application/json"},
                json=payload,
            )
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"YouTube từ chối thao tác ({resp.status_code}).")
    return resp.json()


def extract_shorts_from_innertube(payload: Any, limit: int = 30) -> List[Dict[str, Any]]:
    """Extract Shorts vertical video items (shortsLockupViewModel / reelItemRenderer) cleanly."""
    results: List[Dict[str, Any]] = []
    seen: set = set()

    def _add_short(vid: str, title: str, channel: str = "YouTube Shorts", view_text: str = "") -> None:
        if not vid or not re.fullmatch(r"[A-Za-z0-9_-]{11}", vid) or vid in seen or len(results) >= limit:
            return
        seen.add(vid)
        results.append(
            {
                "id": vid,
                "title": title or "YouTube Short",
                "channel": channel or "YouTube Shorts",
                "channel_id": "",
                "duration": 60,
                "duration_text": "Short",
                "view_count": parse_view_count_text(view_text),
                "is_short": True,
                "thumbnail": f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
            }
        )

    def _walk(node: Any) -> None:
        if len(results) >= limit:
            return
        if isinstance(node, list):
            for el in node:
                _walk(el)
            return
        if not isinstance(node, dict):
            return

        if "shortsLockupViewModel" in node and isinstance(node["shortsLockupViewModel"], dict):
            vm = node["shortsLockupViewModel"]
            vid = (vm.get("onTap") or {}).get("innertubeCommand", {}).get("reelWatchEndpoint", {}).get("videoId") or ""
            acc = str(vm.get("accessibilityText") or "").split("– phát video")[0].strip()
            _add_short(str(vid), acc or "YouTube Short", "YouTube Shorts", acc)

        if "reelItemRenderer" in node and isinstance(node["reelItemRenderer"], dict):
            rr = node["reelItemRenderer"]
            vid = rr.get("videoId") or ""
            title = extract_yt_text(rr.get("headline"))
            vtxt = extract_yt_text(rr.get("viewCountText"))
            _add_short(str(vid), title, "YouTube Shorts", vtxt)

        if "lockupViewModel" in node and isinstance(node["lockupViewModel"], dict):
            vm = node["lockupViewModel"]
            if vm.get("contentType") == "LOCKUP_CONTENT_TYPE_SHORT":
                vid = vm.get("contentId") or ""
                title = extract_yt_text((vm.get("metadata") or {}).get("lockupMetadataViewModel", {}).get("title"))
                _add_short(str(vid), title)

        for v in node.values():
            _walk(v)

    _walk(payload)
    return results


def parse_comments_payload(data: Dict[str, Any]) -> Dict[str, Any]:
    """Parse YouTube WEB /next comment mutations & continuation tokens cleanly."""
    mutations = (data.get("frameworkUpdates") or {}).get("entityBatchUpdate", {}).get("mutations") or []
    comments: List[Dict[str, Any]] = []
    comment_map: Dict[str, Dict[str, Any]] = {}
    for mut in mutations:
        cep = (mut.get("payload") or {}).get("commentEntityPayload")
        if not cep:
            continue
        props = cep.get("properties") or {}
        cid = props.get("commentId") or ""
        if not cid:
            continue
        author = cep.get("author") or {}
        toolbar = cep.get("toolbar") or {}
        entry = {
            "id": cid,
            "author": author.get("displayName") or "Người xem",
            "author_channel_id": author.get("channelId") or "",
            "avatar": author.get("avatarThumbnailUrl") or "",
            "is_creator": bool(author.get("isCreator")),
            "text": (props.get("content") or {}).get("content") or "",
            "published": props.get("publishedTime") or "",
            "likes": str(toolbar.get("likeCountNotliked") or "").strip(),
            "reply_count": str(toolbar.get("replyCount") or "").strip(),
            "hearted": bool(toolbar.get("heartActiveTooltip")),
            "reply_token": "",
        }
        comments.append(entry)
        comment_map[cid] = entry

    next_token = ""

    def _walk_eps(node: Any) -> None:
        nonlocal next_token
        if isinstance(node, list):
            for el in node:
                _walk_eps(el)
            return
        if not isinstance(node, dict):
            return
        if "commentThreadRenderer" in node and isinstance(node["commentThreadRenderer"], dict):
            ct = node["commentThreadRenderer"]
            ckey = ((ct.get("commentViewModel") or {}).get("commentViewModel") or {}).get("commentId") or ""
            rep_contents = (ct.get("replies") or {}).get("commentRepliesRenderer", {}).get("contents") or []
            for rc in rep_contents:
                tok = (rc.get("continuationItemRenderer") or {}).get("continuationEndpoint", {}).get("continuationCommand", {}).get("token") or ""
                if tok:
                    if ckey and ckey in comment_map:
                        comment_map[ckey]["reply_token"] = tok
                    elif comments:
                        # fallback match via commentId prefix in thread
                        pass
            if not (ckey and ckey in comment_map):
                raw_s = json.dumps(ct)
                m_rep = re.search(r'"commentRepliesRenderer".*?"token"\s*:\s*"([^"]+)"', raw_s)
                if m_rep:
                    for c in comments:
                        if c["id"] in raw_s and not c["reply_token"]:
                            c["reply_token"] = m_rep.group(1)
                            break
        if "continuationItemRenderer" in node and not next_token:
            ci = node["continuationItemRenderer"]
            tok = (
                (ci.get("continuationEndpoint") or {}).get("continuationCommand", {}).get("token")
                or (ci.get("button") or {}).get("buttonRenderer", {}).get("command", {}).get("continuationCommand", {}).get("token")
                or ""
            )
            if tok:
                next_token = tok
        for k, v in node.items():
            if k not in ("commentThreadRenderer",):
                _walk_eps(v)

    _walk_eps(data.get("onResponseReceivedEndpoints") or [])
    return {"comments": comments, "next_continuation": next_token}


def extract_playlists_from_innertube(payload: Any) -> List[Dict[str, Any]]:
    """Extract YouTube playlist entries cleanly from browse / FElibrary responses."""
    results: List[Dict[str, Any]] = []
    seen: set = set()

    def _walk(node: Any) -> None:
        if isinstance(node, list):
            for el in node:
                _walk(el)
            return
        if not isinstance(node, dict):
            return

        if "playlistAddToOptionRenderer" in node and isinstance(node["playlistAddToOptionRenderer"], dict):
            opt = node["playlistAddToOptionRenderer"]
            pid = opt.get("playlistId") or ""
            title = extract_yt_text(opt.get("title"))
            if pid and pid not in seen:
                seen.add(pid)
                results.append(
                    {
                        "id": pid,
                        "title": title or pid,
                        "privacy": str(opt.get("privacy") or ""),
                        "contains_selected": str(opt.get("containsSelectedVideos") or "") == "ALL",
                        "count_text": "",
                        "thumbnail": "",
                    }
                )

        if "lockupViewModel" in node and isinstance(node["lockupViewModel"], dict):
            vm = node["lockupViewModel"]
            if vm.get("contentType") in ("LOCKUP_CONTENT_TYPE_PLAYLIST", "LOCKUP_CONTENT_TYPE_ALBUM"):
                pid = vm.get("contentId") or ""
                title = extract_yt_text((vm.get("metadata") or {}).get("lockupMetadataViewModel", {}).get("title"))
                if pid and pid not in seen:
                    seen.add(pid)
                    results.append({"id": pid, "title": title or pid, "privacy": "", "contains_selected": False, "count_text": "", "thumbnail": ""})

        for pk in ("gridPlaylistRenderer", "playlistRenderer", "compactPlaylistRenderer"):
            if pk in node and isinstance(node[pk], dict):
                pr = node[pk]
                pid = pr.get("playlistId") or ""
                title = extract_yt_text(pr.get("title"))
                cnt = extract_yt_text(pr.get("videoCountText") or pr.get("videoCountShortText"))
                thumbs = (pr.get("thumbnail") or {}).get("thumbnails") or []
                if not thumbs and pr.get("thumbnails"):
                    thumbs = (pr["thumbnails"][0] or {}).get("thumbnails") or []
                turl = thumbs[-1].get("url") if thumbs else ""
                if pid and pid not in seen:
                    seen.add(pid)
                    results.append({"id": pid, "title": title or pid, "privacy": "", "contains_selected": False, "count_text": cnt, "thumbnail": turl})

        for v in node.values():
            _walk(v)

    _walk(payload)
    return results


async def fetch_video_next_meta(video_id: str) -> Dict[str, Any]:
    """Fetch comments token, channel avatar, subscriber count, like count, and related videos from WEB /next."""
    try:
        data = await innertube_web_post("next", {"videoId": video_id})
    except Exception:
        return {}

    raw_s = json.dumps(data, ensure_ascii=False)
    ch_match = re.search(r'"channelId"\s*:\s*"(UC[A-Za-z0-9_-]{22})"', raw_s)
    sub_match = re.search(r'"subscriberCountText"\s*:\s*\{\s*"accessibility"\s*:\s*\{\s*"accessibilityData"\s*:\s*\{\s*"label"\s*:\s*"([^"]+)"', raw_s)
    like_match = (
        re.search(r'"iconName"\s*:\s*"LIKE"\s*,\s*"title"\s*:\s*"([^"]+)"', raw_s)
        or re.search(r'"accessibilityText"\s*:\s*"[^"]*?([\d.,]+\s*[NTKMBtr]*)\s*(?:người khác thích|lượt thích|likes?)"', raw_s, re.I)
    )
    avatar_match = re.search(r'"videoOwnerRenderer".*?"url"\s*:\s*"(https://yt3\.[^"]+)"', raw_s)
    cmt_count_match = re.search(r'"commentsHeaderRenderer".*?"countText"\s*:\s*\{[^}]*?"(?:simpleText|text)"\s*:\s*"([^"]+)"', raw_s)
    cmt_token = ""
    for p in data.get("engagementPanels", []) or []:
        ps = json.dumps(p)
        if "engagement-panel-comments-section" in ps:
            m = re.search(r'"token"\s*:\s*"([^"]+)"', ps)
            if m:
                cmt_token = m.group(1)
                break

    related = [item for item in extract_videos_from_innertube(data, limit=14) if item["id"] != video_id][:8]
    return {
        "channel_id": ch_match.group(1) if ch_match else "",
        "subscriber_count_text": sub_match.group(1) if sub_match else "",
        "like_count_text": like_match.group(1).strip() if like_match else "",
        "channel_avatar": avatar_match.group(1) if avatar_match else "",
        "comment_count_text": cmt_count_match.group(1) if cmt_count_match else "",
        "comments_token": cmt_token,
        "related": related,
    }


async def fetch_innertube_browse_videos(browse_id: str, limit: int = 36) -> List[Dict[str, Any]]:
    """Fetch personalized YouTube feeds (FEhistory / FEsubscriptions) using OAuth2 token."""
    token = await get_valid_oauth_token()
    if not token:
        raise HTTPException(status_code=401, detail="Chưa có phiên đăng nhập OAuth hợp lệ.")

    clients_to_try = [
        ("TVHTML5", "7.20250312.16.00", "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version"),
        ("WEB", "2.20250312.04.00", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36"),
    ]
    async with httpx.AsyncClient(timeout=12.0) as client:
        for cname, cver, ua in clients_to_try:
            resp = await client.post(
                "https://www.youtube.com/youtubei/v1/browse?prettyPrint=false",
                headers={"Authorization": f"Bearer {token}", "User-Agent": ua},
                json={
                    "context": {"client": {"clientName": cname, "clientVersion": cver, "hl": "vi", "gl": "VN"}},
                    "browseId": browse_id,
                },
            )
            if resp.status_code == 401:
                token = await get_valid_oauth_token(force_refresh=True) or token
                resp = await client.post(
                    "https://www.youtube.com/youtubei/v1/browse?prettyPrint=false",
                    headers={"Authorization": f"Bearer {token}", "User-Agent": ua},
                    json={
                        "context": {"client": {"clientName": cname, "clientVersion": cver, "hl": "vi", "gl": "VN"}},
                        "browseId": browse_id,
                    },
                )
            if resp.status_code == 200:
                items = extract_videos_from_innertube(resp.json(), limit=limit)
                if items:
                    return items
    return []


async def sync_watch_to_youtube_history(video_id: str) -> None:
    """Sync watched video back to signed-in YouTube watch history (OAuth2 or Cookies)."""
    token = await get_valid_oauth_token()
    if token:
        try:
            headers = {
                "Authorization": f"Bearer {token}",
                "User-Agent": "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version",
            }
            async with httpx.AsyncClient(timeout=8.0) as client:
                player_resp = await client.post(
                    "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
                    headers=headers,
                    json={
                        "context": {
                            "client": {
                                "clientName": "TVHTML5",
                                "clientVersion": "7.20250312.16.00",
                                "hl": "vi",
                                "gl": "VN",
                            }
                        },
                        "videoId": video_id,
                    },
                )
                pdata = player_resp.json()
                base_url = (
                    pdata.get("playbackTracking", {})
                    .get("videostatsPlaybackUrl", {})
                    .get("baseUrl")
                )
                if base_url:
                    if not base_url.startswith("http"):
                        base_url = "https://www.youtube.com" + base_url
                    sep = "&" if "?" in base_url else "?"
                    length_s = pdata.get("videoDetails", {}).get("lengthSeconds", "60")
                    ping_url = f"{base_url}{sep}cpn=PureTubePlay123&ver=2&cmt=0&len={length_s}"
                    await client.get(ping_url, headers=headers)
            return
        except Exception:
            pass
    if has_cookies_file():
        await asyncio.to_thread(mark_video_watched_sync, video_id)


async def detect_youtube_account_name(access_token: Optional[str] = None) -> str:
    """Read signed-in YouTube channel/account name via OAuth2 InnerTube or saved cookies."""
    token = access_token or await get_valid_oauth_token()
    if token:
        try:
            async with httpx.AsyncClient(timeout=8.0) as client:
                resp = await client.post(
                    "https://www.youtube.com/youtubei/v1/account/account_menu?prettyPrint=false",
                    headers={
                        "Authorization": f"Bearer {token}",
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
                    },
                    json={
                        "context": {
                            "client": {
                                "clientName": "WEB",
                                "clientVersion": "2.20250312.04.00",
                                "hl": "vi",
                                "gl": "VN",
                            }
                        }
                    },
                )
                if resp.status_code == 200:
                    text = resp.text
                    m = (
                        re.search(r'"accountName"\s*:\s*\{\s*"simpleText"\s*:\s*"([^"]+)"', text)
                        or re.search(r'"channelHandle"\s*:\s*\{\s*"simpleText"\s*:\s*"([^"]+)"', text)
                    )
                    if m:
                        return m.group(1)
        except Exception:
            pass
        return "Tài khoản Google (YouTube)"

    if not has_cookies_file():
        return "Tài khoản Google"
    try:
        cookie_pairs = {}
        for line in COOKIES_FILE.read_text(encoding="utf-8", errors="ignore").splitlines():
            if not line or line.startswith("#"):
                continue
            parts = line.split("\t")
            if len(parts) >= 7:
                cookie_pairs[parts[5]] = parts[6]
        async with httpx.AsyncClient(timeout=6.0, follow_redirects=True) as client:
            resp = await client.get(
                "https://www.youtube.com/feed/you",
                cookies=cookie_pairs,
                headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36"},
            )
            m = re.search(r'"channelName"\s*:\s*"([^"]+)"', resp.text) or re.search(
                r'"title"\s*:\s*"([^"]+)"\s*,\s*"avatar"', resp.text
            )
            if m:
                return m.group(1)
    except Exception:
        pass
    return "Tài khoản Google (YouTube)"


@app.get("/api/info")
async def api_info(request: Request) -> Dict[str, Any]:
    """Return server LAN/Cloud info and capability flags for mobile QR pairing."""
    local_ip = get_local_ip()
    req_base = str(request.base_url).rstrip("/")
    is_local_req = local_ip in req_base or "localhost" in req_base or "127.0.0.1" in req_base
    cloud_mode = IS_CLOUD_ENV or (not is_local_req and req_base.startswith("https://"))
    return {
        "ip": local_ip,
        "port": PORT,
        "lan_url": req_base if cloud_mode else f"http://{local_ip}:{PORT}",
        "public_url": req_base,
        "server_mode": "cloud" if cloud_mode else "lan",
        "yt_dlp_version": getattr(yt_dlp.version, "__version__", "unknown"),
        "ffmpeg_available": bool(shutil.which("ffmpeg")),
    }


@app.get("/api/mobile-packages")
async def api_mobile_packages() -> Dict[str, Any]:
    """Return available standalone APK/IPA reference packages on this PC for Wi-Fi QR transfer."""
    packages: List[Dict[str, Any]] = []
    for pkg_id, meta in REFERENCE_MOBILE_PACKAGES.items():
        path: Path = meta["path"]
        if path.exists() and path.is_file():
            size_mb = round(path.stat().st_size / (1024 * 1024), 1)
            packages.append(
                {
                    "id": pkg_id,
                    "platform": meta["platform"],
                    "name": meta["name"],
                    "version": meta["version"],
                    "filename": meta["filename"],
                    "size_mb": size_mb,
                    "note": meta["note"],
                    "download_path": f"/api/mobile-packages/download/{pkg_id}",
                }
            )
    return {
        "packages": packages,
        "has_reference_apps": len(packages) > 0,
        "capacitor_project_ready": (BASE_DIR / "mobile" / "capacitor.config.json").exists(),
    }


@app.get("/api/mobile-packages/download/{pkg_id}")
async def api_download_mobile_package(pkg_id: str) -> FileResponse:
    """Stream strictly whitelisted standalone reference APK/IPA files over LAN/Wi-Fi."""
    meta = REFERENCE_MOBILE_PACKAGES.get(pkg_id)
    if not meta:
        raise HTTPException(status_code=404, detail="Không tìm thấy gói ứng dụng hợp lệ.")
    path: Path = meta["path"]
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="Tệp cài đặt không tồn tại trên máy chủ này.")
    return FileResponse(
        path=str(path),
        filename=meta["filename"],
        media_type=meta["media_type"],
    )


@app.get("/api/qr.svg")
async def api_qr_svg(text: str = Query(..., min_length=1, max_length=1024)) -> Response:
    """Generate a crisp SVG QR code on-demand without external services."""
    qr = segno.make(text, error="m")
    buf = io.BytesIO()
    qr.save(buf, kind="svg", scale=6, border=2, dark="#0B0C10", light="#FFFFFF")
    return Response(content=buf.getvalue(), media_type="image/svg+xml")


@app.get("/api/auth/status")
async def api_auth_status() -> Dict[str, Any]:
    """Return current Google/YouTube authentication status."""
    return read_auth_state()


async def poll_or_complete_device_flow() -> Dict[str, Any]:
    """Poll YouTube OAuth2 device token endpoint and persist credentials once approved."""
    if not PENDING_DEVICE_FLOW.get("device_code"):
        return {
            "status": "none",
            "logged_in": False,
            "message": "Chưa tạo mã kết nối Google. Hãy bấm 'Lấy mã kết nối Google'.",
        }

    if time.time() > float(PENDING_DEVICE_FLOW.get("expires_at") or 0):
        PENDING_DEVICE_FLOW.clear()
        return {
            "status": "expired",
            "logged_in": False,
            "message": "Mã kết nối đã hết hạn. Vui lòng bấm 'Lấy mã mới'.",
        }

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                "https://www.youtube.com/o/oauth2/token",
                data={
                    "client_id": YT_TV_CLIENT_ID,
                    "client_secret": YT_TV_CLIENT_SECRET,
                    "code": PENDING_DEVICE_FLOW["device_code"],
                    "grant_type": "http://oauth.net/grant_type/device/1.0",
                },
            )
        token_data = resp.json()
    except Exception as exc:
        return {
            "status": "waiting",
            "logged_in": False,
            "user_code": PENDING_DEVICE_FLOW.get("user_code", ""),
            "verification_url": PENDING_DEVICE_FLOW.get("verification_url", "https://www.google.com/device"),
            "message": f"Đang kiểm tra xác nhận từ Google ({exc})...",
        }

    if token_data.get("access_token"):
        save_payload = {
            "access_token": token_data["access_token"],
            "refresh_token": token_data.get("refresh_token") or "",
            "token_type": token_data.get("token_type") or "Bearer",
            "scope": token_data.get("scope") or "",
            "expires_at": time.time() + int(token_data.get("expires_in", 3600)),
        }
        OAUTH_TOKEN_FILE.write_text(
            json.dumps(save_payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        PENDING_DEVICE_FLOW.clear()
        account_name = await detect_youtube_account_name(save_payload["access_token"])
        write_auth_state(account_name, "google_oauth")
        clear_youtube_caches()
        return {
            "status": "completed",
            "logged_in": True,
            "account_name": account_name,
        }

    err = token_data.get("error") or ""
    if err in ("authorization_pending", "slow_down"):
        return {
            "status": "waiting",
            "logged_in": False,
            "user_code": PENDING_DEVICE_FLOW.get("user_code", ""),
            "verification_url": PENDING_DEVICE_FLOW.get("verification_url", "https://www.google.com/device"),
            "message": "Đang chờ bạn nhập mã & bấm Cho phép trên trang Google...",
        }

    PENDING_DEVICE_FLOW.clear()
    return {
        "status": "expired",
        "logged_in": False,
        "message": "Mã kết nối đã hết hạn hoặc bị từ chối. Vui lòng bấm 'Lấy mã mới'.",
    }


@app.post("/api/auth/launch-login")
async def api_auth_launch_login() -> Dict[str, Any]:
    """Request a Google OAuth2 device code so the user signs in directly inside their browser tab."""
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                "https://www.youtube.com/o/oauth2/device/code",
                data={
                    "client_id": YT_TV_CLIENT_ID,
                    "scope": "http://gdata.youtube.com https://www.googleapis.com/auth/youtube-paid-content",
                    "device_id": str(uuid.uuid4()),
                    "device_model": "PureTube",
                },
                headers={"User-Agent": "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version"},
            )
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Không kết nối được tới máy chủ xác thực Google: {exc}",
        ) from exc

    if resp.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"Máy chủ Google từ chối cấp mã đăng nhập ({resp.status_code}).",
        )

    data = resp.json()
    user_code = data.get("user_code") or ""
    device_code = data.get("device_code") or ""
    verification_url = data.get("verification_url") or "https://www.google.com/device"
    expires_in = int(data.get("expires_in") or 1800)
    interval = max(3, int(data.get("interval") or 5))

    if not user_code or not device_code:
        raise HTTPException(status_code=502, detail="Google không trả về mã xác nhận hợp lệ.")

    PENDING_DEVICE_FLOW.clear()
    PENDING_DEVICE_FLOW.update(
        {
            "device_code": device_code,
            "user_code": user_code,
            "verification_url": verification_url,
            "expires_at": time.time() + expires_in,
            "interval": interval,
        }
    )

    return {
        "status": "device_code",
        "user_code": user_code,
        "verification_url": verification_url,
        "expires_in": expires_in,
        "interval": interval,
        "message": f"Mã kết nối của bạn là {user_code}. Hãy bấm mở trang Google và nhập mã này.",
    }


@app.get("/api/auth/poll-login")
async def api_auth_poll_login() -> Dict[str, Any]:
    """Non-throwing poll endpoint so the UI auto-detects when Google OAuth2 approval finishes."""
    return await poll_or_complete_device_flow()


@app.post("/api/auth/complete-login")
async def api_auth_complete_login() -> Dict[str, Any]:
    """Manually check Google OAuth2 device authorization status."""
    result = await poll_or_complete_device_flow()
    if result["status"] == "completed":
        return result
    raise HTTPException(
        status_code=400,
        detail=result.get("message") or "Bạn chưa bấm Cho phép trên trang Google.",
    )


@app.post("/api/auth/import-browser")
async def api_auth_import_browser(payload: Dict[str, str] = Body(default={})) -> Dict[str, Any]:
    """Import YouTube cookies from local browser profile (works natively for Firefox or closed browsers)."""
    browser = (payload.get("browser") or "auto").lower()
    candidates = [browser] if browser != "auto" else ["firefox", "chrome", "edge", "brave"]

    last_err = ""
    locked_detected = False
    for br in candidates:
        try:
            jar = await asyncio.to_thread(yt_dlp.cookies.extract_cookies_from_browser, br)
            cookies_list = [
                {
                    "domain": c.domain,
                    "name": c.name,
                    "value": c.value,
                    "path": c.path,
                    "secure": bool(c.secure),
                    "expires": c.expires,
                }
                for c in jar
            ]
            ok, count = write_netscape_cookies_from_dicts(cookies_list)
            if ok:
                account_name = await detect_youtube_account_name()
                write_auth_state(account_name, f"browser:{br}")
                clear_youtube_caches()
                return {
                    "logged_in": True,
                    "account_name": account_name,
                    "browser": br,
                    "cookie_count": count,
                }
            last_err = f"Trình duyệt {br} chưa đăng nhập YouTube."
        except Exception as exc:
            err_str = str(exc)
            if "Could not copy Chrome cookie database" in err_str:
                locked_detected = True
                last_err = f"Trình duyệt {br.capitalize()} đang mở nên Windows khóa tệp Cookie."
            elif "could not find" in err_str.lower():
                last_err = f"Máy không cài {br.capitalize()}."
            else:
                last_err = err_str

    if locked_detected:
        detail = (
            "Chrome/Edge trên Windows đang khóa bảo mật tệp Cookie nên không cho phép đọc trực tiếp. "
            "Hãy dùng Cách 1 (Mã kết nối Google) ngay phía trên — hoạt động 100% và không cần đóng trình duyệt!"
        )
    else:
        detail = f"Không lấy được cookie ({last_err}). Hãy dùng Cách 1 (Mã kết nối Google) ngay phía trên."
    raise HTTPException(status_code=400, detail=detail)


@app.post("/api/auth/save-cookies")
async def api_auth_save_cookies(payload: Dict[str, str] = Body(...)) -> Dict[str, Any]:
    """Save pasted cookies (Netscape cookies.txt, JSON export, or raw Cookie header)."""
    raw_text = (payload.get("cookies_text") or "").strip()
    if not raw_text:
        raise HTTPException(status_code=400, detail="Nội dung cookie đang trống.")

    ok = False
    count = 0
    if raw_text.startswith("[") or raw_text.startswith("{"):
        try:
            parsed = json.loads(raw_text)
            if isinstance(parsed, dict) and "cookies" in parsed:
                parsed = parsed["cookies"]
            if isinstance(parsed, list):
                ok, count = write_netscape_cookies_from_dicts(parsed)
        except Exception:
            pass
    elif "\t" in raw_text and ("youtube.com" in raw_text or "google.com" in raw_text):
        COOKIES_FILE.write_text(raw_text + "\n", encoding="utf-8")
        ok = any(k in raw_text for k in ("SAPISID", "__Secure-1PSID", "LOGIN_INFO", "SID"))
        count = len([l for l in raw_text.splitlines() if l and not l.startswith("#")])
    else:
        # Raw Cookie header string: "KEY1=VAL1; KEY2=VAL2"
        pairs = []
        for part in raw_text.split(";"):
            if "=" in part:
                k, v = part.strip().split("=", 1)
                pairs.append({"domain": ".youtube.com", "name": k.strip(), "value": v.strip(), "path": "/", "secure": True})
        ok, count = write_netscape_cookies_from_dicts(pairs)

    if not ok:
        if COOKIES_FILE.exists():
            COOKIES_FILE.unlink(missing_ok=True)
        raise HTTPException(
            status_code=400,
            detail="Chuỗi cookie không chứa phiên đăng nhập YouTube hợp lệ (thiếu SAPISID / __Secure-1PSID).",
        )

    account_name = await detect_youtube_account_name()
    write_auth_state(account_name, "manual_cookies")
    clear_youtube_caches()
    return {"logged_in": True, "account_name": account_name, "cookie_count": count}


async def fetch_authenticated_feed(
    browse_id: str,
    feed_url: str,
    cache_key: str,
    cache_ttl: int,
    limit: int,
    err_label: str,
) -> Dict[str, Any]:
    """Shared fetcher for personalized YouTube feeds using OAuth2 or saved cookies."""
    if not (has_oauth_token() or has_cookies_file()):
        raise HTTPException(status_code=401, detail="Bạn chưa đăng nhập tài khoản Google/YouTube.")

    cached = SEARCH_CACHE.get(cache_key)
    if cached and cached["expires_at"] > time.time():
        return {"items": cached["items"]}

    items: List[Dict[str, Any]] = []
    if has_oauth_token():
        try:
            items = await fetch_innertube_browse_videos(browse_id, limit=limit)
            SEARCH_CACHE[cache_key] = {"expires_at": time.time() + cache_ttl, "items": items}
            return {"items": items}
        except HTTPException:
            if not has_cookies_file():
                raise
        except Exception as exc:
            if not has_cookies_file():
                raise HTTPException(status_code=502, detail=f"{err_label}: {exc}") from exc

    try:
        ydl_opts = {
            "extract_flat": "in_playlist",
            "playlistend": limit,
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "ignoreerrors": True,
            **get_ytdlp_cookie_opts(),
        }
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = await asyncio.to_thread(ydl.extract_info, feed_url, False)
            for entry in (info or {}).get("entries") or []:
                item = normalize_flat_entry(entry)
                if item:
                    items.append(item)
        SEARCH_CACHE[cache_key] = {"expires_at": time.time() + cache_ttl, "items": items}
        return {"items": items}
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"{err_label} (phiên đăng nhập có thể đã hết hạn): {exc}",
        ) from exc


@app.post("/api/auth/logout")
async def api_auth_logout() -> Dict[str, Any]:
    """Remove saved Google/YouTube OAuth tokens and cookies."""
    PENDING_DEVICE_FLOW.clear()
    OAUTH_TOKEN_FILE.unlink(missing_ok=True)
    COOKIES_FILE.unlink(missing_ok=True)
    AUTH_STATE_FILE.unlink(missing_ok=True)
    clear_youtube_caches()
    return {"logged_in": False}


@app.get("/api/youtube/history")
async def api_youtube_history() -> Dict[str, Any]:
    """Fetch user's real YouTube watch history using OAuth2 token or cookies."""
    return await fetch_authenticated_feed(
        browse_id="FEhistory",
        feed_url="https://www.youtube.com/feed/history",
        cache_key="yt_history",
        cache_ttl=120,
        limit=36,
        err_label="Không thể đồng bộ lịch sử YouTube",
    )


@app.get("/api/youtube/subscriptions")
async def api_youtube_subscriptions() -> Dict[str, Any]:
    """Fetch recent videos from user's signed-in YouTube subscriptions feed."""
    return await fetch_authenticated_feed(
        browse_id="FEsubscriptions",
        feed_url="https://www.youtube.com/feed/subscriptions",
        cache_key="yt_subs",
        cache_ttl=180,
        limit=28,
        err_label="Không thể đồng bộ kênh đăng ký YouTube",
    )


@app.get("/api/trending")
async def api_trending(category: str = Query("all")) -> Dict[str, Any]:
    """Return personalized YouTube Home feed (when signed in) or trending videos by category."""
    cat = category if category in TRENDING_QUERIES else "all"
    if cat == "all" and has_oauth_token():
        cache_key = "yt_home_all"
        cached = SEARCH_CACHE.get(cache_key)
        if cached and cached["expires_at"] > time.time():
            return {"category": cat, "personalized": True, "items": cached["items"]}
        try:
            items = await fetch_innertube_browse_videos("FEwhat_to_watch", limit=32)
            if items:
                SEARCH_CACHE[cache_key] = {"expires_at": time.time() + 180, "items": items}
                return {"category": cat, "personalized": True, "items": items}
        except Exception:
            pass

    cache_key = f"trending:{cat}"
    cached = SEARCH_CACHE.get(cache_key)
    if cached and cached["expires_at"] > time.time():
        return {"category": cat, "personalized": False, "items": cached["items"]}

    items = await asyncio.to_thread(run_flat_search_sync, TRENDING_QUERIES[cat], False)
    SEARCH_CACHE[cache_key] = {
        "expires_at": time.time() + SEARCH_CACHE_TTL,
        "items": items,
    }
    return {"category": cat, "personalized": False, "items": items}


@app.get("/api/shorts")
async def api_shorts(q: str = Query("")) -> Dict[str, Any]:
    """Return clean vertical YouTube Shorts feed."""
    clean_q = q.strip()
    queries = [clean_q] if clean_q else ["#shorts", "shorts hài hước việt nam"]
    cache_key = f"shorts:{clean_q.lower() or '__default__'}"
    cached = SEARCH_CACHE.get(cache_key)
    if cached and cached["expires_at"] > time.time():
        return {"items": cached["items"]}
    items: List[Dict[str, Any]] = []
    seen: set = set()
    for query in queries:
        try:
            data = await innertube_web_post("search", {"query": query})
            batch = extract_shorts_from_innertube(data, limit=30)
            # Also collect standalone Shorts renderers whose videoRenderer embeds reelWatchEndpoint
            for extra in extract_videos_from_innertube(data, limit=40):
                if extra.get("is_short") and extra.get("id"):
                    batch.append(extra)
            for it in batch:
                vid = it.get("id")
                if vid and vid not in seen:
                    seen.add(vid)
                    it["is_short"] = True
                    items.append(it)
        except Exception:
            pass
        if len(items) >= 24:
            break
    items = items[:24]
    SEARCH_CACHE[cache_key] = {"expires_at": time.time() + 300, "items": items}
    return {"items": items}


@app.get("/api/search")
async def api_search(
    q: str = Query(..., min_length=1),
    limit: int = Query(18, ge=4, le=30),
) -> Dict[str, Any]:
    """Search YouTube videos fast using extract_flat, or resolve direct video URLs."""
    query_clean = q.strip()
    direct_id = extract_video_id_from_text(query_clean)
    if direct_id:
        return {"query": query_clean, "direct_video_id": direct_id, "items": []}

    cache_key = f"search:{query_clean.lower()}:{limit}"
    cached = SEARCH_CACHE.get(cache_key)
    if cached and cached["expires_at"] > time.time():
        return {"query": query_clean, "items": cached["items"]}

    items = await asyncio.to_thread(run_flat_search_sync, f"ytsearch{limit}:{query_clean}", False)
    SEARCH_CACHE[cache_key] = {
        "expires_at": time.time() + SEARCH_CACHE_TTL,
        "items": items,
    }
    return {"query": query_clean, "items": items}


@app.get("/api/suggest")
async def api_suggest(q: str = Query(..., min_length=1)) -> Dict[str, Any]:
    """Proxy YouTube autocomplete suggestions."""
    url = (
        "https://suggestqueries.google.com/complete/search"
        f"?client=firefox&ds=yt&hl=vi&q={urllib.parse.quote(q.strip())}"
    )
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get(url)
            if resp.status_code == 200:
                data = resp.json()
                suggestions = data[1] if isinstance(data, list) and len(data) > 1 else []
                return {"suggestions": suggestions[:8]}
    except Exception:
        pass
    return {"suggestions": []}


CHANNEL_TAB_PARAMS = {
    "videos": "EgZ2aWRlb3PyBgQKAjoA",
    "shorts": "EgZzaG9ydHPyBgUKA5oBAA%3D%3D",
    "live": "EgdzdHJlYW1z8gYECgJ6AA%3D%3D",
    "playlists": "EglwbGF5bGlzdHPyBgoKCEIGCgIQaCIA",
}


@app.post("/api/channel/subscribe")
async def api_channel_subscribe(payload: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """Subscribe or unsubscribe to a real YouTube channel using Google OAuth."""
    channel_id = str(payload.get("channel_id") or "").strip()
    subscribe = bool(payload.get("subscribe", True))
    if not re.fullmatch(r"UC[A-Za-z0-9_-]{22}", channel_id):
        raise HTTPException(status_code=400, detail="Không xác định được ID kênh (UC...) để đồng bộ YouTube.")
    ep = "subscription/subscribe" if subscribe else "subscription/unsubscribe"
    await innertube_tv_post(ep, {"channelIds": [channel_id]})
    SEARCH_CACHE.pop("yt_subs", None)
    return {"subscribed": subscribe, "channel_id": channel_id}


@app.get("/api/channel/{channel_query}")
async def api_channel(channel_query: str, tab: str = Query("videos")) -> Dict[str, Any]:
    """Fetch full channel header + tabbed items (videos/shorts/live/playlists)."""
    decoded = urllib.parse.unquote(channel_query).strip()
    tab_key = tab if tab in CHANNEL_TAB_PARAMS else "videos"
    cache_key = f"channel_v2:{decoded.lower()}:{tab_key}"
    cached = SEARCH_CACHE.get(cache_key)
    if cached and cached["expires_at"] > time.time():
        return cached["data"]

    cid = decoded if re.fullmatch(r"UC[A-Za-z0-9_-]{22}", decoded) else ""
    if not cid:
        try:
            sr = await innertube_web_post("search", {"query": decoded, "params": "EgIQAg%3D%3D"})
            m_cid = re.search(r'"channelId"\s*:\s*"(UC[A-Za-z0-9_-]{22})"', json.dumps(sr))
            if m_cid:
                cid = m_cid.group(1)
        except Exception:
            cid = ""

    result: Dict[str, Any] = {
        "channel": decoded,
        "channel_id": cid or decoded,
        "name": decoded,
        "avatar": "",
        "banner": "",
        "subscribers": "",
        "active_tab": tab_key,
        "items": [],
    }
    if cid:
        try:
            data = await innertube_web_post("browse", {"browseId": cid, "params": CHANNEL_TAB_PARAMS[tab_key]})
            raw_s = json.dumps(data, ensure_ascii=False)
            m_name = (
                re.search(r'"pageHeaderViewModel"\s*:\s*\{\s*"title".*?"content"\s*:\s*"([^"]+)"', raw_s)
                or re.search(r'"c4TabbedHeaderRenderer".*?"title"\s*:\s*"([^"]+)"', raw_s)
            )
            m_sub = re.search(r'(\d[\d.,]*\s*(?:Tr|N|K|M|B)?\s*người đăng ký|[\d.,]+[KMB]?\s*subscribers?)', raw_s, re.I)
            m_av = re.search(r'"avatarViewModel".*?"url"\s*:\s*"(https://yt3\.[^"]+)"', raw_s) or re.search(r'"url"\s*:\s*"(https://yt3\.[^"]+)"', raw_s)
            m_ban = re.search(r'"banner".*?"url"\s*:\s*"(https://yt3\.[^"]+)"', raw_s)
            if m_name:
                result["name"] = m_name.group(1)
            if m_sub:
                result["subscribers"] = m_sub.group(1)
            if m_av:
                result["avatar"] = m_av.group(1)
            if m_ban:
                result["banner"] = m_ban.group(1)

            if tab_key == "shorts":
                result["items"] = extract_shorts_from_innertube(data, limit=30)
            elif tab_key == "playlists":
                result["items"] = extract_playlists_from_innertube(data)
            else:
                result["items"] = extract_videos_from_innertube(data, limit=30)
        except Exception:
            pass

    if not result["items"] and tab_key == "videos":
        result["items"] = await asyncio.to_thread(run_flat_search_sync, f"ytsearch14:{decoded}", False)

    SEARCH_CACHE[cache_key] = {"expires_at": time.time() + SEARCH_CACHE_TTL, "data": result}
    return result


@app.post("/api/prefetch/{video_id}")
async def api_prefetch(video_id: str) -> Dict[str, Any]:
    """Warm up STREAM_CACHE in the background so switching videos feels instant."""
    vid = extract_video_id_from_text(video_id)
    if not vid:
        return {"status": "invalid"}

    cached = STREAM_CACHE.get(vid)
    if cached and cached["expires_at"] > time.time() and "video_data" in cached:
        return {"status": "cached"}
    if vid in PREFETCH_INFLIGHT:
        return {"status": "inflight"}

    async def _bg_extract() -> None:
        PREFETCH_INFLIGHT.add(vid)
        try:
            async with PREFETCH_SEMAPHORE:
                await asyncio.to_thread(extract_video_sync, vid)
        except Exception:
            pass
        finally:
            PREFETCH_INFLIGHT.discard(vid)

    asyncio.create_task(_bg_extract())
    return {"status": "queued"}


@app.get("/api/video/{video_id}")
async def api_video(video_id: str, refresh: bool = Query(False)) -> Dict[str, Any]:
    """Return streamable video/audio formats fast (using cache when prefetched)."""
    vid = extract_video_id_from_text(video_id)
    if not vid:
        raise HTTPException(status_code=400, detail="Video ID không hợp lệ.")

    try:
        video_data = await asyncio.to_thread(extract_video_sync, vid, refresh)
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Không thể lấy luồng phát cho video này: {exc}",
        ) from exc

    # Fire-and-forget watch history sync back to Google account if signed in
    if has_oauth_token() or has_cookies_file():
        asyncio.create_task(sync_watch_to_youtube_history(vid))
        SEARCH_CACHE.pop("yt_history", None)

    return video_data


@app.get("/api/video/{video_id}/extras")
async def api_video_extras(
    video_id: str,
    channel: str = Query(""),
    title: str = Query(""),
) -> Dict[str, Any]:
    """Fetch SponsorBlock segments and related videos asynchronously after playback starts."""
    vid = extract_video_id_from_text(video_id)
    if not vid:
        raise HTTPException(status_code=400, detail="Video ID không hợp lệ.")

    cached_video = (STREAM_CACHE.get(vid) or {}).get("video_data") or {}
    ch = channel or cached_video.get("channel") or ""
    tt = title or cached_video.get("title") or ""
    rel_query = f"{ch} {tt[:42]}".strip() or vid

    async def _get_related() -> List[Dict[str, Any]]:
        rel_cache_key = f"related:{vid}"
        rel_cached = SEARCH_CACHE.get(rel_cache_key)
        if rel_cached and rel_cached["expires_at"] > time.time():
            return rel_cached["items"]
        try:
            raw_related = await asyncio.to_thread(
                run_flat_search_sync, f"ytsearch10:{rel_query}", False
            )
            related = [item for item in raw_related if item["id"] != vid][:8]
            SEARCH_CACHE[rel_cache_key] = {
                "expires_at": time.time() + SEARCH_CACHE_TTL,
                "items": related,
            }
            return related
        except Exception:
            return []

    sponsor_segments, related, next_meta = await asyncio.gather(
        fetch_sponsorblock(vid),
        _get_related(),
        fetch_video_next_meta(vid),
    )
    if not related and next_meta.get("related"):
        related = next_meta["related"]
    return {
        "sponsor_segments": sponsor_segments,
        "related": related,
        "channel_id": next_meta.get("channel_id") or cached_video.get("channel_id") or "",
        "subscriber_count_text": next_meta.get("subscriber_count_text") or "",
        "like_count_text": next_meta.get("like_count_text") or "",
        "channel_avatar": next_meta.get("channel_avatar") or "",
        "comment_count_text": next_meta.get("comment_count_text") or "",
        "comments_token": next_meta.get("comments_token") or "",
    }


@app.get("/api/comments/{video_id}")
async def api_comments(video_id: str, continuation: str = Query("")) -> Dict[str, Any]:
    """Load comments, nested replies, or next comment pages for a YouTube video."""
    vid = extract_video_id_from_text(video_id)
    if not vid:
        raise HTTPException(status_code=400, detail="Video ID không hợp lệ.")
    tok = continuation.strip()
    if not tok:
        meta = await fetch_video_next_meta(vid)
        tok = meta.get("comments_token") or ""
    if not tok:
        return {"comments": [], "next_continuation": ""}
    data = await innertube_web_post("next", {"continuation": tok})
    return parse_comments_payload(data)


@app.post("/api/video/{video_id}/react")
async def api_video_react(video_id: str, payload: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """Like, dislike, or clear reaction on a YouTube video using Google OAuth."""
    vid = extract_video_id_from_text(video_id)
    if not vid:
        raise HTTPException(status_code=400, detail="Video ID không hợp lệ.")
    action = str(payload.get("action") or "like").lower()
    ep_map = {"like": "like/like", "dislike": "like/dislike", "none": "like/removelike"}
    ep = ep_map.get(action, "like/like")
    await innertube_tv_post(ep, {"target": {"videoId": vid}})
    return {"video_id": vid, "action": action if action in ep_map else "like"}


@app.get("/api/playlists/youtube")
async def api_youtube_playlists(video_id: str = Query("")) -> Dict[str, Any]:
    """Fetch user's YouTube playlists (Watch Later, Liked, custom) via Google OAuth."""
    vids = [video_id] if video_id and re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id) else ["jNQXAC9IVRw"]
    data = await innertube_tv_post("playlist/get_add_to_playlist", {"videoIds": vids})
    playlists = extract_playlists_from_innertube(data)
    if not any(p["id"] == "LL" for p in playlists):
        playlists.append({"id": "LL", "title": "Video đã thích", "privacy": "PRIVATE", "contains_selected": False, "count_text": "", "thumbnail": ""})
    return {"playlists": playlists}


@app.get("/api/playlists/youtube/{playlist_id}")
async def api_youtube_playlist_items(playlist_id: str) -> Dict[str, Any]:
    """Fetch videos inside a YouTube playlist (e.g. WL, LL, PL...)."""
    pid = playlist_id.strip()
    browse_id = pid if pid.startswith("VL") else f"VL{pid}"
    data = await innertube_tv_post("browse", {"browseId": browse_id})
    return {"playlist_id": pid, "items": extract_videos_from_innertube(data, limit=50)}


@app.post("/api/playlists/youtube/add")
async def api_youtube_playlist_edit(payload: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """Add or remove a video from a real YouTube playlist using Google OAuth."""
    pid = str(payload.get("playlist_id") or "").strip()
    vid = extract_video_id_from_text(str(payload.get("video_id") or ""))
    remove = bool(payload.get("remove", False))
    if not pid or not vid:
        raise HTTPException(status_code=400, detail="Thiếu playlist_id hoặc video_id hợp lệ.")
    act = (
        {"action": "ACTION_REMOVE_VIDEO_BY_VIDEO_ID", "removedVideoId": vid}
        if remove
        else {"action": "ACTION_ADD_VIDEO", "addedVideoId": vid}
    )
    await innertube_tv_post("browse/edit_playlist", {"playlistId": pid, "actions": [act]})
    return {"playlist_id": pid, "video_id": vid, "added": not remove}


def _rewrite_m3u8_backend(body: str, base_url: str, vid: str) -> str:
    """Rewrite relative/absolute URIs in HLS .m3u8 playlists to route through /api/hls-proxy."""
    def _proxy_ref(ref: str) -> str:
        abs_url = urllib.parse.urljoin(base_url, ref.strip())
        return f"/api/hls-proxy?url={urllib.parse.quote(abs_url, safe='')}&vid={urllib.parse.quote(vid, safe='')}"

    out_lines: List[str] = []
    for raw_line in body.splitlines():
        line = raw_line.strip("\r")
        if line.startswith("#"):
            out_lines.append(re.sub(r'URI="([^"]+)"', lambda m: f'URI="{_proxy_ref(m.group(1))}"', line))
        elif line.strip():
            out_lines.append(_proxy_ref(line))
        else:
            out_lines.append(line)
    return "\n".join(out_lines)


@app.get("/api/hls/{video_id}")
async def api_hls_manifest(video_id: str) -> Response:
    """Serve rewritten YouTube Livestream HLS master manifest with permissive CORS headers."""
    vid = extract_video_id_from_text(video_id)
    if not vid:
        raise HTTPException(status_code=400, detail="Video ID không hợp lệ.")
    cached = STREAM_CACHE.get(vid)
    if not cached or not cached.get("hls_manifest_url"):
        await asyncio.to_thread(extract_video_sync, vid, True)
        cached = STREAM_CACHE.get(vid)
    hls_url = (cached or {}).get("hls_manifest_url") or ""
    if not hls_url:
        raise HTTPException(status_code=404, detail="Video này không có luồng trực tiếp HLS.")
    headers = (cached or {}).get("hls_headers") or {"User-Agent": ANDROID_INNERTUBE_UA}
    async with httpx.AsyncClient(follow_redirects=True, timeout=15.0) as client:
        resp = await client.get(hls_url, headers=headers)
    if resp.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"Lỗi tải luồng HLS ({resp.status_code}).")
    rewritten = _rewrite_m3u8_backend(resp.text, str(resp.url), vid)
    return Response(
        content=rewritten,
        media_type="application/vnd.apple.mpegurl",
        headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "no-store"},
    )


@app.get("/api/hls-proxy")
async def api_hls_proxy(url: str = Query(...), vid: str = Query("")) -> Response:
    """Proxy HLS sub-playlists and live media segments cleanly with CORS headers."""
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https") or not (
        parsed.netloc.endswith(".googlevideo.com") or parsed.netloc.endswith(".youtube.com")
    ):
        raise HTTPException(status_code=400, detail="URL HLS không hợp lệ.")
    cached = STREAM_CACHE.get(vid) if vid else None
    headers = (cached or {}).get("hls_headers") or {"User-Agent": ANDROID_INNERTUBE_UA}
    async with httpx.AsyncClient(follow_redirects=True, timeout=15.0) as client:
        resp = await client.get(url, headers=headers)
    if resp.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"Lỗi tải phân đoạn HLS ({resp.status_code}).")
    ct = resp.headers.get("content-type", "video/mp2t")
    if ".m3u8" in str(resp.url) or "mpegurl" in ct.lower() or resp.content[:7] == b"#EXTM3U":
        rewritten = _rewrite_m3u8_backend(resp.text, str(resp.url), vid)
        return Response(
            content=rewritten,
            media_type="application/vnd.apple.mpegurl",
            headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "no-store"},
        )
    return Response(
        content=resp.content,
        media_type=ct,
        headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "no-store"},
    )


@app.get("/api/dubbing/{video_id}")
async def api_dubbing(video_id: str) -> Dict[str, Any]:
    """Extract video captions and translate them into Vietnamese sentences for AI dubbing & subtitles."""
    vid = extract_video_id_from_text(video_id)
    if not vid:
        raise HTTPException(status_code=400, detail="Video ID không hợp lệ.")

    cached_dub = DUBBING_CACHE.get(vid)
    if cached_dub and cached_dub["expires_at"] > time.time():
        return cached_dub["data"]

    stream_entry = STREAM_CACHE.get(vid)
    if not stream_entry or "captions_info" not in stream_entry:
        await asyncio.to_thread(extract_video_sync, vid)
        stream_entry = STREAM_CACHE.get(vid)

    captions_info = (stream_entry or {}).get("captions_info") or {}
    cap_url, src_lang, already_vi = pick_caption_source(captions_info)
    if not cap_url:
        result = {"video_id": vid, "source_lang": "", "translated": False, "segments": []}
        DUBBING_CACHE[vid] = {"expires_at": time.time() + DUBBING_CACHE_TTL, "data": result}
        return result

    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            resp = await client.get(cap_url)
            if resp.status_code != 200:
                raise HTTPException(status_code=502, detail="Không tải được phụ đề gốc từ YouTube.")
            json3_data = resp.json()
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Lỗi đọc phụ đề: {exc}") from exc

    sentences = merge_json3_into_sentences(json3_data)
    if not sentences:
        result = {"video_id": vid, "source_lang": src_lang, "translated": False, "segments": []}
        DUBBING_CACHE[vid] = {"expires_at": time.time() + DUBBING_CACHE_TTL, "data": result}
        return result

    originals = [s["text"] for s in sentences]
    if already_vi:
        vi_texts = originals
    else:
        vi_texts = await translate_texts_to_vi(originals)

    segments = [
        {
            "start": s["start"],
            "end": s["end"],
            "text": vi_texts[idx],
            "original": originals[idx],
        }
        for idx, s in enumerate(sentences)
    ]

    result = {
        "video_id": vid,
        "source_lang": src_lang,
        "translated": not already_vi,
        "segments": segments,
    }
    DUBBING_CACHE[vid] = {"expires_at": time.time() + DUBBING_CACHE_TTL, "data": result}
    return result


@app.get("/api/tts")
async def api_tts(
    text: str = Query(..., min_length=1, max_length=600),
    voice: str = Query("vi-VN-HoaiMyNeural"),
) -> Response:
    """Synthesize Vietnamese neural speech audio using edge-tts with in-memory LRU caching."""
    allowed_voices = {"vi-VN-HoaiMyNeural", "vi-VN-NamMinhNeural"}
    selected_voice = voice if voice in allowed_voices else "vi-VN-HoaiMyNeural"
    clean_text = re.sub(r"\s+", " ", text).strip()
    cache_key = hashlib.sha1(f"{selected_voice}:{clean_text}".encode("utf-8")).hexdigest()

    if cache_key in TTS_CACHE:
        return Response(
            content=TTS_CACHE[cache_key],
            media_type="audio/mpeg",
            headers={"Cache-Control": "public, max-age=86400"},
        )

    audio_bytes = b""
    voices_to_try = [selected_voice]
    if selected_voice != "vi-VN-HoaiMyNeural":
        voices_to_try.append("vi-VN-HoaiMyNeural")

    for v_name in voices_to_try:
        try:
            communicate = edge_tts.Communicate(clean_text, voice=v_name)
            chunks = bytearray()
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    chunks.extend(chunk["data"])
            if chunks:
                audio_bytes = bytes(chunks)
                break
        except Exception:
            continue

    if not audio_bytes:
        # Reliable fallback to Google Translate TTS
        try:
            async with httpx.AsyncClient(timeout=8.0) as client:
                gt_resp = await client.get(
                    "https://translate.google.com/translate_tts",
                    params={
                        "ie": "UTF-8",
                        "q": clean_text[:200],
                        "tl": "vi",
                        "client": "tw-ob",
                    },
                    headers={"User-Agent": "Mozilla/5.0"},
                )
                if gt_resp.status_code == 200 and gt_resp.content:
                    audio_bytes = gt_resp.content
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"Lỗi tạo giọng đọc Tiếng Việt: {exc}") from exc

    if not audio_bytes:
        raise HTTPException(status_code=502, detail="Không thể tạo giọng đọc Tiếng Việt.")

    if len(TTS_CACHE) >= MAX_TTS_CACHE_ITEMS:
        oldest_key = next(iter(TTS_CACHE))
        TTS_CACHE.pop(oldest_key, None)
    TTS_CACHE[cache_key] = audio_bytes

    return Response(
        content=audio_bytes,
        media_type="audio/mpeg",
        headers={"Cache-Control": "public, max-age=86400"},
    )


def _parse_range_bounds(range_header: Optional[str], total: int) -> Tuple[bool, int, int]:
    """Parse HTTP Range bytes=start-end against total length cleanly."""
    if not range_header:
        return False, 0, total - 1
    m = re.match(r"bytes=(\d*)-(\d*)", range_header.strip(), re.I)
    if not m:
        return False, 0, total - 1
    s_part, e_part = m.group(1), m.group(2)
    if s_part:
        start = int(s_part)
        end = min(int(e_part), total - 1) if e_part else (total - 1)
        return True, start, end
    if e_part:
        suffix = int(e_part)
        return True, max(0, total - suffix), total - 1
    return False, 0, total - 1


@app.get("/api/stream/{video_id}")
async def api_stream(
    video_id: str,
    request: Request,
    format_id: str = Query(...),
) -> StreamingResponse:
    """Proxy media stream with HTTP 206 Partial Content & bounded-chunk fallback for adaptive streams."""
    cached = STREAM_CACHE.get(video_id)
    if not cached or cached["expires_at"] <= time.time():
        await asyncio.to_thread(extract_video_sync, video_id)
        cached = STREAM_CACHE.get(video_id)

    fmt_info = (cached or {}).get("format_map", {}).get(format_id)
    if not fmt_info:
        await asyncio.to_thread(extract_video_sync, video_id, True)
        cached = STREAM_CACHE.get(video_id)
        fmt_info = (cached or {}).get("format_map", {}).get(format_id)

    if not fmt_info:
        raise HTTPException(status_code=404, detail="Không tìm thấy định dạng phát phù hợp.")

    target_url = fmt_info["url"]
    upstream_headers = {
        k: v for k, v in (fmt_info.get("http_headers") or {}).items()
        if k.lower() != "range"
    }
    range_header = request.headers.get("range")
    req_headers = dict(upstream_headers)
    if range_header:
        req_headers["Range"] = range_header

    client = httpx.AsyncClient(
        follow_redirects=True,
        timeout=httpx.Timeout(25.0, read=None),
    )
    try:
        req = client.build_request("GET", target_url, headers=req_headers)
        upstream_resp = await client.send(req, stream=True)
    except Exception as exc:
        await client.aclose()
        raise HTTPException(status_code=502, detail=f"Lỗi kết nối luồng phát: {exc}") from exc

    # Direct open-ended Range (bytes=0-) gets 403 on YouTube adaptive CDN; switch to bounded multi-chunk relay
    if upstream_resp.status_code == 403:
        await upstream_resp.aclose()
        total = int(fmt_info.get("content_length") or 0)
        probe_headers = dict(upstream_headers)
        probe_headers["Range"] = "bytes=0-65535"
        try:
            probe_resp = await client.get(target_url, headers=probe_headers)
            if probe_resp.status_code in (403, 410):
                await asyncio.to_thread(extract_video_sync, video_id, True)
                cached = STREAM_CACHE.get(video_id)
                fmt_info = (cached or {}).get("format_map", {}).get(format_id)
                if fmt_info:
                    target_url = fmt_info["url"]
                    upstream_headers = {
                        k: v for k, v in (fmt_info.get("http_headers") or {}).items()
                        if k.lower() != "range"
                    }
                    probe_resp = await client.get(target_url, headers={**upstream_headers, "Range": "bytes=0-65535"})
            if total <= 0 and probe_resp.status_code in (200, 206):
                cr = probe_resp.headers.get("content-range") or ""
                cm = re.search(r"/(\d+)$", cr.strip())
                if cm:
                    total = int(cm.group(1))
                elif probe_resp.headers.get("content-length"):
                    total = int(probe_resp.headers["content-length"])
                if fmt_info and total > 0:
                    fmt_info["content_length"] = total
        except Exception as exc:
            await client.aclose()
            raise HTTPException(status_code=502, detail=f"Lỗi kết nối luồng phát: {exc}") from exc

        if total <= 0:
            await client.aclose()
            raise HTTPException(status_code=502, detail="Không xác định được dung lượng luồng phát.")

        has_range, req_start, req_end = _parse_range_bounds(range_header, total)
        if req_start < 0 or req_start >= total or req_end < req_start:
            await client.aclose()
            raise HTTPException(status_code=416, detail="Range Not Satisfiable")

        chunk_headers = {
            "Accept-Ranges": "bytes",
            "Content-Type": fmt_info.get("mime_hint", "video/mp4") if fmt_info else "video/mp4",
            "Content-Length": str(req_end - req_start + 1),
            "Cache-Control": "public, max-age=3600",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
        }
        if has_range:
            chunk_headers["Content-Range"] = f"bytes {req_start}-{req_end}/{total}"

        async def chunked_generator():
            chunk_span = 262144 if total < 35_000_000 else 524288
            cursor = req_start
            try:
                while cursor <= req_end:
                    sub_end = min(cursor + chunk_span - 1, req_end)
                    hdrs = dict(upstream_headers)
                    hdrs["Range"] = f"bytes={cursor}-{sub_end}"
                    creq = client.build_request("GET", target_url, headers=hdrs)
                    cresp = await client.send(creq, stream=True)
                    if cresp.status_code == 403 and chunk_span > 65536:
                        await cresp.aclose()
                        chunk_span //= 2
                        continue
                    if cresp.status_code not in (200, 206):
                        await cresp.aclose()
                        break
                    got = 0
                    try:
                        async for piece in cresp.aiter_bytes(chunk_size=32768):
                            got += len(piece)
                            yield piece
                    finally:
                        await cresp.aclose()
                    if got <= 0:
                        break
                    cursor += got
            except (httpx.HTTPError, asyncio.CancelledError):
                pass
            finally:
                await client.aclose()

        return StreamingResponse(
            chunked_generator(),
            status_code=206 if has_range else 200,
            headers=chunk_headers,
            media_type=chunk_headers["Content-Type"],
        )

    if upstream_resp.status_code == 410:
        await upstream_resp.aclose()
        await asyncio.to_thread(extract_video_sync, video_id, True)
        cached = STREAM_CACHE.get(video_id)
        fmt_info = (cached or {}).get("format_map", {}).get(format_id)
        if not fmt_info:
            await client.aclose()
            raise HTTPException(status_code=404, detail="Luồng phát đã hết hạn.")
        target_url = fmt_info["url"]
        req_headers = {
            k: v for k, v in (fmt_info.get("http_headers") or {}).items()
            if k.lower() != "range"
        }
        if range_header:
            req_headers["Range"] = range_header
        try:
            req = client.build_request("GET", target_url, headers=req_headers)
            upstream_resp = await client.send(req, stream=True)
        except Exception as exc:
            await client.aclose()
            raise HTTPException(status_code=502, detail=f"Lỗi kết nối lại luồng phát: {exc}") from exc

    resp_headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=3600",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
    }
    for key in ("content-type", "content-length", "content-range"):
        val = upstream_resp.headers.get(key)
        if val:
            resp_headers[key.title()] = val
    if "Content-Type" not in resp_headers:
        resp_headers["Content-Type"] = fmt_info.get("mime_hint", "video/mp4")

    async def stream_generator():
        try:
            async for chunk in upstream_resp.aiter_bytes(chunk_size=65536):
                yield chunk
        except (httpx.HTTPError, asyncio.CancelledError):
            pass
        finally:
            await upstream_resp.aclose()
            await client.aclose()

    return StreamingResponse(
        stream_generator(),
        status_code=upstream_resp.status_code,
        headers=resp_headers,
        media_type=resp_headers["Content-Type"],
    )


@app.get("/api/download/{video_id}")
async def api_download(
    video_id: str,
    mode: str = Query("video", pattern="^(audio|video)$"),
    height: int = Query(720),
) -> FileResponse:
    """Download MP3 audio or muxed MP4 video directly to user device."""
    vid = extract_video_id_from_text(video_id)
    if not vid:
        raise HTTPException(status_code=400, detail="Video ID không hợp lệ.")

    try:
        result = await asyncio.to_thread(download_media_sync, vid, mode, height)
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Không thể tải xuống tệp: {exc}",
        ) from exc

    return FileResponse(
        path=result["path"],
        filename=result["filename"],
        media_type=result["media_type"],
    )


@app.get("/sw.js")
async def service_worker() -> FileResponse:
    """Serve Service Worker from root scope."""
    return FileResponse(
        path=str(FRONTEND_DIR / "sw.js"),
        media_type="application/javascript",
        headers={"Service-Worker-Allowed": "/"},
    )


@app.get("/manifest.json")
async def manifest_json() -> FileResponse:
    """Serve PWA Web App Manifest."""
    return FileResponse(
        path=str(FRONTEND_DIR / "manifest.json"),
        media_type="application/manifest+json",
    )


if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")
