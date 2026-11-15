#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

CAP_PLUGIN(PureTubeNativePlugin, "PureTubeNative",
    CAP_PLUGIN_METHOD(httpGet, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(httpGetBase64, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(httpPostJson, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(httpPostForm, CAPPluginReturnPromise);
)
