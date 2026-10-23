package com.anbubutton.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** 폰을 껐다 켜거나 앱이 업데이트되면 알람이 지워지므로, 저장해 둔 목록으로 다시 건다 */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent intent) {
        AlarmScheduler.reschedule(c, true);
    }
}
