import plistlib
import shutil
import xml.etree.ElementTree as ET
from pathlib import Path

MOBILE_DIR = Path(__file__).resolve().parent
TEMPLATES_DIR = MOBILE_DIR / "native_templates"
INJECT_SCRIPT = TEMPLATES_DIR / "puretube_inject.js"

ANDROID_MANIFEST = MOBILE_DIR / "android" / "app" / "src" / "main" / "AndroidManifest.xml"
ANDROID_BUILD_GRADLE = MOBILE_DIR / "android" / "app" / "build.gradle"
ANDROID_STYLES = MOBILE_DIR / "android" / "app" / "src" / "main" / "res" / "values" / "styles.xml"
ANDROID_JAVA_DIR = MOBILE_DIR / "android" / "app" / "src" / "main" / "java" / "com" / "puretube" / "app"
ANDROID_ASSETS_DIR = MOBILE_DIR / "android" / "app" / "src" / "main" / "assets"

IOS_INFO_PLIST = MOBILE_DIR / "ios" / "App" / "App" / "Info.plist"
IOS_APP_DELEGATE = MOBILE_DIR / "ios" / "App" / "App" / "AppDelegate.swift"
IOS_PUBLIC_DIR = MOBILE_DIR / "ios" / "App" / "App" / "public"


def patch_android() -> None:
    """Configure native YouTube WebView (AdBlock, Background Playback, PiP, Dark System Bars)."""
    if ANDROID_MANIFEST.exists():
        xml_text = ANDROID_MANIFEST.read_text(encoding="utf-8")
        for attr in (
            'android:usesCleartextTraffic="true"',
            'android:hardwareAccelerated="true"',
        ):
            if attr not in xml_text:
                xml_text = xml_text.replace("<application", f"<application\n        {attr}", 1)

        for attr in (
            'android:supportsPictureInPicture="true"',
            'android:resizeableActivity="true"',
        ):
            if attr not in xml_text:
                xml_text = xml_text.replace("<activity", f"<activity\n            {attr}", 1)

        xml_text = xml_text.replace("@style/AppTheme.NoActionBarLaunch", "@style/AppTheme.NoActionBar")

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

    if ANDROID_BUILD_GRADLE.exists():
        gradle_text = ANDROID_BUILD_GRADLE.read_text(encoding="utf-8")
        appcompat_anchor = 'implementation "androidx.appcompat:appcompat:$androidxAppCompatVersion"'
        changed = False
        for dep in (
            'implementation "androidx.webkit:webkit:$androidxWebkitVersion"',
            'implementation "androidx.swiperefreshlayout:swiperefreshlayout:1.1.0"',
        ):
            if dep not in gradle_text and appcompat_anchor in gradle_text:
                gradle_text = gradle_text.replace(
                    appcompat_anchor,
                    f"{appcompat_anchor}\n    {dep}",
                    1,
                )
                changed = True
        if changed:
            ANDROID_BUILD_GRADLE.write_text(gradle_text, encoding="utf-8")
            print("Patched android/app/build.gradle cleanly.")

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

    android_templates = TEMPLATES_DIR / "android"
    if android_templates.exists():
        ANDROID_JAVA_DIR.mkdir(parents=True, exist_ok=True)
        for java_file in ("AdBlockFilter.java", "BackgroundWebView.java", "MainActivity.java"):
            src = android_templates / java_file
            if src.exists():
                shutil.copy2(src, ANDROID_JAVA_DIR / java_file)
        print("Copied native Android WebView classes cleanly.")

    if INJECT_SCRIPT.exists():
        ANDROID_ASSETS_DIR.mkdir(parents=True, exist_ok=True)
        shutil.copy2(INJECT_SCRIPT, ANDROID_ASSETS_DIR / "puretube_inject.js")
        print("Copied puretube_inject.js into Android assets cleanly.")


def patch_ios() -> None:
    """Configure native iOS WKWebView AppDelegate, Info.plist, and ad-block/background script."""
    if IOS_INFO_PLIST.exists():
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
        pl.pop("UIMainStoryboardFile", None)
        with IOS_INFO_PLIST.open("wb") as f:
            plistlib.dump(pl, f)
        print("Patched ios/App/App/Info.plist cleanly.")

    ios_delegate_src = TEMPLATES_DIR / "ios" / "AppDelegate.swift"
    if ios_delegate_src.exists() and IOS_APP_DELEGATE.parent.exists():
        shutil.copy2(ios_delegate_src, IOS_APP_DELEGATE)
        print("Copied native iOS AppDelegate.swift cleanly.")

    if INJECT_SCRIPT.exists() and IOS_APP_DELEGATE.parent.exists():
        IOS_PUBLIC_DIR.mkdir(parents=True, exist_ok=True)
        shutil.copy2(INJECT_SCRIPT, IOS_PUBLIC_DIR / "puretube_inject.js")
        print("Copied puretube_inject.js into iOS public bundle cleanly.")


if __name__ == "__main__":
    patch_android()
    patch_ios()
