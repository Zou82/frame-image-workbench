package com.frame.workbench;

import android.content.Context;
import android.os.Process;
import android.util.Base64;
import android.util.Base64InputStream;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

public final class Backend {
    private static Backend instance;
    private final Object lock = new Object();
    private final Store store;
    private final Provider provider;
    private final ArrayList<JSONObject> jobs = new ArrayList<>();
    private final Map<String, JSONObject> snapshots = new HashMap<>();
    private final Map<String, Provider.Control> active = new HashMap<>();
    private final ExecutorService workers = Executors.newFixedThreadPool(TaskRules.MAX_CONCURRENCY, runnable -> {
        Thread thread = new Thread(runnable, "frame-generation");
        thread.setDaemon(true);
        return thread;
    });
    private JSONObject settings;
    private String storageError = "";
    private Runnable listener;

    public static synchronized Backend get(Context context) throws Exception {
        if (instance == null) instance = new Backend(context.getApplicationContext());
        return instance;
    }

    Backend(Context context) throws Exception {
        ThreadPoolExecutor pool = (ThreadPoolExecutor) workers;
        pool.setKeepAliveTime(30, TimeUnit.SECONDS);
        pool.allowCoreThreadTimeOut(true);
        store = new Store(context);
        provider = new Provider(store);
        settings = store.readSettings(new JSONObject().put("concurrency", 3).put("profiles", new JSONArray()
            .put(new JSONObject().put("id", "default").put("name", "OpenAI 官方")
                .put("baseUrl", "https://api.openai.com/v1").put("apiKey", "")
                .put("models", new JSONArray()).put("timeout", 600))));
        JSONArray history = store.readJobs();
        for (int i = 0; i < history.length(); i++) {
            JSONObject job = history.getJSONObject(i);
            if (pending(job)) job.put("status", "interrupted")
                .put("error", "应用已重启，请重新提交任务。").put("finishedAt", now());
            jobs.add(job);
        }
        store.writeJobs(list());
        store.clearTemporary();
    }

    public void setListener(Runnable next) { synchronized (lock) { listener = next; notifyListener(); } }

    public int activeCount() {
        synchronized (lock) {
            int count = 0;
            for (JSONObject job : jobs) if (pending(job)) count++;
            return count;
        }
    }

    public File mediaFile(String id) throws Exception { return store.media(id); }

    public JSONObject call(String method, String route, JSONObject body) throws Exception {
        try {
            if ("GET".equals(method) && "/settings".equals(route)) synchronized (lock) { return publicSettings(); }
            if ("PUT".equals(method) && "/settings".equals(route)) return updateSettings(body);
            if ("GET".equals(method) && "/health".equals(route)) synchronized (lock) {
                return new JSONObject().put("app", "frame-image-workbench").put("pid", Process.myPid())
                    .put("ok", true).put("storageError", storageError);
            }
            if ("GET".equals(method) && "/jobs".equals(route)) synchronized (lock) {
                return new JSONObject().put("jobs", list()).put("storageError", storageError);
            }
            if ("POST".equals(method) && "/jobs".equals(route)) return submit(body);
            if ("POST".equals(method) && "/uploads".equals(route)) return uploads(body);
            if ("POST".equals(method) && route.matches("^/profiles/[A-Za-z0-9-]{1,80}/(models|test)$"))
                return syncModels(route.split("/")[2], route.endsWith("/models"));
            if ("POST".equals(method) && route.matches("^/jobs/[A-Za-z0-9-]{1,80}/cancel$"))
                return cancel(route.split("/")[2]);
            if ("DELETE".equals(method) && route.matches("^/jobs/[A-Za-z0-9-]{1,80}$"))
                return delete(route.split("/")[2]);
            throw new Exception("接口不存在。");
        } catch (Exception error) {
            String message = error.getMessage();
            synchronized (lock) {
                JSONArray profiles = settings.getJSONArray("profiles");
                for (int i = 0; i < profiles.length(); i++)
                    message = TaskRules.redact(message, profiles.getJSONObject(i).getString("apiKey"));
                for (JSONObject snapshot : snapshots.values()) message = TaskRules.redact(message, snapshot.getString("apiKey"));
            }
            throw new Exception(message == null ? "请求失败。" : message);
        }
    }

    private JSONObject updateSettings(JSONObject input) throws Exception {
        if (input == null) throw new Exception("设置必须是 JSON 对象。");
        synchronized (lock) {
            int concurrency = TaskRules.integer(input, "concurrency", 3, 1, TaskRules.MAX_CONCURRENCY);
            Object raw = input.opt("profiles");
            if (!(raw instanceof JSONArray) || ((JSONArray) raw).length() < 1 || ((JSONArray) raw).length() > 20)
                throw new Exception("请保留 1 到 20 个 API 连接。");
            JSONArray incoming = (JSONArray) raw;
            JSONArray profiles = new JSONArray();
            Set<String> ids = new HashSet<>();
            for (int i = 0; i < incoming.length(); i++) {
                Object value = incoming.get(i);
                if (!(value instanceof JSONObject)) throw new Exception("API 连接配置无效。");
                JSONObject item = (JSONObject) value;
                String id = TaskRules.string(item, "id", "");
                if (!id.matches("^[A-Za-z0-9-]{1,80}$") || !ids.add(id)) throw new Exception("API 连接标识无效或重复。");
                JSONObject previous = profile(id);
                String supplied = TaskRules.string(item, "apiKey", "").trim();
                String key = TaskRules.bool(item, "clearKey", false) ? "" : !supplied.isEmpty()
                    ? supplied : previous == null ? "" : previous.getString("apiKey");
                TaskRules.apiKey(key);
                int timeout = TaskRules.integer(item, "timeout", 600, 30, 1800);
                Object modelValue = item.opt("models");
                if (!(modelValue instanceof JSONArray) || ((JSONArray) modelValue).length() > 1000)
                    throw new Exception("模型列表最多包含 1000 个有效模型 ID。");
                JSONArray modelInput = (JSONArray) modelValue;
                JSONArray models = new JSONArray();
                Set<String> modelIds = new HashSet<>();
                for (int j = 0; j < modelInput.length(); j++) {
                    Object model = modelInput.get(j);
                    if (!(model instanceof String) || ((String) model).trim().isEmpty() || ((String) model).length() > 200)
                        throw new Exception("模型列表包含无效的模型 ID。");
                    if (modelIds.add(((String) model).trim())) models.put(((String) model).trim());
                }
                String name = TaskRules.string(item, "name", "API 连接");
                profiles.put(new JSONObject().put("id", id).put("name", name.substring(0, Math.min(name.length(), 60)))
                    .put("baseUrl", TaskRules.baseUrl(TaskRules.string(item, "baseUrl", "https://api.openai.com/v1")))
                    .put("apiKey", key).put("timeout", timeout).put("models", models));
            }
            JSONObject next = new JSONObject().put("concurrency", concurrency).put("profiles", profiles);
            store.writeSettings(next);
            settings = next;
            pump();
            return publicSettings();
        }
    }

    private JSONObject syncModels(String id, boolean persist) throws Exception {
        JSONObject selected;
        synchronized (lock) {
            JSONObject found = profile(id);
            if (found == null || found.getString("apiKey").isEmpty()) throw new Exception("请先保存 API Key。");
            selected = copy(found);
        }
        JSONArray models = provider.models(selected);
        synchronized (lock) {
            JSONObject result = new JSONObject().put("ok", true).put("endpoint", selected.getString("baseUrl") + "/models")
                .put("models", models);
            if (persist) {
                JSONObject current = profile(id);
                if (current == null || !current.getString("apiKey").equals(selected.getString("apiKey"))
                    || !current.getString("baseUrl").equals(selected.getString("baseUrl")))
                    throw new Exception("连接配置已更改，请重新获取模型。");
                JSONObject next = copy(settings);
                JSONArray profiles = next.getJSONArray("profiles");
                for (int i = 0; i < profiles.length(); i++) {
                    JSONObject item = profiles.getJSONObject(i);
                    if (item.getString("id").equals(id)) item.put("models", models);
                }
                store.writeSettings(next);
                settings = next;
                result.put("settings", publicSettings());
            }
            return result;
        }
    }

    private JSONObject submit(JSONObject input) throws Exception {
        JSONObject task = TaskRules.validate(input);
        synchronized (lock) {
            if (!storageError.isEmpty()) throw new Exception(storageError);
            JSONObject connection = profile(task.getString("profileId"));
            if (connection == null || connection.getString("apiKey").isEmpty()) throw new Exception("请先在 API 连接中配置并保存密钥。");
            TaskRules.apiKey(connection.getString("apiKey"));
            boolean hasModel = false;
            JSONArray models = connection.getJSONArray("models");
            for (int i = 0; i < models.length(); i++) if (models.getString(i).equals(task.getString("model"))) hasModel = true;
            if (!hasModel) throw new Exception("所选模型不在此 API 连接的模型列表中，请获取模型后重新选择。");
            JSONArray references = task.getJSONArray("references");
            for (int i = 0; i < references.length(); i++) store.media(references.getString(i));
            String id = UUID.randomUUID().toString();
            task.put("id", id).put("profileName", connection.getString("name")).put("status", "queued")
                .put("createdAt", now()).put("results", new JSONArray()).put("error", JSONObject.NULL);
            jobs.add(0, task);
            snapshots.put(id, copy(connection));
            try { store.writeJobs(list()); }
            catch (Exception error) {
                jobs.remove(task);
                snapshots.remove(id);
                throw new Exception("任务未能写入本地记录，请检查剩余空间。此任务未提交给 API。");
            }
            JSONObject response = copy(task);
            notifyListener();
            pump();
            return response;
        }
    }

    private JSONObject cancel(String id) throws Exception {
        synchronized (lock) {
            JSONObject job = findJob(id);
            if (job == null || !pending(job)) throw new Exception("任务已结束或不存在。");
            job.put("status", "cancelled").put("finishedAt", now());
            Provider.Control control = active.get(id);
            if (control != null) control.cancel(); else snapshots.remove(id);
            persistHistory();
            notifyListener();
            pump();
            return new JSONObject().put("ok", true);
        }
    }

    private JSONObject delete(String id) throws Exception {
        synchronized (lock) {
            JSONObject job = findJob(id);
            if (job == null) throw new Exception("任务不存在。");
            if (pending(job)) throw new Exception("请先取消任务。");
            int index = jobs.indexOf(job);
            jobs.remove(index);
            try { store.writeJobs(list()); }
            catch (Exception error) { jobs.add(index, job); throw error; }
            return new JSONObject().put("ok", true);
        }
    }

    private JSONObject uploads(JSONObject input) throws Exception {
        Object value = input == null ? null : input.opt("files");
        if (!(value instanceof JSONArray) || ((JSONArray) value).length() < 1 || ((JSONArray) value).length() > 16)
            throw new Exception("请选择 1 到 16 张参考图片。");
        JSONArray incoming = (JSONArray) value;
        JSONArray saved = new JSONArray();
        ArrayList<File> temporary = new ArrayList<>();
        try {
            for (int i = 0; i < incoming.length(); i++) {
                JSONObject item = incoming.getJSONObject(i);
                String name = TaskRules.string(item, "name", "reference");
                String mime = TaskRules.string(item, "type", "");
                if (!mime.equals("image/png") && !mime.equals("image/jpeg") && !mime.equals("image/webp"))
                    throw new Exception("参考图仅支持 PNG、JPEG、WebP。");
                String data = TaskRules.string(item, "data", "");
                if (data.length() > ((TaskRules.MAX_REFERENCE + 2) / 3) * 4)
                    throw new Exception("单张参考图不能超过 20 MB。");
                File file = store.temporary();
                temporary.add(file);
                try (InputStream in = new Base64InputStream(new InputStream() {
                         private int position;
                         @Override public int read() throws java.io.IOException {
                             if (position >= data.length()) return -1;
                             char value = data.charAt(position++);
                             if (!(value >= 'A' && value <= 'Z' || value >= 'a' && value <= 'z'
                                 || value >= '0' && value <= '9' || value == '+' || value == '/' || value == '='
                                 || value == '\r' || value == '\n' || value == '\t' || value == ' '))
                                 throw new java.io.IOException("参考图片的 base64 数据无效。");
                             return value;
                         }
                     }, Base64.DEFAULT);
                     OutputStream out = new FileOutputStream(file)) {
                    byte[] buffer = new byte[16384];
                    long length = 0;
                    int count;
                    while ((count = in.read(buffer)) != -1) {
                        if ((length += count) > TaskRules.MAX_REFERENCE) throw new Exception("单张参考图不能超过 20 MB。");
                        out.write(buffer, 0, count);
                    }
                }
                saved.put(store.saveImage(file, "uploads", name, TaskRules.MAX_REFERENCE));
            }
            return new JSONObject().put("files", saved);
        } catch (Exception error) {
            for (int i = 0; i < saved.length(); i++) store.resolve(saved.getJSONObject(i).getString("id")).delete();
            throw error;
        } finally { for (File file : temporary) file.delete(); }
    }

    private void pump() throws Exception {
        if (!storageError.isEmpty()) return;
        for (int i = jobs.size() - 1; i >= 0 && active.size() < settings.getInt("concurrency"); i--) {
            JSONObject job = jobs.get(i);
            if (!job.optString("status").equals("queued")) continue;
            String id = job.getString("id");
            JSONObject snapshot = snapshots.get(id);
            if (snapshot == null) {
                job.put("status", "interrupted").put("finishedAt", now()).put("error", "连接配置不可用，请重新提交任务。");
                persistHistory();
                continue;
            }
            Provider.Control control = new Provider.Control();
            job.put("status", "running").put("startedAt", now());
            try { store.writeJobs(list()); }
            catch (Exception error) {
                job.put("status", "failed").put("finishedAt", now()).put("error", "历史记录写入失败，此任务未提交给 API。");
                storageError = "历史记录写入失败，请检查剩余空间并重启应用。";
                snapshots.remove(id);
                notifyListener();
                return;
            }
            active.put(id, control);
            JSONObject request = copy(job);
            JSONObject credentials = copy(snapshot);
            notifyListener();
            workers.execute(() -> runJob(job, request, credentials, control));
        }
    }

    private void runJob(JSONObject job, JSONObject request, JSONObject credentials, Provider.Control control) {
        JSONArray results = null;
        String error = null;
        try { results = provider.generate(request, credentials, control); }
        catch (Exception failure) { error = TaskRules.redact(failure.getMessage(), credentials.optString("apiKey")); }
        synchronized (lock) {
            try {
                if (job.optString("status").equals("cancelled")) removeResults(results);
                else if (error == null) job.put("status", "completed").put("results", results);
                else job.put("status", "failed").put("error", error);
                job.put("finishedAt", now());
                active.remove(job.optString("id"));
                snapshots.remove(job.optString("id"));
                persistHistory();
                notifyListener();
                pump();
            } catch (Exception failure) {
                storageError = "历史记录写入失败，请检查剩余空间并重启应用。";
                active.remove(job.optString("id"));
                snapshots.remove(job.optString("id"));
                notifyListener();
            }
        }
    }

    private void removeResults(JSONArray results) {
        if (results == null) return;
        for (int i = 0; i < results.length(); i++) try {
            store.resolve(results.getJSONObject(i).getString("id")).delete();
        } catch (Exception ignored) { }
    }

    private void persistHistory() {
        try { store.writeJobs(list()); }
        catch (Exception error) { storageError = "历史记录写入失败，请检查剩余空间并重启应用。"; }
    }

    private JSONObject publicSettings() throws Exception {
        JSONObject result = copy(settings);
        JSONArray profiles = result.getJSONArray("profiles");
        for (int i = 0; i < profiles.length(); i++) {
            JSONObject profile = profiles.getJSONObject(i);
            String key = profile.getString("apiKey");
            profile.remove("apiKey");
            profile.put("hasKey", !key.isEmpty());
        }
        return result;
    }

    private JSONObject profile(String id) throws Exception {
        JSONArray profiles = settings.getJSONArray("profiles");
        for (int i = 0; i < profiles.length(); i++) {
            JSONObject profile = profiles.getJSONObject(i);
            if (profile.getString("id").equals(id)) return profile;
        }
        return null;
    }

    private JSONObject findJob(String id) {
        for (JSONObject job : jobs) if (job.optString("id").equals(id)) return job;
        return null;
    }
    private JSONArray list() throws Exception {
        JSONArray result = new JSONArray();
        for (JSONObject job : jobs) result.put(copy(job));
        return result;
    }
    private static JSONObject copy(JSONObject value) throws Exception { return new JSONObject(value.toString()); }
    private static boolean pending(JSONObject job) {
        String status = job.optString("status");
        return status.equals("queued") || status.equals("running");
    }
    private static String now() { return Instant.now().toString(); }
    private void notifyListener() { if (listener != null) try { listener.run(); } catch (RuntimeException ignored) { } }
}
