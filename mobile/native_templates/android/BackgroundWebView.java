package com.puretube.app;

import android.content.Context;
import android.util.AttributeSet;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.webkit.WebView;

public class BackgroundWebView extends WebView {
    public interface SwipeDownListener {
        void onDragProgress(float dyPx);
        void onDragEnd(boolean shouldMinimize);
    }

    private volatile boolean keepAliveInBackground = true;
    private SwipeDownListener swipeDownListener;
    private boolean swipeDownEnabled = false;
    private float downRawX;
    private float downRawY;
    private float lastDragDy;
    private boolean trackingPotentialSwipe = false;
    private boolean draggingDown = false;
    private float touchSlop;
    private float density;

    public BackgroundWebView(Context context) {
        super(context);
        initTouchMetrics(context);
    }

    public BackgroundWebView(Context context, AttributeSet attrs) {
        super(context, attrs);
        initTouchMetrics(context);
    }

    private void initTouchMetrics(Context context) {
        this.touchSlop = ViewConfiguration.get(context).getScaledTouchSlop();
        this.density = context.getResources().getDisplayMetrics().density;
    }

    private float dpToPx(float dp) {
        return dp * density;
    }

    public void setKeepAliveInBackground(boolean enabled) {
        this.keepAliveInBackground = enabled;
    }

    public void setSwipeDownListener(SwipeDownListener listener) {
        this.swipeDownListener = listener;
    }

    public void setSwipeDownEnabled(boolean enabled) {
        this.swipeDownEnabled = enabled;
        if (!enabled) {
            trackingPotentialSwipe = false;
            draggingDown = false;
            lastDragDy = 0f;
        }
    }

    @Override
    public boolean onTouchEvent(MotionEvent ev) {
        if (swipeDownListener != null && swipeDownEnabled && ev != null) {
            int action = ev.getActionMasked();
            if (action == MotionEvent.ACTION_DOWN) {
                int w = getWidth();
                float playerZoneBottom = (w > 0) ? (w * 9f / 16f - dpToPx(36f)) : 0f;
                trackingPotentialSwipe = ev.getPointerCount() == 1
                        && getScrollY() <= 2
                        && w > 0
                        && ev.getY() >= 0f
                        && ev.getY() < playerZoneBottom;
                draggingDown = false;
                lastDragDy = 0f;
                downRawX = ev.getRawX();
                downRawY = ev.getRawY();
            } else if (action == MotionEvent.ACTION_POINTER_DOWN) {
                if (draggingDown) {
                    draggingDown = false;
                    trackingPotentialSwipe = false;
                    lastDragDy = 0f;
                    swipeDownListener.onDragEnd(false);
                    return true;
                }
                trackingPotentialSwipe = false;
            } else if (action == MotionEvent.ACTION_MOVE && trackingPotentialSwipe) {
                float dx = ev.getRawX() - downRawX;
                float dy = ev.getRawY() - downRawY;
                float activationSlop = touchSlop * 2.2f;
                if (!draggingDown) {
                    if (dy < -touchSlop || (Math.abs(dx) > activationSlop && Math.abs(dx) > Math.abs(dy))) {
                        trackingPotentialSwipe = false;
                    } else if (dy > activationSlop && dy > Math.abs(dx) * 1.6f) {
                        draggingDown = true;
                        lastDragDy = 0f;
                        MotionEvent cancel = MotionEvent.obtain(ev);
                        cancel.setAction(MotionEvent.ACTION_CANCEL);
                        super.onTouchEvent(cancel);
                        cancel.recycle();
                    }
                }
                if (draggingDown) {
                    lastDragDy = Math.max(0f, dy - activationSlop);
                    swipeDownListener.onDragProgress(lastDragDy);
                    return true;
                }
            } else if (action == MotionEvent.ACTION_UP) {
                if (draggingDown) {
                    boolean shouldMinimize = lastDragDy >= dpToPx(85f);
                    draggingDown = false;
                    trackingPotentialSwipe = false;
                    lastDragDy = 0f;
                    swipeDownListener.onDragEnd(shouldMinimize);
                    return true;
                }
                trackingPotentialSwipe = false;
            } else if (action == MotionEvent.ACTION_CANCEL) {
                if (draggingDown) {
                    draggingDown = false;
                    trackingPotentialSwipe = false;
                    lastDragDy = 0f;
                    swipeDownListener.onDragEnd(false);
                } else {
                    trackingPotentialSwipe = false;
                }
            }
        }
        return super.onTouchEvent(ev);
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
