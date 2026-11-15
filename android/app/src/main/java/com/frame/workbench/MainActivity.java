package com.frame.workbench;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONObject;
import java.io.ByteArrayInputStream;
import java.io.FileInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.ArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {
    static final String ORIGIN = "https://frame.local";
    private static final int PICK_FILES = 10;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService bridge = Executors.newFixedThreadPool(4);
    private WebView web;
    private Backend backend;
    private Exports exports;
    private ValueCallback<Uri[]> fileCallback;
    private volatile boolean trusted = false;
    private boolean documentReady = false;
    private final ArrayList<String> deferredReplies = new ArrayList<>();
    private boolean destroyed = false;
    private long lastBack = 0;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        try {
            PackageInfo provider = WebView.getCurrentWebViewPackage();
            int major = provider == null ? 0 : Integer.parseInt(provider.versionName.split("\\.")[0]);
            if (major < 105) {
                showError("请先更新 Android System WebView 或 Chrome 至 105 及以上版本，再打开 FRAME。");
                return;
            }
            backend = Backend.get(getApplicationContext());
            try (InputStream entry = getAssets().open("index.html")) {
                if (entry.read() == -1) throw new Exception("安装包缺少工作台页面，请重新安装完整 APK。");
            }
            if (Build.VERSION.SDK_INT >= 27) {
                getWindow().setNavigationBarColor(Color.rgb(245, 246, 247));
                getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
            }
            android.content.Context app = getApplicationContext();
            backend.setListener(() -> GenerationService.refresh(app));
            exports = new Exports(this, backend, state != null);
            web = new WebView(this);
            WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
            web.setBackgroundColor(Color.rgb(245, 246, 247));
            WebSettings settings = web.getSettings();
            settings.setJavaScriptEnabled(true);
            settings.setDomStorageEnabled(true);
            settings.setAllowFileAccess(false);
            settings.setAllowContentAccess(true);
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
            settings.setSupportMultipleWindows(false);
            settings.setJavaScriptCanOpenWindowsAutomatically(false);
            settings.setMediaPlaybackRequiresUserGesture(true);
            settings.setTextZoom(Math.max(100, Math.min(160, Math.round(getResources().getConfiguration().fontScale * 100))));
            web.addJavascriptInterface(new NativeBridge(), "FrameNative");
            web.setWebViewClient(new LocalContent());
            web.setWebChromeClient(new WebChromeClient() {
                @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                    if (!trusted) return false;
                    if (fileCallback != null) fileCallback.onReceiveValue(null);
                    fileCallback = callback;
                    Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    String[] types = params.getAcceptTypes();
                    boolean images = false;
                    for (String type : types) if (type != null && type.startsWith("image/")) images = true;
                    intent.setType(images ? "image/*" : "*/*");
                    if (images) intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"image/png", "image/jpeg", "image/webp"});
                    intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    try { startActivityForResult(intent, PICK_FILES); }
                    catch (Exception error) {
                        callback.onReceiveValue(null);
                        fileCallback = null;
                        toast("未找到可用的系统文件选择器。");
                    }
                    return true;
                }
            });
            setContentView(web);
            trusted = true;
            web.loadUrl(ORIGIN + "/");
        } catch (Exception error) {
            showError("无法启动工作台：" + error.getMessage());
        }
    }

    private void showError(String message) {
        LinearLayout layout = new LinearLayout(this);
        layout.setPadding(40, 80, 40, 40);
        layout.setOrientation(LinearLayout.VERTICAL);
        TextView title = new TextView(this);
        title.setText("FRAME 图像工作台");
        title.setTextSize(24);
        layout.addView(title);
        TextView detail = new TextView(this);
        detail.setPadding(0, 30, 0, 0);
        detail.setText(message);
        detail.setTextSize(16);
        layout.addView(detail);
        setContentView(layout);
    }

    private static boolean local(Uri uri) {
        return "https".equals(uri.getScheme()) && "frame.local".equals(uri.getHost())
                && uri.getPort() == -1 && uri.getUserInfo() == null;
    }

    private class LocalContent extends WebViewClient {
        @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            trusted = local(Uri.parse(url));
            documentReady = false;
        }
        @Override public void onPageFinished(WebView view, String url) {
            if (!local(Uri.parse(url))) return;
            documentReady = true;
            for (String script : deferredReplies) view.evaluateJavascript(script, null);
            deferredReplies.clear();
        }
        @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return !local(request.getUrl());
        }
        @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (!local(uri) || !"GET".equals(request.getMethod())) return response("text/plain", 403, "Forbidden", new ByteArrayInputStream(new byte[0]), false);
            try {
                String path = uri.getPath();
                if (path == null || path.contains("..") || path.contains("\\") || path.contains("\0")) throw new Exception("Invalid path");
                InputStream stream;
                String mime;
                if (path.startsWith("/media/")) {
                    String id = path.substring(7);
                    stream = new FileInputStream(backend.mediaFile(id));
                    mime = id.endsWith(".png") ? "image/png" : id.endsWith(".webp") ? "image/webp" : "image/jpeg";
                } else {
                    String asset = path.equals("/") ? "index.html" : path.substring(1);
                    stream = getAssets().open(asset);
                    mime = asset.endsWith(".html") ? "text/html" : asset.endsWith(".js") ? "application/javascript"
                            : asset.endsWith(".css") ? "text/css" : asset.endsWith(".svg") ? "image/svg+xml"
                            : asset.endsWith(".jpg") ? "image/jpeg" : asset.endsWith(".png") ? "image/png"
                            : asset.endsWith(".woff2") ? "font/woff2" : "application/octet-stream";
                }
                return response(mime, 200, "OK", stream, path.endsWith(".html") || path.equals("/"));
            } catch (Exception error) {
                return response("text/plain", 404, "Not Found", new ByteArrayInputStream(new byte[0]), false);
            }
        }
        @Override public void onReceivedError(WebView view, android.webkit.WebResourceRequest request, android.webkit.WebResourceError error) {
            if (request.isForMainFrame()) showError("页面载入失败，请重新打开应用。");
        }
        @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse error) {
            if (request.isForMainFrame() || request.getUrl().getPath().endsWith(".js")) {
                main.post(() -> showError("安装包中的工作台资源无法载入，请重新安装完整 APK。"));
            }
        }
        @Override public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
            trusted = false;
            view.destroy();
            web = null;
            new AlertDialog.Builder(MainActivity.this).setTitle("工作台需要重新打开")
                    .setMessage("系统回收了页面进程。已提交的任务仍由原生服务处理。")
                    .setPositiveButton("重新打开", (dialog, which) -> recreate()).setCancelable(false).show();
            return true;
        }
    }

    private static WebResourceResponse response(String mime, int status, String reason, InputStream stream, boolean html) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        headers.put("X-Content-Type-Options", "nosniff");
        headers.put("Referrer-Policy", "no-referrer");
        if (html) headers.put("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'");
        return new WebResourceResponse(mime, "UTF-8", status, reason, headers, stream);
    }

    private class NativeBridge {
        @JavascriptInterface public void request(String payload) {
            if (!trusted || destroyed) return;
            bridge.execute(() -> {
                String id = "";
                try {
                    if (payload == null || payload.length() > 30 * 1024 * 1024) throw new Exception("请求内容过大。");
                    JSONObject input = new JSONObject(payload);
                    id = input.getString("id");
                    if (!id.matches("[A-Za-z0-9-]{1,80}")) throw new Exception("请求标识无效。");
                    String route = input.getString("route");
                    String method = input.optString("method", "GET");
                    JSONObject body = input.optJSONObject("body");
                    if (body == null) body = new JSONObject();
                    if (route.equals("/export") && method.equals("POST")) {
                        JSONObject exportBody = body;
                        String requestId = id;
                        main.post(() -> {
                            try { exports.save(exportBody); reply(requestId, new JSONObject().put("ok", true), null); }
                            catch (Exception error) { reply(requestId, null, error.getMessage()); }
                        });
                        return;
                    }
                    if (route.equals("/clipboard") && method.equals("POST")) {
                        String text = body.getString("text");
                        if (text.length() > 200000) throw new Exception("复制内容过长，请改用下载提示词。");
                        String requestId = id;
                        main.post(() -> {
                            try {
                                ClipboardManager clipboard = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                                clipboard.setPrimaryClip(ClipData.newPlainText("FRAME", text));
                                reply(requestId, new JSONObject(), null);
                            } catch (Exception error) { reply(requestId, null, "系统剪贴板不可用，请下载提示词文件。"); }
                        });
                        return;
                    }
                    if (route.equals("/jobs") && method.equals("POST")) main.post(MainActivity.this::askNotificationPermission);
                    JSONObject result = backend.call(method, route, body);
                    reply(id, result, null);
                } catch (Exception error) {
                    reply(id, null, error.getMessage() == null ? "手机服务请求失败。" : error.getMessage());
                }
            });
        }
    }

    private void askNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            if (!getPreferences(MODE_PRIVATE).getBoolean("notificationAsked", false)) {
                getPreferences(MODE_PRIVATE).edit().putBoolean("notificationAsked", true).apply();
                requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 20);
            }
        }
    }

    private void reply(String id, JSONObject data, String error) {
        try {
            JSONObject response = new JSONObject().put("id", id).put("ok", error == null);
            if (error == null) response.put("data", data); else response.put("error", error);
            String script = "window.__frameNativeResolve && window.__frameNativeResolve(" + response + ")";
            main.post(() -> {
                if (destroyed || web == null || !trusted) return;
                if (documentReady) web.evaluateJavascript(script, null);
                else deferredReplies.add(script);
            });
        } catch (Exception ignored) {}
    }

    void toast(String text) {
        main.post(() -> { if (!destroyed) android.widget.Toast.makeText(this, text, android.widget.Toast.LENGTH_LONG).show(); });
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == PICK_FILES && fileCallback != null) {
            Uri[] values = null;
            if (result == RESULT_OK && data != null) {
                ClipData clips = data.getClipData();
                if (clips != null) {
                    values = new Uri[Math.min(16, clips.getItemCount())];
                    for (int i = 0; i < values.length; i++) values[i] = clips.getItemAt(i).getUri();
                } else if (data.getData() != null) values = new Uri[]{data.getData()};
            }
            fileCallback.onReceiveValue(values);
            fileCallback = null;
        } else if (exports != null) exports.onResult(request, result, data);
    }

    @Override public void onBackPressed() {
        if (web == null) { super.onBackPressed(); return; }
        String script = "(function(){var ds=document.querySelectorAll('[aria-modal=\"true\"]');"
                + "if(ds.length){var d=ds[ds.length-1];var b=d.querySelector('button[aria-label^=\"关闭\"],button[title^=\"关闭\"]');"
                + "if(b&&!b.disabled)b.click();return true;}"
                + "if(document.querySelector('.mobile-open')){window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));return true;}return false;})()";
        web.evaluateJavascript(script, result -> {
            if ("true".equals(result)) return;
            long now = android.os.SystemClock.elapsedRealtime();
            if (now - lastBack < 2000) moveTaskToBack(true);
            else { lastBack = now; toast(backend.activeCount() > 0 ? "任务正在后台生成。再次返回以离开工作台。" : "再次返回以离开工作台。"); }
        });
    }

    @Override protected void onPause() {
        if (web != null) {
            web.evaluateJavascript("window.dispatchEvent(new Event('pagehide'))", null);
            web.onPause();
        }
        super.onPause();
    }
    @Override protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
        if (exports != null) exports.resume();
    }
    @Override protected void onDestroy() {
        destroyed = true;
        trusted = false;
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        fileCallback = null;
        if (exports != null) exports.close();
        if (web != null) { web.removeJavascriptInterface("FrameNative"); web.destroy(); web = null; }
        bridge.shutdown();
        super.onDestroy();
    }
}
