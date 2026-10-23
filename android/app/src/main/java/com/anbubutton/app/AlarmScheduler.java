package com.anbubutton.app;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Calendar;

/**
 * 약 알람 예약. 웹이 넘겨준 목록(시간·약 이름·오늘 드셨는지)을 저장하고, 시간마다 다음 알람 하나씩 건다.
 * 같은 시간 약은 웹에서 이미 한 줄로 묶여 온다. 오늘 이미 드셨거나 시간이 지났으면 내일로 건다.
 * 재부팅·앱 업데이트 뒤에는 BootReceiver 가 저장된 목록으로 다시 건다.
 */
final class AlarmScheduler {
    private static final String PREFS = "alarms", KEY = "list", KEY_CODES = "codes";

    private AlarmScheduler() { }

    /** 웹에서 받은 목록을 저장하고 다시 예약 */
    static void save(Context c, String json) {
        prefs(c).edit().putString(KEY, json == null ? "[]" : json).apply();
        reschedule(c, false);
    }

    /**
     * 저장된 목록으로 모두 다시 예약.
     * afterReboot 면 '오늘 드셨는지'를 모르므로, 아직 안 지난 오늘 시간은 오늘로 건다.
     */
    static void reschedule(Context c, boolean afterReboot) {
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        SharedPreferences p = prefs(c);
        // 지난번에 건 알람은 모두 지운다
        for (String code : p.getString(KEY_CODES, "").split(",")) {
            if (code.isEmpty()) continue;
            am.cancel(pending(c, Integer.parseInt(code), "", ""));
        }
        StringBuilder codes = new StringBuilder();
        try {
            JSONArray list = new JSONArray(p.getString(KEY, "[]"));
            for (int i = 0; i < list.length(); i++) {
                JSONObject a = list.getJSONObject(i);
                String time = a.getString("time");           // "08:30"
                String label = a.optString("label", "약");
                boolean taken = !afterReboot && a.optBoolean("taken", false);
                int h = Integer.parseInt(time.substring(0, 2)), m = Integer.parseInt(time.substring(3, 5));
                int code = h * 100 + m;
                long at = nextTrigger(h, m, taken);
                set(c, am, at, pending(c, code, time, label));
                codes.append(code).append(',');
            }
        } catch (Exception ignored) { }
        p.edit().putString(KEY_CODES, codes.toString()).apply();
    }

    /** 알람이 울린 뒤: 그 시간 알람을 내일 같은 시간에 다시 건다 */
    static void scheduleTomorrow(Context c, String time, String label) {
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        int h = Integer.parseInt(time.substring(0, 2)), m = Integer.parseInt(time.substring(3, 5));
        set(c, am, nextTrigger(h, m, true), pending(c, h * 100 + m, time, label));
    }

    private static long nextTrigger(int h, int m, boolean skipToday) {
        Calendar t = Calendar.getInstance();
        t.set(Calendar.HOUR_OF_DAY, h);
        t.set(Calendar.MINUTE, m);
        t.set(Calendar.SECOND, 0);
        t.set(Calendar.MILLISECOND, 0);
        if (skipToday || t.getTimeInMillis() <= System.currentTimeMillis()) t.add(Calendar.DAY_OF_YEAR, 1);
        return t.getTimeInMillis();
    }

    private static void set(Context c, AlarmManager am, long at, PendingIntent pi) {
        boolean exact = Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms();
        if (exact) {
            // 알람시계 방식: 절전 중에도 정확한 시간에 울린다
            PendingIntent show = PendingIntent.getActivity(c, 0, new Intent(c, MainActivity.class),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            am.setAlarmClock(new AlarmManager.AlarmClockInfo(at, show), pi);
        } else {
            // 정확한 알람 권한이 없으면 몇 분 늦을 수 있는 방식으로라도 건다
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
        }
    }

    private static PendingIntent pending(Context c, int code, String time, String label) {
        Intent i = new Intent(c, AlarmReceiver.class).putExtra("time", time).putExtra("label", label);
        return PendingIntent.getBroadcast(c, code, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
