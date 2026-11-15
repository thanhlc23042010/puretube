import plistlib
import re
import xml.etree.ElementTree as ET
from pathlib import Path

MOBILE_DIR = Path(__file__).resolve().parent
ANDROID_MANIFEST = MOBILE_DIR / "android" / "app" / "src" / "main" / "AndroidManifest.xml"
ANDROID_MAIN_ACTIVITY = MOBILE_DIR / "android" / "app" / "src" / "main" / "java" / "com" / "puretube" / "app" / "MainActivity.java"
IOS_INFO_PLIST = MOBILE_DIR / "ios" / "App" / "App" / "Info.plist"


def patch_android() -> None:
    """Configure AndroidManifest and MainActivity for background audio, PiP, and fast playback."""
    if ANDROID_MANIFEST.exists():
        xml_text = ANDROID_MANIFEST.read_text(encoding="utf-8")
        if 'android:usesCleartextTraffic="true"' not in xml_text:
            xml_text = xml_text.replace("<application", '<application\n        android:usesCleartextTraffic="true"', 1)
        if 'android:supportsPictureInPicture="true"' not in xml_text:
            xml_text = xml_text.replace("<activity", '<activity\n            android:supportsPictureInPicture="true"', 1)
        if "android.permission.WAKE_LOCK" not in xml_text:
            xml_text = xml_text.replace(
                "<uses-permission android:name=\"android.permission.INTERNET\" />",
                '<uses-permission android:name="android.permission.INTERNET" />\n    <uses-permission android:name="android.permission.WAKE_LOCK" />',
                1,
            )
        ANDROID_MANIFEST.write_text(xml_text, encoding="utf-8")
        # Validate XML stays well-formed
        ET.fromstring(xml_text)
        print("Patched AndroidManifest.xml cleanly.")

    if ANDROID_MAIN_ACTIVITY.exists():
        java_code = (
            "package com.puretube.app;\n\n"
            "import android.os.Bundle;\n"
            "import android.webkit.WebSettings;\n"
            "import com.getcapacitor.BridgeActivity;\n\n"
            "public class MainActivity extends BridgeActivity {\n"
            "    @Override\n"
            "    public void onStart() {\n"
            "        super.onStart();\n"
            "        if (this.bridge != null && this.bridge.getWebView() != null) {\n"
            "            WebSettings settings = this.bridge.getWebView().getSettings();\n"
            "            settings.setMediaPlaybackRequiresUserGesture(false);\n"
            "        }\n"
            "    }\n"
            "}\n"
        )
        ANDROID_MAIN_ACTIVITY.write_text(java_code, encoding="utf-8")
        print("Patched MainActivity.java cleanly.")


def patch_ios() -> None:
    """Configure iOS Info.plist for background audio playback & HTTPS/HTTP flexibility."""
    if not IOS_INFO_PLIST.exists():
        return
    with IOS_INFO_PLIST.open("rb") as f:
        pl = plistlib.load(f)

    bg_modes = list(pl.get("UIBackgroundModes") or [])
    if "audio" not in bg_modes:
        bg_modes.append("audio")
    pl["UIBackgroundModes"] = bg_modes

    ats = dict(pl.get("NSAppTransportSecurity") or {})
    ats["NSAllowsArbitraryLoads"] = True
    pl["NSAppTransportSecurity"] = ats

    pl["CFBundleDisplayName"] = "PureTube"
    with IOS_INFO_PLIST.open("wb") as f:
        plistlib.dump(pl, f)
    print("Patched ios/App/App/Info.plist cleanly.")


if __name__ == "__main__":
    patch_android()
    patch_ios()
