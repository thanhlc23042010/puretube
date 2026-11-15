@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ======================================================
echo   PureTube - Trinh phat YouTube Khong Quang Cao
echo   Dang khoi dong may chu tai cong 8000...
echo ======================================================
start "" http://localhost:8000
python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000
pause
