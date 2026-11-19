package com.puretube.app;

import android.content.Context;
import android.util.AttributeSet;
import android.view.View;
import android.webkit.WebView;

public class BackgroundWebView extends WebView {
    private volatile boolean keepAliveInBackground = true;

    public BackgroundWebView(Context context) {
        super(context);
    }

    public BackgroundWebView(Context context, AttributeSet attrs) {
        super(context, attrs);
    }

    public void setKeepAliveInBackground(boolean enabled) {
        this.keepAliveInBackground = enabled;
    }

    @Override
    protected void onWindowVisibilityChanged(int visibility) {
        if (keepAliveInBackground && visibility != View.VISIBLE) {
            super.onWindowVisibilityChanged(View.VISIBLE);
            return;
        }
        super.onWindowVisibilityChanged(visibility);
    }
}
