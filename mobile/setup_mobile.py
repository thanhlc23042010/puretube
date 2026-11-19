import plistlib
import xml.etree.ElementTree as ET
from pathlib import Path

MOBILE_DIR = Path(__file__).resolve().parent
ANDROID_MANIFEST = MOBILE_DIR / "android" / "app" / "src" / "main" / "AndroidManifest.xml"
ANDROID_STYLES = MOBILE_DIR / "android" / "app" / "src" / "main" / "res" / "values" / "styles.xml"
ANDROID_MAIN_ACTIVITY = MOBILE_DIR / "android" / "app" / "src" / "main" / "java" / "com" / "puretube" / "app" / "MainActivity.java"
IOS_INFO_PLIST = MOBILE_DIR / "ios" / "App" / "App" / "Info.plist"


def patch_android() -> None:
    """Configure AndroidManifest, dark YouTube system bars, and MainActivity for safe areas & playback."""
    if ANDROID_MANIFEST.exists():
        xml_text = ANDROID_MANIFEST.read_text(encoding="utf-8")
        if 'android:usesCleartextTraffic="true"' not in xml_text:
            xml_text = xml_text.replace("<application", '<application\n        android:usesCleartextTraffic="true"', 1)
        if 'android:supportsPictureInPicture="true"' not in xml_text:
            xml_text = xml_text.replace("<activity", '<activity\n            android:supportsPictureInPicture="true"', 1)
        for perm in (
            "android.permission.WAKE_LOCK",
            "android.permission.FOREGROUND_SERVICE",
            "android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK",
            "android.permission.POST_NOTIFICATIONS",
        ):
            if perm not in xml_text:
                xml_text = xml_text.replace(
                    '<uses-permission android:name="android.permission.INTERNET" />',
                    f'<uses-permission android:name="android.permission.INTERNET" />\n    <uses-permission android:name="{perm}" />',
                    1,
                )
        ANDROID_MANIFEST.write_text(xml_text, encoding="utf-8")
        ET.fromstring(xml_text)
        print("Patched AndroidManifest.xml cleanly.")

    if ANDROID_STYLES.exists():
        styles_text = ANDROID_STYLES.read_text(encoding="utf-8")
        target_anchor = '<item name="android:background">@null</item>'
        additions = []
        for item_xml in (
            '<item name="android:windowBackground">#0F0F0F</item>',
            '<item name="android:statusBarColor">#0F0F0F</item>',
            '<item name="android:navigationBarColor">#0F0F0F</item>',
        ):
            if item_xml not in styles_text:
                additions.append(f"        {item_xml}")
        if additions and target_anchor in styles_text:
            styles_text = styles_text.replace(
                target_anchor,
                target_anchor + "\n" + "\n".join(additions),
                1,
            )
            ANDROID_STYLES.write_text(styles_text, encoding="utf-8")
        ET.fromstring(ANDROID_STYLES.read_text(encoding="utf-8"))
        print("Patched android styles.xml cleanly.")

    if ANDROID_MAIN_ACTIVITY.exists():
        java_code = (
            "package com.puretube.app;\n\n"
            "import android.graphics.Color;\n"
            "import android.os.Build;\n"
            "import android.os.Bundle;\n"
            "import android.webkit.WebSettings;\n"
            "import android.webkit.WebView;\n"
            "import androidx.core.view.WindowCompat;\n"
            "import androidx.core.view.WindowInsetsControllerCompat;\n"
            "import com.getcapacitor.BridgeActivity;\n\n"
            "public class MainActivity extends BridgeActivity {\n"
            "    @Override\n"
            "    public void onCreate(Bundle savedInstanceState) {\n"
            "        super.onCreate(savedInstanceState);\n"
            "        WindowCompat.setDecorFitsSystemWindows(getWindow(), true);\n"
            "        getWindow().setStatusBarColor(Color.parseColor(\"#0F0F0F\"));\n"
            "        getWindow().setNavigationBarColor(Color.parseColor(\"#0F0F0F\"));\n"
            "        WindowInsetsControllerCompat insetsCtrl = WindowCompat.getInsetsController(\n"
            "            getWindow(),\n"
            "            getWindow().getDecorView()\n"
            "        );\n"
            "        if (insetsCtrl != null) {\n"
            "            insetsCtrl.setAppearanceLightStatusBars(false);\n"
            "            insetsCtrl.setAppearanceLightNavigationBars(false);\n"
            "        }\n"
            "    }\n\n"
            "    @Override\n"
            "    public void onStart() {\n"
            "        super.onStart();\n"
            "        if (this.bridge != null && this.bridge.getWebView() != null) {\n"
            "            WebView wv = this.bridge.getWebView();\n"
            "            wv.setBackgroundColor(Color.parseColor(\"#0F0F0F\"));\n"
            "            WebSettings settings = wv.getSettings();\n"
            "            settings.setMediaPlaybackRequiresUserGesture(false);\n"
            "            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);\n"
            "            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {\n"
            "                wv.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);\n"
            "            }\n"
            "        }\n"
            "    }\n"
            "}\n"
        )
        ANDROID_MAIN_ACTIVITY.write_text(java_code, encoding="utf-8")
        print("Patched MainActivity.java cleanly.")


def patch_ios() -> None:
    """Configure iOS Info.plist for background audio playback, file sharing, and HTTPS/HTTP flexibility."""
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

    pl["UIFileSharingEnabled"] = True
    pl["LSSupportsOpeningDocumentsInPlace"] = True
    pl["CFBundleDisplayName"] = "PureTube"
    with IOS_INFO_PLIST.open("wb") as f:
        plistlib.dump(pl, f)
    print("Patched ios/App/App/Info.plist cleanly.")


if __name__ == "__main__":
    patch_android()
    patch_ios()
