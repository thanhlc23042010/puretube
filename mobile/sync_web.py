import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FRONTEND_DIR = ROOT / "frontend"
WWW_DIR = Path(__file__).resolve().parent / "www"


def sync_frontend_to_www() -> None:
    """Mirror frontend web assets into Capacitor mobile/www directory cleanly."""
    if WWW_DIR.exists():
        shutil.rmtree(WWW_DIR)
    shutil.copytree(FRONTEND_DIR, WWW_DIR)
    print(f"Synced {FRONTEND_DIR} -> {WWW_DIR}")


if __name__ == "__main__":
    sync_frontend_to_www()
