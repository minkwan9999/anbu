package com.anbubutton.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;

/**
 * 약 시간이 되면: 알람 소리가 계속 울리는 알림을 띄우고 화면을 켠다(전체 화면 알림).
 * 알림을 누르거나 앱이 열리면 소리는 멈추고, 웹 화면이 "약 드실 시간이에요"를 보여 준다.
 */
public class AlarmReceiver extends BroadcastReceiver {
    static final int NOTIFY_ID = 7001;
    private static final String CHANNEL = "med_alarm";

    @Override
    public void onReceive(Context c, Intent intent) {
        String time = intent.getStringExtra("time");
        String label = intent.getStringExtra("label");
        if (time == null || time.isEmpty()) return;

        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        Uri sound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
        if (sound == null) sound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
        if (nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "약 알람", NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription("약 드실 시간에 알람을 울려요");
            ch.setSound(sound, new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
            ch.enableVibration(true);
            ch.setVibrationPattern(new long[]{0, 800, 400, 800, 400, 800});
            ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            ch.setBypassDnd(true);
            nm.createNotificationChannel(ch);
        }

        Intent open = new Intent(c, MainActivity.class).putExtra(MainActivity.EXTRA_ALARM, true)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(c, 1, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        Notification n = new Notification.Builder(c, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
            .setContentTitle("💊 약 드실 시간이에요")
            .setContentText(label)
            .setCategory(Notification.CATEGORY_ALARM)
            .setContentIntent(pi)
            .setFullScreenIntent(pi, true)
            .setAutoCancel(true)
            .setOngoing(true)
            .build();
        n.flags |= Notification.FLAG_INSISTENT;   // 누를 때까지 소리를 계속 낸다
        nm.notify(NOTIFY_ID, n);

        AlarmScheduler.scheduleTomorrow(c, time, label);
    }
}
