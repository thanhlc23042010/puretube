import shutil
from pathlib import Path

MOBILE_DIR = Path(__file__).resolve().parent
ROOT = MOBILE_DIR.parent
FRONTEND_DIR = ROOT / "frontend"
WWW_DIR = MOBILE_DIR / "www"
INJECT_SRC = MOBILE_DIR / "native_templates" / "puretube_inject.js"


def sync_frontend_to_www() -> None:
    """Mirror frontend web assets and inject script into Capacitor mobile/www directory cleanly."""
    if WWW_DIR.exists():
        shutil.rmtree(WWW_DIR)
    shutil.copytree(FRONTEND_DIR, WWW_DIR)
    if INJECT_SRC.exists():
        shutil.copy2(INJECT_SRC, WWW_DIR / "puretube_inject.js")
    print(f"Synced {FRONTEND_DIR} (+ puretube_inject.js) -> {WWW_DIR}")


if __name__ == "__main__":
    sync_frontend_to_www()
