package com.frame.workbench;

import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import org.json.JSONObject;
import org.json.JSONArray;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

final class Exports {
    private static final int CREATE_DOCUMENT = 11;
    private final MainActivity activity;
    private final Backend backend;
    private final SharedPreferences state;
    private final ArrayDeque<Item> pending = new ArrayDeque<>();
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private Item choosing;

    private static final class Item {
        String name;
        String mime;
        File file;
        boolean temporary;
        InputStream open() throws Exception {
            return new FileInputStream(file);
        }
    }
    Exports(MainActivity activity, Backend backend) {
        this(activity, backend, false);
    }

    Exports(MainActivity activity, Backend backend, boolean restoringActivity) {
        this.activity = activity;
        this.backend = backend;
        this.state = activity.getSharedPreferences("frame-exports", Activity.MODE_PRIVATE);
        try {
            JSONObject saved = new JSONObject(state.getString("pending", "{}"));
            if (saved.has("choosing")) choosing = restore(saved.getJSONObject("choosing"));
            JSONArray queue = saved.optJSONArray("queue");
            if (queue != null) for (int i = 0; i < queue.length(); i++) pending.add(restore(queue.getJSONObject(i)));
            if (!restoringActivity && choosing != null) {
                if (choosing.temporary) choosing.file.delete();
                choosing = null;
                persist();
                activity.toast("上次文件保存已中断，可重新导出。");
            }
        } catch (Exception error) {
            state.edit().remove("pending").commit();
            activity.toast("上次文件保存未完成，请重新导出。");
        }
    }

    void resume() { next(); }

    private Item restore(JSONObject value) throws Exception {
        Item item = new Item();
        item.name = value.getString("name");
        item.mime = value.getString("mime");
        item.file = new File(value.getString("file"));
        item.temporary = value.optBoolean("temporary");
        if (!item.file.isFile()) throw new Exception("导出文件已不存在。");
        return item;
    }

    private JSONObject describe(Item item) throws Exception {
        return new JSONObject().put("name", item.name).put("mime", item.mime)
                .put("file", item.file.getAbsolutePath()).put("temporary", item.temporary);
    }

    private void persist() throws Exception {
        JSONObject saved = new JSONObject();
        if (choosing != null) saved.put("choosing", describe(choosing));
        JSONArray queue = new JSONArray();
        for (Item item : pending) queue.put(describe(item));
        saved.put("queue", queue);
        if (!state.edit().putString("pending", saved.toString()).commit()) throw new Exception("无法保存导出进度。");
    }

    void save(JSONObject body) throws Exception {
        Item item = new Item();
        item.name = body.optString("name", "frame-export").replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_");
        if (item.name.length() > 160) item.name = item.name.substring(0, 160);
        if (body.has("mediaId")) {
            item.file = backend.mediaFile(body.getString("mediaId"));
            if (!item.file.isFile()) throw new Exception("图片已不存在。");
            String id = body.getString("mediaId");
            item.mime = id.endsWith(".png") ? "image/png" : id.endsWith(".webp") ? "image/webp" : "image/jpeg";
            if (Build.VERSION.SDK_INT >= 29) {
                io.execute(() -> saveGallery(item));
                return;
            }
        } else {
            String text = body.getString("text");
            if (text.length() > 20 * 1024 * 1024) throw new Exception("导出文本过大。");
            item.file = File.createTempFile("frame-export-", ".tmp", activity.getCacheDir());
            item.temporary = true;
            try (OutputStream output = new FileOutputStream(item.file)) {
                output.write(text.getBytes(StandardCharsets.UTF_8));
            }
            item.mime = body.optString("type", "text/plain").split(";")[0];
            if (!item.mime.equals("application/json")) item.mime = "text/plain";
        }
        if (pending.size() > 100) throw new Exception("请先完成当前文件保存。");
        pending.add(item);
        persist();
        next();
    }

    private void saveGallery(Item item) {
        Uri uri = null;
        try {
            ContentValues values = new ContentValues();
            values.put(MediaStore.Images.Media.DISPLAY_NAME, item.name);
            values.put(MediaStore.Images.Media.MIME_TYPE, item.mime);
            values.put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/FRAME");
            values.put(MediaStore.Images.Media.IS_PENDING, 1);
            uri = activity.getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
            if (uri == null) throw new Exception("无法创建图片文件。");
            copy(item, uri);
            ContentValues complete = new ContentValues();
            complete.put(MediaStore.Images.Media.IS_PENDING, 0);
            activity.getContentResolver().update(uri, complete, null, null);
            activity.toast("已保存到相册 Pictures/FRAME");
        } catch (Exception error) {
            if (uri != null) activity.getContentResolver().delete(uri, null, null);
            activity.toast("图片保存失败：" + error.getMessage());
        }
    }

    private void next() {
        if (choosing != null || pending.isEmpty()) return;
        choosing = pending.remove();
        try { persist(); }
        catch (Exception error) { activity.toast(error.getMessage()); choosing = null; return; }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(choosing.mime);
        intent.putExtra(Intent.EXTRA_TITLE, choosing.name);
        try { activity.startActivityForResult(intent, CREATE_DOCUMENT); }
        catch (Exception error) {
            if (choosing.temporary) choosing.file.delete();
            choosing = null;
            try { persist(); } catch (Exception failure) { activity.toast(failure.getMessage()); }
            activity.toast("系统文件保存器不可用。");
            next();
        }
    }

    void onResult(int request, int result, Intent data) {
        if (request != CREATE_DOCUMENT || choosing == null) return;
        Item item = choosing;
        choosing = null;
        try { persist(); } catch (Exception error) { activity.toast(error.getMessage()); }
        if (result == Activity.RESULT_OK && data != null && data.getData() != null) {
            Uri uri = data.getData();
            io.execute(() -> {
                try { copy(item, uri); activity.toast("文件已保存"); }
                catch (Exception error) { activity.toast("保存失败：" + error.getMessage()); }
                finally { if (item.temporary) item.file.delete(); }
            });
        } else if (item.temporary) item.file.delete();
        next();
    }

    private void copy(Item item, Uri uri) throws Exception {
        try (InputStream input = item.open(); OutputStream output = activity.getContentResolver().openOutputStream(uri, "w")) {
            if (output == null) throw new Exception("无法写入所选位置。");
            byte[] bytes = new byte[65536];
            int count;
            while ((count = input.read(bytes)) != -1) output.write(bytes, 0, count);
        }
    }
    void close() { io.shutdown(); }
}
