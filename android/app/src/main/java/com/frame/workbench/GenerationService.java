package com.frame.workbench;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;

public class GenerationService extends Service {
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static Runnable update;
    private static final String CHANNEL = "frame-generation";
    private PowerManager.WakeLock wakeLock;

    static void refresh(Context context) {
        MAIN.post(() -> {
            if (update != null) MAIN.removeCallbacks(update);
            update = () -> {
                try {
                    if (Backend.get(context).activeCount() > 0) {
                        context.startForegroundService(new Intent(context, GenerationService.class));
                    } else context.stopService(new Intent(context, GenerationService.class));
                } catch (Exception ignored) {}
            };
            MAIN.postDelayed(update, 100);
        });
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        NotificationChannel channel = new NotificationChannel(CHANNEL, "图像生成任务", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("显示正在运行和排队的图像任务");
        manager.createNotificationChannel(channel);
        int count;
        try { count = Backend.get(this).activeCount(); } catch (Exception error) { count = 0; }
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification notification = new Notification.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_notification)
                .setContentTitle("FRAME 正在生成图像").setContentText(count + " 个任务正在生成或排队")
                .setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true).setProgress(0, 0, true).build();
        startForeground(1, notification);
        if (count > 0) {
            if (wakeLock == null) {
                wakeLock = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "frame:generation");
                wakeLock.setReferenceCounted(false);
            }
            wakeLock.acquire(35 * 60 * 1000L);
        }
        if (count == 0) { stopForeground(STOP_FOREGROUND_REMOVE); stopSelf(); }
        return START_NOT_STICKY;
    }
    @Override public IBinder onBind(Intent intent) { return null; }
    @Override public void onDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }
}
