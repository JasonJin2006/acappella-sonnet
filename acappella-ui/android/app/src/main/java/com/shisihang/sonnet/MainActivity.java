package com.shisihang.sonnet;

import android.os.Bundle;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 原生音频引擎插件必须在 super.onCreate 之前注册，
        // 否则 Capacitor 建桥时扫不到它。
        registerPlugin(NativeAudioPlugin.class);
        super.onCreate(savedInstanceState);
    }

    // 返回键先交给页面处理：不在跟谱页就回到跟谱，在跟谱页才退到后台。
    @Override
    public void onBackPressed() {
        Bridge bridge = getBridge();
        WebView webView = bridge != null ? bridge.getWebView() : null;
        if (webView == null) {
            super.onBackPressed();
            return;
        }
        // 用 '1' / '0' 做哨兵：evaluateJavascript 会把结果包成 JSON 字符串，
        // 直接比较布尔值容易踩转义的坑。
        webView.evaluateJavascript(
            "window.__back ? (window.__back() ? '1' : '0') : '0'",
            value -> {
                if (value == null || !value.contains("1")) moveTaskToBack(true);
            });
    }
}
