package fr.sacha.tvhome;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.content.Intent;
import android.view.accessibility.AccessibilityEvent;

import java.util.Arrays;
import java.util.List;

/**
 * Google TV can't have its home screen disabled (a protected recovery screen loops instead),
 * so this service watches for the stock home coming to the front and replaces it with ours.
 * Enable with:
 *   adb shell settings put secure enabled_accessibility_services fr.sacha.tvhome/.HomeRedirectService
 *   adb shell settings put secure accessibility_enabled 1
 */
public class HomeRedirectService extends AccessibilityService {

    private static final List<String> STOCK_HOMES = Arrays.asList(
            "com.google.android.apps.tv.launcherx", // Google TV
            "com.google.android.tvlauncher");       // Android TV

    @Override
    protected void onServiceConnected() {
        AccessibilityServiceInfo info = new AccessibilityServiceInfo();
        info.eventTypes = AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED;
        info.feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC;
        info.packageNames = STOCK_HOMES.toArray(new String[0]);
        info.notificationTimeout = 0;
        setServiceInfo(info);
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event.getEventType() != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return;
        CharSequence pkg = event.getPackageName();
        if (pkg == null || !STOCK_HOMES.contains(pkg.toString())) return;
        startActivity(new Intent(this, HomeActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
                        | Intent.FLAG_ACTIVITY_NO_ANIMATION));
    }

    @Override
    public void onInterrupt() { }
}
