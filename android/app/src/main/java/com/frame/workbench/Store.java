package com.frame.workbench;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import android.util.Base64;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.KeyStore;
import java.util.Arrays;
import java.util.UUID;
import java.util.concurrent.Semaphore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class Store {
    private static final Object KEY_LOCK = new Object();
    private static final Semaphore IMAGE_DECODERS = new Semaphore(2);
    private static final String KEY_ALIAS = "frame.credentials.v1";
    private static final int MAX_SETTINGS_BYTES = 16 * 1024 * 1024;
    private static final int MAX_JOBS_BYTES = 128 * 1024 * 1024;
    final File root;
    private final File temporary;

    Store(Context context) throws Exception {
        root = new File(context.getFilesDir(), "frame");
        temporary = new File(root, "temp");
        for (File directory : Arrays.asList(root, temporary, new File(root, "uploads"), new File(root, "outputs")))
            if (!directory.isDirectory() && !directory.mkdirs()) throw new Exception("无法创建应用存储目录，请检查剩余空间。");
    }

    JSONObject readSettings(JSONObject fallback) throws Exception {
        byte[] bytes = read("settings.enc", MAX_SETTINGS_BYTES);
        if (bytes == null) return new JSONObject(fallback.toString());
        JSONObject envelope = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, secret(), new GCMParameterSpec(128,
            Base64.decode(envelope.getString("iv"), Base64.NO_WRAP)));
        return new JSONObject(new String(cipher.doFinal(Base64.decode(
            envelope.getString("data"), Base64.NO_WRAP)), StandardCharsets.UTF_8));
    }

    void writeSettings(JSONObject settings) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, secret());
        JSONObject envelope = new JSONObject().put("version", 1)
            .put("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
            .put("data", Base64.encodeToString(cipher.doFinal(settings.toString()
                .getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP));
        writeAtomic(new File(root, "settings.enc"), envelope.toString().getBytes(StandardCharsets.UTF_8), MAX_SETTINGS_BYTES);
    }

    JSONArray readJobs() throws Exception {
        byte[] bytes = read("jobs.json", MAX_JOBS_BYTES);
        return bytes == null ? new JSONArray() : new JSONArray(new String(bytes, StandardCharsets.UTF_8));
    }

    void writeJobs(JSONArray jobs) throws Exception {
        writeAtomic(new File(root, "jobs.json"), jobs.toString().getBytes(StandardCharsets.UTF_8), MAX_JOBS_BYTES);
    }

    private byte[] read(String name, int limit) throws Exception {
        AtomicFile file = new AtomicFile(new File(root, name));
        if (!file.getBaseFile().exists() && !new File(root, name + ".bak").exists()) return null;
        try (InputStream in = file.openRead(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[16384];
            int count;
            while ((count = in.read(buffer)) != -1) {
                if ((long) out.size() + count > limit) throw new Exception("本地记录过大，无法读取。");
                out.write(buffer, 0, count);
            }
            return out.toByteArray();
        }
    }

    static void writeAtomic(File target, byte[] bytes, int limit) throws Exception {
        if (bytes.length > limit) throw new Exception("本地记录过大，请删除不需要的历史任务。");
        AtomicFile file = new AtomicFile(target);
        FileOutputStream out = null;
        try {
            out = file.startWrite();
            out.write(bytes);
            out.flush();
            out.getFD().sync();
            file.finishWrite(out);
        } catch (Exception error) {
            if (out != null) file.failWrite(out);
            throw error;
        }
    }

    File resolve(String id) throws Exception {
        if (id == null || !id.matches("^(uploads|outputs)/[a-f0-9-]+\\.(png|jpeg|webp)$"))
            throw new Exception("图片标识无效。");
        File file = new File(root, id);
        if (!file.getCanonicalPath().startsWith(root.getCanonicalPath() + File.separator))
            throw new Exception("图片路径无效。");
        return file;
    }

    File media(String id) throws Exception {
        File file = resolve(id);
        if (!file.isFile()) throw new Exception("参考图片已不存在，请重新上传。");
        return file;
    }

    File temporary() throws Exception { return File.createTempFile("frame-", ".part", temporary); }

    void clearTemporary() {
        File[] files = temporary.listFiles();
        if (files != null) for (File file : files) if (file.isFile()) file.delete();
    }

    JSONObject saveImage(File source, String area, String name, long limit) throws Exception {
        if (source.length() == 0 || source.length() > limit) throw new Exception("图片为空或文件过大。");
        IMAGE_DECODERS.acquire();
        String format;
        int width, height;
        try {
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeFile(source.getAbsolutePath(), bounds);
            width = bounds.outWidth;
            height = bounds.outHeight;
            if (width < 1 || height < 1 || (long) width * height > 50_000_000)
                throw new Exception("文件不是有效图片，或像素超过 5000 万。");
            if ("image/png".equals(bounds.outMimeType)) format = "png";
            else if ("image/jpeg".equals(bounds.outMimeType)) format = "jpeg";
            else if ("image/webp".equals(bounds.outMimeType)) format = "webp";
            else throw new Exception("图片格式只支持 PNG、JPEG、WebP。");
            BitmapFactory.Options check = new BitmapFactory.Options();
            check.inSampleSize = 1;
            while (Math.max(width, height) / check.inSampleSize > 256) check.inSampleSize *= 2;
            Bitmap decoded = BitmapFactory.decodeFile(source.getAbsolutePath(), check);
            if (decoded == null) throw new Exception("文件不是有效图片。");
            decoded.recycle();
        } finally { IMAGE_DECODERS.release(); }
        String id = area + "/" + UUID.randomUUID() + "." + format;
        File destination = resolve(id);
        Files.move(source.toPath(), destination.toPath(), StandardCopyOption.ATOMIC_MOVE);
        JSONObject result = new JSONObject().put("id", id).put("url", "/media/" + id)
            .put("width", width).put("height", height).put("bytes", destination.length());
        if (area.equals("outputs")) result.put("format", format);
        else {
            String safeName = name.replace('\\', '/');
            safeName = safeName.substring(safeName.lastIndexOf('/') + 1);
            result.put("name", safeName.substring(0, Math.min(safeName.length(), 120)));
        }
        return result;
    }

    private static SecretKey secret() throws Exception {
        synchronized (KEY_LOCK) {
            KeyStore store = KeyStore.getInstance("AndroidKeyStore");
            store.load(null);
            SecretKey existing = (SecretKey) store.getKey(KEY_ALIAS, null);
            if (existing != null) return existing;
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true).build());
            return generator.generateKey();
        }
    }
}
