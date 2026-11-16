package com.puretube.nativebridge;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

public class PureTubeMediaService extends Service {
    public interface ActionListener {
        void onMediaAction(String action);
    }

    public static final String ACTION_UPDATE = "com.puretube.nativebridge.ACTION_UPDATE";
    public static final String ACTION_STOP = "com.puretube.nativebridge.ACTION_STOP";
    public static final String ACTION_TOGGLE = "com.puretube.nativebridge.ACTION_TOGGLE";
    public static final String ACTION_NEXT = "com.puretube.nativebridge.ACTION_NEXT";
    public static final String ACTION_PREV = "com.puretube.nativebridge.ACTION_PREV";

    private static final String CHANNEL_ID = "puretube_media_channel";
    private static final int NOTIF_ID = 7741;

    public static volatile ActionListener actionListener = null;

    private MediaSession mediaSession;
    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private String currentTitle = "PureTube";
    private String currentArtist = "Đang phát nền";
    private boolean isPlaying = false;

    @Override
    public void onCreate() {
        super.onCreate();
        ensureChannel();
        initMediaSession();
        acquireLocks();
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null && nm.getNotificationChannel(CHANNEL_ID) == null) {
                NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID,
                    "PureTube Phát Nền",
                    NotificationManager.IMPORTANCE_LOW
                );
                ch.setDescription("Điều khiển phát video và nhạc nền trên PureTube");
                ch.setShowBadge(false);
                nm.createNotificationChannel(ch);
            }
        }
    }

    private void initMediaSession() {
        mediaSession = new MediaSession(this, "PureTubeSession");
        mediaSession.setCallback(new MediaSession.Callback() {
            @Override
            public void onPlay() {
                dispatchAction("play");
            }

            @Override
            public void onPause() {
                dispatchAction("pause");
            }

            @Override
            public void onSkipToNext() {
                dispatchAction("next");
            }

            @Override
            public void onSkipToPrevious() {
                dispatchAction("prev");
            }
        });
        mediaSession.setActive(true);
    }

    private void acquireLocks() {
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "PureTube::MediaWakeLock");
                wakeLock.setReferenceCounted(false);
            }
            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wm != null) {
                wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "PureTube::MediaWifiLock");
                wifiLock.setReferenceCounted(false);
            }
        } catch (Exception ignored) {}
    }

    private void updateLockState(boolean active) {
        try {
            if (wakeLock != null) {
                if (active && !wakeLock.isHeld()) wakeLock.acquire(4 * 60 * 60 * 1000L);
                else if (!active && wakeLock.isHeld()) wakeLock.release();
            }
            if (wifiLock != null) {
                if (active && !wifiLock.isHeld()) wifiLock.acquire();
                else if (!active && wifiLock.isHeld()) wifiLock.release();
            }
        } catch (Exception ignored) {}
    }

    private void dispatchAction(String action) {
        ActionListener listener = actionListener;
        if (listener != null) {
            listener.onMediaAction(action);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            return START_NOT_STICKY;
        }
        String act = intent.getAction();
        if (ACTION_STOP.equals(act)) {
            updateLockState(false);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(STOP_FOREGROUND_REMOVE);
            } else {
                stopForeground(true);
            }
            stopSelf();
            return START_NOT_STICKY;
        }
        if (ACTION_TOGGLE.equals(act)) {
            dispatchAction(isPlaying ? "pause" : "play");
            return START_STICKY;
        }
        if (ACTION_NEXT.equals(act)) {
            dispatchAction("next");
            return START_STICKY;
        }
        if (ACTION_PREV.equals(act)) {
            dispatchAction("prev");
            return START_STICKY;
        }

        String t = intent.getStringExtra("title");
        String a = intent.getStringExtra("artist");
        if (t != null && !t.isEmpty()) currentTitle = t;
        if (a != null && !a.isEmpty()) currentArtist = a;
        isPlaying = intent.getBooleanExtra("playing", true);

        updateSessionState();
        updateLockState(isPlaying);
        showNotification();
        return START_STICKY;
    }

    private void updateSessionState() {
        if (mediaSession == null) return;
        MediaMetadata meta = new MediaMetadata.Builder()
            .putString(MediaMetadata.METADATA_KEY_TITLE, currentTitle)
            .putString(MediaMetadata.METADATA_KEY_ARTIST, currentArtist)
            .build();
        mediaSession.setMetadata(meta);

        long actions = PlaybackState.ACTION_PLAY
            | PlaybackState.ACTION_PAUSE
            | PlaybackState.ACTION_PLAY_PAUSE
            | PlaybackState.ACTION_SKIP_TO_NEXT
            | PlaybackState.ACTION_SKIP_TO_PREVIOUS;
        int state = isPlaying ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED;
        PlaybackState ps = new PlaybackState.Builder()
            .setActions(actions)
            .setState(state, PlaybackState.PLAYBACK_POSITION_UNKNOWN, isPlaying ? 1.0f : 0.0f)
            .build();
        mediaSession.setPlaybackState(ps);
    }

    private PendingIntent makeActionIntent(String action, int reqCode) {
        Intent i = new Intent(this, PureTubeMediaService.class);
        i.setAction(action);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return PendingIntent.getService(this, reqCode, i, flags);
    }

    private PendingIntent makeLaunchIntent() {
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launch == null) launch = new Intent();
        launch.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return PendingIntent.getActivity(this, 100, launch, flags);
    }

    private void showNotification() {
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, CHANNEL_ID)
            : new Notification.Builder(this);

        int toggleIcon = isPlaying ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play;
        String toggleLabel = isPlaying ? "Tạm dừng" : "Phát";

        builder.setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle(currentTitle)
            .setContentText(currentArtist)
            .setOngoing(isPlaying)
            .setOnlyAlertOnce(true)
            .setContentIntent(makeLaunchIntent())
            .addAction(new Notification.Action.Builder(android.R.drawable.ic_media_previous, "Trước", makeActionIntent(ACTION_PREV, 1)).build())
            .addAction(new Notification.Action.Builder(toggleIcon, toggleLabel, makeActionIntent(ACTION_TOGGLE, 2)).build())
            .addAction(new Notification.Action.Builder(android.R.drawable.ic_media_next, "Tiếp", makeActionIntent(ACTION_NEXT, 3)).build());

        if (mediaSession != null) {
            builder.setStyle(
                new Notification.MediaStyle()
                    .setMediaSession(mediaSession.getSessionToken())
                    .setShowActionsInCompactView(0, 1, 2)
            );
        }

        Notification notif = builder.build();
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            } else {
                startForeground(NOTIF_ID, notif);
            }
        } catch (Exception ignored) {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.notify(NOTIF_ID, notif);
        }
    }

    @Override
    public void onDestroy() {
        updateLockState(false);
        if (mediaSession != null) {
            mediaSession.setActive(false);
            mediaSession.release();
            mediaSession = null;
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
