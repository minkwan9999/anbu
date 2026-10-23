package com.anbubutton.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlarmManager;
import android.app.NotificationManager;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.MediaStore;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.core.content.FileProvider;

import java.io.File;

/**
 * 안부버튼 앱: 웹앱(minkwan9999.github.io/anbu)을 그대로 보여 주고, 웹이 못 하는 것만 앱이 한다.
 *  - 약 알람: 화면이 꺼져 있어도 알람 소리와 함께 화면을 켠다 (AlarmScheduler)
 *  - 사진 찍기·고르기, 전화 걸기, 외부 링크
 * 웹은 window.AnbuApp 이 있으면 앱 안이라고 보고 알람 목록을 넘겨준다.
 */
public class MainActivity extends Activity {
    static final String APP_URL = "https://minkwan9999.github.io/anbu/";
    static final String EXTRA_ALARM = "alarm";
    private static final int REQ_FILE = 1, REQ_PERM = 2;

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private Uri cameraUri;
    private PermissionRequest pendingWebPermission;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);   // 알람 소리·음성 안내
        s.setTextZoom(100);                              // 글자 크기는 웹(보호자 설정)이 정한다
        s.setUserAgentString(s.getUserAgentString() + " AnbuApp/" + appVersion());

        web.addJavascriptInterface(new Bridge(), "AnbuApp");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (u.toString().startsWith(APP_URL)) return false;   // 앱 화면은 그대로
                openOutside(u);                                        // 전화(tel:), 문의 폼 등은 밖에서
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                return params.isCaptureEnabled() ? openCamera() : openGallery();
            }

            @Override
            public void onPermissionRequest(PermissionRequest request) {
                // 말로 하기(마이크): 앱 권한이 있으면 웹에도 허락
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                    request.grant(request.getResources());
                } else {
                    pendingWebPermission = request;
                    requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_PERM);
                }
            }
        });

        if (saved != null) web.restoreState(saved);
        else web.loadUrl(APP_URL);
        handleAlarmIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleAlarmIntent(intent);
    }

    @Override
    protected void onResume() {
        super.onResume();
        // 앱이 보이면 울리던 알람 알림은 거두고, 알람 화면은 웹이 띄운다
        ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).cancel(AlarmReceiver.NOTIFY_ID);
    }

    private void handleAlarmIntent(Intent intent) {
        if (intent == null || !intent.getBooleanExtra(EXTRA_ALARM, false)) return;
        intent.removeExtra(EXTRA_ALARM);
        // 알람으로 열렸으면 어르신 화면으로. 웹이 약 시간인 약을 보고 알람 화면을 띄운다
        web.evaluateJavascript("window.anbuNativeAlarm ? window.anbuNativeAlarm() : (location.hash = '#/senior')", null);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    private void openOutside(Uri u) {
        Intent i = "tel".equals(u.getScheme()) ? new Intent(Intent.ACTION_DIAL, u) : new Intent(Intent.ACTION_VIEW, u);
        try { startActivity(i); } catch (ActivityNotFoundException ignored) { }
    }

    private boolean openCamera() {
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_PERM);
            fileCallback.onReceiveValue(null);
            fileCallback = null;
            return true;
        }
        try {
            File dir = new File(getCacheDir(), "camera");
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
            File f = new File(dir, "photo_" + System.currentTimeMillis() + ".jpg");
            cameraUri = FileProvider.getUriForFile(this, getPackageName() + ".files", f);
            Intent i = new Intent(MediaStore.ACTION_IMAGE_CAPTURE).putExtra(MediaStore.EXTRA_OUTPUT, cameraUri)
                .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivityForResult(i, REQ_FILE);
            return true;
        } catch (Exception e) {
            cameraUri = null;
            return openGallery();
        }
    }

    private boolean openGallery() {
        cameraUri = null;
        Intent i = new Intent(Intent.ACTION_GET_CONTENT).setType("image/*").addCategory(Intent.CATEGORY_OPENABLE);
        try {
            startActivityForResult(Intent.createChooser(i, "사진 고르기"), REQ_FILE);
        } catch (ActivityNotFoundException e) {
            fileCallback.onReceiveValue(null);
            fileCallback = null;
        }
        return true;
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req != REQ_FILE || fileCallback == null) return;
        Uri[] result = null;
        if (res == RESULT_OK) {
            if (cameraUri != null) result = new Uri[]{cameraUri};
            else if (data != null && data.getData() != null) result = new Uri[]{data.getData()};
        }
        fileCallback.onReceiveValue(result);
        fileCallback = null;
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] perms, int[] results) {
        super.onRequestPermissionsResult(req, perms, results);
        if (pendingWebPermission != null) {
            boolean ok = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
            if (ok) pendingWebPermission.grant(pendingWebPermission.getResources());
            else pendingWebPermission.deny();
            pendingWebPermission = null;
        }
    }

    /** 웹에서 부르는 함수들 (window.AnbuApp.xxx) */
    private class Bridge {
        @JavascriptInterface
        public String version() { return appVersion(); }

        /** 약 알람 예약. json = [{"time":"08:00","label":"혈압약, 당뇨약","taken":false}, ...] */
        @JavascriptInterface
        public void setAlarms(String json) { AlarmScheduler.save(MainActivity.this, json); }

        /** 알람이 제대로 울리려면 필요한 설정이 남았는지: "" 이면 다 됨, 아니면 남은 것 이름 */
        @JavascriptInterface
        public String alarmSetupNeeded() {
            if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return "notify";
            if (Build.VERSION.SDK_INT >= 31 && !((AlarmManager) getSystemService(ALARM_SERVICE)).canScheduleExactAlarms()) return "exact";
            if (Build.VERSION.SDK_INT >= 34 && !((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).canUseFullScreenIntent()) return "fullscreen";
            return "";
        }

        /** 남은 설정 하나를 연다 (알림 허용 창, 또는 설정 화면) */
        @JavascriptInterface
        public void openAlarmSetup() {
            runOnUiThread(() -> {
                String need = alarmSetupNeeded();
                if ("notify".equals(need)) {
                    requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_PERM);
                } else if ("exact".equals(need)) {
                    startSettings(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM);
                } else if ("fullscreen".equals(need)) {
                    startSettings(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT);
                }
            });
        }
    }

    private String appVersion() {
        try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; }
        catch (PackageManager.NameNotFoundException e) { return "0"; }
    }

    private void startSettings(String action) {
        try {
            startActivity(new Intent(action, Uri.parse("package:" + getPackageName())));
        } catch (ActivityNotFoundException e) {
            startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName())));
        }
    }
}
