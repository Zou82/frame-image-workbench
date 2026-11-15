package com.frame.workbench;

import android.util.Base64;
import android.util.Base64InputStream;
import android.util.JsonReader;
import android.util.JsonToken;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.FilterInputStream;
import java.io.FilterOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.PushbackReader;
import java.io.Reader;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CancellationException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

final class Provider {
    private static final ScheduledExecutorService TIMERS = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread thread = new Thread(r, "frame-timeouts");
        thread.setDaemon(true);
        return thread;
    });
    private final Store store;

    Provider(Store store) { this.store = store; }

    static final class Control {
        private volatile boolean cancelled;
        private final Set<HttpURLConnection> connections = Collections.newSetFromMap(new ConcurrentHashMap<>());
        void cancel() {
            cancelled = true;
            for (HttpURLConnection connection : connections) connection.disconnect();
        }
        void check() {
            if (cancelled || Thread.currentThread().isInterrupted()) throw new CancellationException("任务已取消。");
        }
        void add(HttpURLConnection connection) {
            connections.add(connection);
            if (cancelled) { connection.disconnect(); check(); }
        }
        void remove(HttpURLConnection connection) { connections.remove(connection); }
    }

    JSONArray models(JSONObject profile) throws Exception {
        String key = profile.getString("apiKey");
        String endpoint = profile.getString("baseUrl") + "/models";
        Control control = new Control();
        HttpURLConnection connection = open(endpoint, 20000, control);
        connection.setRequestProperty("Authorization", "Bearer " + key);
        AtomicBoolean expired = new AtomicBoolean();
        ScheduledFuture<?> deadline = TIMERS.schedule(() -> {
            expired.set(true);
            connection.disconnect();
        }, 20, TimeUnit.SECONDS);
        try {
            int status = connection.getResponseCode();
            JSONObject result = smallJson(connection, status, 4 * 1024 * 1024);
            if (status < 200 || status >= 300)
                throw new Exception("GET " + endpoint + " (HTTP " + status + "): " + errorMessage(result, connection));
            Object raw = result.opt("data");
            if (!(raw instanceof JSONArray)) throw new Exception("接口没有返回有效模型列表。");
            JSONArray data = (JSONArray) raw;
            if (data.length() > 1000) throw new Exception("接口返回的模型超过 1000 个，原列表已保留。");
            JSONArray models = new JSONArray();
            Set<String> seen = new java.util.HashSet<>();
            for (int i = 0; i < data.length(); i++) {
                Object item = data.get(i);
                Object value = item instanceof JSONObject ? ((JSONObject) item).opt("id") : null;
                if (!(value instanceof String) || ((String) value).trim().isEmpty() || ((String) value).length() > 200)
                    throw new Exception("接口返回了无效模型 ID，原列表已保留。");
                String id = ((String) value).trim();
                if (seen.add(id)) models.put(id);
            }
            return models;
        } catch (Exception error) {
            if (expired.get() || error instanceof java.net.SocketTimeoutException) throw new Exception("获取模型超时，请检查网络和 API 地址。");
            throw new Exception(TaskRules.redact(error.getMessage(), key));
        }
        finally { deadline.cancel(false); control.remove(connection); connection.disconnect(); }
    }

    JSONArray generate(JSONObject task, JSONObject profile, Control control) throws Exception {
        String key = profile.getString("apiKey");
        ArrayList<File> temporary = new ArrayList<>();
        ArrayList<String> written = new ArrayList<>();
        HttpURLConnection connection = null;
        ScheduledFuture<?> deadline = null;
        AtomicBoolean expired = new AtomicBoolean();
        try {
            control.check();
            JSONObject payload = new JSONObject(task.getJSONObject("extra").toString());
            for (String field : new String[]{"model", "prompt", "n", "size", "quality", "background"})
                payload.put(field, task.get(field));
            payload.put("output_format", task.getString("outputFormat"));
            JSONArray references = task.getJSONArray("references");
            boolean editing = references.length() > 0;
            int timeout = profile.getInt("timeout") * 1000;
            connection = open(profile.getString("baseUrl") + "/images/" + (editing ? "edits" : "generations"), timeout, control);
            HttpURLConnection timedConnection = connection;
            deadline = TIMERS.schedule(() -> {
                expired.set(true);
                timedConnection.disconnect();
            }, timeout, TimeUnit.MILLISECONDS);
            connection.setRequestMethod("POST");
            connection.setRequestProperty("Authorization", "Bearer " + key);
            connection.setDoOutput(true);
            if (editing) multipart(connection, payload, references, control);
            else {
                byte[] bytes = payload.toString().getBytes(StandardCharsets.UTF_8);
                connection.setRequestProperty("Content-Type", "application/json");
                connection.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream out = connection.getOutputStream()) { out.write(bytes); }
            }
            control.check();
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) {
                JSONObject error = smallJson(connection, status, 1024 * 1024);
                throw new Exception("HTTP " + status + ": " + errorMessage(error, connection));
            }
            long responseLimit = (TaskRules.MAX_IMAGE * 4 / 3 + 1024 * 1024) * 10;
            Map<String, File> spooled = new HashMap<>();
            JSONObject response;
            try (InputStream in = new LimitedInput(connection.getInputStream(), responseLimit, control);
                 SpoolingReader transformed = new SpoolingReader(new InputStreamReader(in, StandardCharsets.UTF_8), spooled, temporary, control);
                 JsonReader json = new JsonReader(transformed)) {
                Object parsed = readJson(json, 0, new int[]{0});
                if (!(parsed instanceof JSONObject) || json.peek() != JsonToken.END_DOCUMENT)
                    throw new Exception("API 返回了无效的 JSON。");
                response = (JSONObject) parsed;
            }
            deadline.cancel(false);
            deadline = null;
            control.remove(connection);
            connection.disconnect();
            connection = null;
            Object raw = response.opt("data");
            if (!(raw instanceof JSONArray) || ((JSONArray) raw).length() < 1 || ((JSONArray) raw).length() > 10)
                throw new Exception("API 未返回 1 到 10 张有效图片，请确认模型支持 Images API。");
            JSONArray data = (JSONArray) raw;
            JSONArray results = new JSONArray();
            for (int i = 0; i < data.length(); i++) {
                control.check();
                Object rawItem = data.get(i);
                if (!(rawItem instanceof JSONObject)) throw new Exception("API 返回的图片结果无效。");
                JSONObject item = (JSONObject) rawItem;
                File file = null;
                Object b64 = item.opt("b64_json");
                if (b64 instanceof String) file = spooled.get(b64);
                if (file != null && file.length() == 0 && item.opt("url") instanceof String) file = null;
                if (file == null && item.opt("url") instanceof String) {
                    file = store.temporary();
                    temporary.add(file);
                    download(item.getString("url"), file, control);
                }
                if (file == null) throw new Exception("API 没有返回有效图片。");
                JSONObject result = store.saveImage(file, "outputs", "", TaskRules.MAX_IMAGE);
                written.add(result.getString("id"));
                Object revision = item.opt("revised_prompt");
                result.put("revisedPrompt", revision instanceof String ? revision : "");
                results.put(result);
            }
            control.check();
            return results;
        } catch (Exception error) {
            for (String id : written) try { store.resolve(id).delete(); } catch (Exception ignored) { }
            control.check();
            if (expired.get() || error instanceof java.net.SocketTimeoutException)
                throw new Exception("生成请求超时，请在连接设置中增加超时时间后手动重试。");
            throw new Exception(TaskRules.redact(error.getMessage(), key));
        } finally {
            if (deadline != null) deadline.cancel(false);
            if (connection != null) { control.remove(connection); connection.disconnect(); }
            for (File file : temporary) file.delete();
        }
    }

    private void multipart(HttpURLConnection connection, JSONObject payload, JSONArray references, Control control) throws Exception {
        String boundary = "frame-" + UUID.randomUUID();
        connection.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
        ArrayList<byte[]> headers = new ArrayList<>();
        ArrayList<File> files = new ArrayList<>();
        ByteArrayOutputStream fields = new ByteArrayOutputStream();
        for (String key : TaskRules.keys(payload)) {
            Object value = payload.get(key);
            if (value == JSONObject.NULL) continue;
            String text = value.toString();
            String safeKey = key.replace("\r", "%0D").replace("\n", "%0A").replace("\"", "%22");
            fields.write(("--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + safeKey
                + "\"\r\n\r\n" + text + "\r\n").getBytes(StandardCharsets.UTF_8));
        }
        byte[] beginning = fields.toByteArray();
        byte[] ending = ("--" + boundary + "--\r\n").getBytes(StandardCharsets.US_ASCII);
        long length = beginning.length + ending.length;
        for (int i = 0; i < references.length(); i++) {
            File file = store.media(references.getString(i));
            String name = file.getName();
            String format = name.substring(name.lastIndexOf('.') + 1);
            byte[] header = ("--" + boundary + "\r\nContent-Disposition: form-data; name=\""
                + (references.length() == 1 ? "image" : "image[]") + "\"; filename=\"" + name
                + "\"\r\nContent-Type: image/" + format + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII);
            headers.add(header);
            files.add(file);
            length += header.length + file.length() + 2;
        }
        connection.setFixedLengthStreamingMode(length);
        try (OutputStream out = connection.getOutputStream()) {
            out.write(beginning);
            byte[] buffer = new byte[16384];
            for (int i = 0; i < files.size(); i++) {
                out.write(headers.get(i));
                try (InputStream in = new FileInputStream(files.get(i))) {
                    int count;
                    while ((count = in.read(buffer)) != -1) { control.check(); out.write(buffer, 0, count); }
                }
                out.write(new byte[]{'\r', '\n'});
            }
            out.write(ending);
        }
    }

    private void download(String address, File file, Control control) throws Exception {
        HttpURLConnection connection = open(address, 60000, control);
        AtomicBoolean expired = new AtomicBoolean();
        ScheduledFuture<?> deadline = TIMERS.schedule(() -> {
            expired.set(true);
            connection.disconnect();
        }, 60, TimeUnit.SECONDS);
        try {
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) throw new Exception("结果图片下载失败（HTTP " + status + "）。");
            if (connection.getContentLengthLong() > TaskRules.MAX_IMAGE) throw new Exception("返回图片超过 75 MB。");
            try (InputStream in = new LimitedInput(connection.getInputStream(), TaskRules.MAX_IMAGE, control);
                 OutputStream out = new FileOutputStream(file)) {
                byte[] buffer = new byte[16384];
                int count;
                while ((count = in.read(buffer)) != -1) { control.check(); out.write(buffer, 0, count); }
            }
        } catch (Exception error) {
            control.check();
            if (expired.get() || error instanceof java.net.SocketTimeoutException) throw new Exception("结果图片下载超时，请手动重试。");
            throw error;
        } finally { deadline.cancel(false); control.remove(connection); connection.disconnect(); }
    }

    private static HttpURLConnection open(String address, int timeout, Control control) throws Exception {
        URI uri = new URI(address);
        if (!("http".equals(uri.getScheme()) || "https".equals(uri.getScheme())) || uri.getHost() == null
            || uri.getRawUserInfo() != null || uri.getRawFragment() != null)
            throw new Exception("API 返回了无效的 HTTP(S) 图片地址。");
        HttpURLConnection connection = (HttpURLConnection) new URL(address).openConnection();
        connection.setConnectTimeout(Math.min(timeout, 20000));
        connection.setReadTimeout(timeout);
        connection.setInstanceFollowRedirects(false);
        connection.setUseCaches(false);
        connection.setRequestProperty("Accept", "application/json");
        control.add(connection);
        return connection;
    }

    private static JSONObject smallJson(HttpURLConnection connection, int status, int limit) throws Exception {
        InputStream stream = status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream();
        if (stream == null) throw new Exception("HTTP " + status + "：接口返回了空响应。");
        try (InputStream in = new LimitedInput(stream, limit, new Control());
             ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[16384];
            int count;
            while ((count = in.read(buffer)) != -1) out.write(buffer, 0, count);
            try { return new JSONObject(out.toString("UTF-8")); }
            catch (Exception error) { throw new Exception("API 返回了非 JSON 响应（HTTP " + status + "），请检查接口地址。"); }
        }
    }

    private static String errorMessage(JSONObject result, HttpURLConnection connection) throws Exception {
        JSONObject error = result.optJSONObject("error");
        Object value = error == null ? result.opt("message") : error.opt("message");
        String message = value instanceof String ? (String) value : connection.getResponseMessage();
        return message == null ? "请求失败。" : message.substring(0, Math.min(message.length(), 4000));
    }

    private static Object readJson(JsonReader reader, int depth, int[] entries) throws Exception {
        if (depth > 32 || ++entries[0] > 20000) throw new Exception("API 返回的 JSON 结构过于复杂。");
        switch (reader.peek()) {
            case BEGIN_OBJECT:
                JSONObject object = new JSONObject();
                reader.beginObject();
                while (reader.hasNext()) {
                    String name = reader.nextName();
                    if (name.length() > 10000) throw new Exception("API 返回的 JSON 字段名过长。");
                    object.put(name, readJson(reader, depth + 1, entries));
                }
                reader.endObject();
                return object;
            case BEGIN_ARRAY:
                JSONArray array = new JSONArray();
                reader.beginArray();
                while (reader.hasNext()) array.put(readJson(reader, depth + 1, entries));
                reader.endArray();
                return array;
            case STRING: return reader.nextString();
            case NUMBER:
                String number = reader.nextString();
                try { return Long.valueOf(number); }
                catch (NumberFormatException ignored) {
                    double value = Double.parseDouble(number);
                    if (!Double.isFinite(value)) throw new Exception("API 返回了无效的 JSON 数值。");
                    return value;
                }
            case BOOLEAN: return reader.nextBoolean();
            case NULL: reader.nextNull(); return JSONObject.NULL;
            default: throw new Exception("API 返回的 JSON 格式无效。");
        }
    }

    private static final class LimitedInput extends FilterInputStream {
        private final long limit;
        private final Control control;
        private long read;
        LimitedInput(InputStream input, long limit, Control control) { super(input); this.limit = limit; this.control = control; }
        private void count(int size) throws IOException {
            control.check();
            if (size > 0 && (read += size) > limit) throw new IOException("接口响应超过允许的大小。");
        }
        @Override public int read() throws IOException { int value = in.read(); count(value < 0 ? 0 : 1); return value; }
        @Override public int read(byte[] bytes, int offset, int length) throws IOException {
            int size = in.read(bytes, offset, length); count(size); return size;
        }
    }

    // Substitute bounded file tokens for image strings before the platform JSON parser sees them.
    private final class SpoolingReader extends Reader {
        private final PushbackReader source;
        private final Map<String, File> images;
        private final ArrayList<File> temporary;
        private final Control control;
        private String pending = "";
        private int position;
        private int metadata;
        SpoolingReader(Reader source, Map<String, File> images, ArrayList<File> temporary, Control control) {
            this.source = new PushbackReader(new BufferedReader(source, 16384), 2);
            this.images = images; this.temporary = temporary; this.control = control;
        }
        @Override public int read(char[] chars, int offset, int length) throws IOException {
            if (length == 0) return 0;
            int count = 0;
            while (count < length) {
                if (position >= pending.length()) {
                    int next = source.read();
                    if (next < 0) return count == 0 ? -1 : count;
                    try { pending = next == '"' ? token() : Character.toString((char) next); }
                    catch (Exception error) { throw error instanceof IOException ? (IOException) error : new IOException(error.getMessage(), error); }
                    position = 0;
                    countMetadata(pending.length());
                }
                int size = Math.min(length - count, pending.length() - position);
                pending.getChars(position, position + size, chars, offset + count);
                position += size;
                count += size;
            }
            return count;
        }
        private String token() throws Exception {
            StringBuilder value = new StringBuilder("\"");
            boolean escaped = false;
            while (true) {
                int next = source.read();
                if (next < 0) throw new IOException("API 返回的 JSON 字符串不完整。");
                value.append((char) next);
                if (value.length() > 1024 * 1024) throw new IOException("API 返回的 JSON 字符串过长。");
                if (next == '"' && !escaped) break;
                if (next == '\\' && !escaped) escaped = true; else escaped = false;
            }
            if (!value.toString().equals("\"b64_json\"")
                && !value.toString().contains("\\u")) return value.toString();
            String decoded = new JSONObject("{\"key\":" + value + "}").getString("key");
            if (!decoded.equals("b64_json")) return value.toString();
            int next;
            while ((next = source.read()) >= 0 && Character.isWhitespace(next)) countMetadata(1);
            if (next != ':') { if (next >= 0) source.unread(next); return value.toString(); }
            while ((next = source.read()) >= 0 && Character.isWhitespace(next)) countMetadata(1);
            if (next != '"') { if (next >= 0) source.unread(next); return value + ":"; }
            if (images.size() >= 10) throw new IOException("API 一次返回的图片超过 10 张。");
            File file = store.temporary();
            temporary.add(file);
            long[] decodedBytes = {0};
            try (OutputStream raw = new FileOutputStream(file);
                 OutputStream bounded = new FilterOutputStream(raw) {
                     @Override public void write(int b) throws IOException {
                         if (++decodedBytes[0] > TaskRules.MAX_IMAGE) throw new IOException("返回图片超过 75 MB。");
                         out.write(b);
                     }
                     @Override public void write(byte[] bytes, int offset, int length) throws IOException {
                         if ((decodedBytes[0] += length) > TaskRules.MAX_IMAGE) throw new IOException("返回图片超过 75 MB。");
                         out.write(bytes, offset, length);
                     }
                 };
                 Base64InputStream base64 = new Base64InputStream(new InputStream() {
                     private long encodedBytes;
                     private boolean ended;
                     @Override public int read() throws IOException {
                         if (ended) return -1;
                         int next = source.read();
                         if (next == '"') { ended = true; return -1; }
                         if (next < 0) throw new IOException("API 返回的图片数据不完整。");
                         if (next == '\\') next = escapedCharacter();
                         if (!(next >= 'A' && next <= 'Z' || next >= 'a' && next <= 'z'
                             || next >= '0' && next <= '9' || next == '+' || next == '/' || next == '='
                             || next == '\r' || next == '\n' || next == '\t' || next == ' '))
                             throw new IOException("API 返回的 base64 图片数据无效。");
                         if (++encodedBytes > 100L * 1024 * 1024) throw new IOException("返回图片超过 75 MB。");
                         return next;
                     }
                 }, Base64.DEFAULT)) {
                byte[] chunk = new byte[16384];
                int count;
                while ((count = base64.read(chunk)) != -1) { control.check(); bounded.write(chunk, 0, count); }
            }
            String id = UUID.randomUUID().toString();
            images.put(id, file);
            return value + ":\"" + id + "\"";
        }
        private void countMetadata(int amount) throws IOException {
            if (amount > 4 * 1024 * 1024 - metadata) throw new IOException("API 返回的图片信息过大。");
            metadata += amount;
        }
        private int escapedCharacter() throws IOException {
            int next = source.read();
            switch (next) {
                case '/': return '/';
                case 'r': return '\r';
                case 'n': return '\n';
                case 't': return '\t';
                case 'u':
                    int value = 0;
                    for (int i = 0; i < 4; i++) {
                        int digit = Character.digit(source.read(), 16);
                        if (digit < 0) throw new IOException("API 返回的 JSON 转义无效。");
                        value = value * 16 + digit;
                    }
                    return value;
                default: throw new IOException("API 返回的 base64 JSON 转义无效。");
            }
        }
        @Override public void close() throws IOException { source.close(); }
    }
}
