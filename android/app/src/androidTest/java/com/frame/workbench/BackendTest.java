package com.frame.workbench;

import android.content.Context;
import android.content.ContextWrapper;
import android.graphics.Bitmap;
import android.test.InstrumentationTestCase;
import android.util.Base64;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

public final class BackendTest extends InstrumentationTestCase {
    private Context context;
    private Backend backend;
    private Fixture fixture;

    @Override protected void setUp() throws Exception {
        super.setUp();
        Context target = getInstrumentation().getTargetContext();
        File root = new File(target.getCacheDir(), "backend-test-" + System.nanoTime());
        assertTrue(root.mkdirs());
        context = new ContextWrapper(target) {
            @Override public File getFilesDir() { return root; }
            @Override public Context getApplicationContext() { return this; }
        };
        fixture = new Fixture();
        backend = new Backend(context);
        save(3, "test-secret-value");
    }

    @Override protected void tearDown() throws Exception {
        for (int i = 0; i < jobs().length(); i++) {
            JSONObject job = jobs().getJSONObject(i);
            if ("queued".equals(job.getString("status")) || "running".equals(job.getString("status"))) {
                backend.call("POST", "/jobs/" + job.getString("id") + "/cancel", new JSONObject());
            }
        }
        fixture.release.countDown();
        fixture.close();
        super.tearDown();
    }

    public void testSettingsOmitKeyAndPersistEncryptedAcrossRestart() throws Exception {
        JSONObject settings = backend.call("GET", "/settings", null);
        JSONObject profile = settings.getJSONArray("profiles").getJSONObject(0);
        assertTrue(profile.getBoolean("hasKey"));
        assertFalse(profile.has("apiKey"));
        assertFalse(readFiles(context.getFilesDir()).contains("test-secret-value"));
        backend = new Backend(context);
        assertTrue(backend.call("GET", "/settings", null).getJSONArray("profiles")
            .getJSONObject(0).getBoolean("hasKey"));
        JSONObject synced = backend.call("POST", "/profiles/default/models", new JSONObject());
        assertEquals("fixture-image", synced.getJSONArray("models").getString(0));
        assertEquals("Bearer test-secret-value", fixture.lastAuthorization);
    }

    public void testModelsUseActualResponseAndRetainOldListOnInvalidResponse() throws Exception {
        JSONObject first = backend.call("POST", "/profiles/default/models", new JSONObject());
        assertEquals(1, first.getJSONArray("models").length());
        fixture.invalidModels = true;
        expectFailure(() -> backend.call("POST", "/profiles/default/models", new JSONObject()));
        assertEquals("fixture-image", backend.call("GET", "/settings", null)
            .getJSONArray("profiles").getJSONObject(0).getJSONArray("models").getString(0));
    }

    public void testInvalidTypesAndProtectedFieldsNeverReachProvider() throws Exception {
        JSONObject[] invalid = {
            task().put("n", 1.5), task().put("n", JSONObject.NULL),
            task().put("prompt", new JSONArray()), task().put("references", JSONObject.NULL),
            task().put("extra", JSONObject.NULL),
            task().put("extra", new JSONObject().put("model", "override")),
            task().put("extra", new JSONObject().put("output_compression", "80")),
            task().put("size", "1025x1024"), task().put("quality", "max"),
            task().put("references", new JSONArray().put("../settings.enc"))
        };
        for (JSONObject input : invalid) expectFailure(() -> backend.call("POST", "/jobs", input));
        assertEquals(0, fixture.generations.get());
        assertEquals(0, jobs().length());
        expectFailure(() -> backend.mediaFile("outputs/../../settings.enc"));
        expectFailure(() -> backend.call("PUT", "/settings",
            settings(3, "").put("concurrency", "3")));
    }

    public void testGenerationPreservesOriginalAndDoesNotExposeCredential() throws Exception {
        JSONObject job = submit(task().put("extra", new JSONObject().put("seed", 42)));
        JSONObject completed = await(job.getString("id"), "completed");
        JSONObject result = completed.getJSONArray("results").getJSONObject(0);
        assertEquals(2, result.getInt("width"));
        assertEquals(3, result.getInt("height"));
        assertEquals("png", result.getString("format"));
        assertTrue(java.util.Arrays.equals(fixture.png, Files.readAllBytes(
            backend.mediaFile(result.getString("id")).toPath())));
        JSONObject request = new JSONObject(fixture.lastBody);
        assertEquals("fixture-image", request.getString("model"));
        assertEquals("test prompt", request.getString("prompt"));
        assertEquals(42, request.getInt("seed"));
        assertFalse(request.has("apiKey"));
        assertFalse(completed.toString().contains("test-secret-value"));
        backend.call("DELETE", "/jobs/" + job.getString("id"), null);
        assertTrue(backend.mediaFile(result.getString("id")).isFile());
    }

    public void testMultipartUsesImageForOneAndImageArrayForMultiple() throws Exception {
        JSONObject upload = new JSONObject().put("files", new JSONArray().put(new JSONObject()
            .put("name", "reference.png").put("type", "image/png")
            .put("data", Base64.encodeToString(fixture.png, Base64.NO_WRAP))));
        String reference = backend.call("POST", "/uploads", upload)
            .getJSONArray("files").getJSONObject(0).getString("id");
        JSONObject first = submit(task().put("references", new JSONArray().put(reference)));
        await(first.getString("id"), "completed");
        assertEquals("/v1/images/edits", fixture.lastPath);
        assertTrue(fixture.lastBody.contains("name=\"image\";"));
        assertFalse(fixture.lastBody.contains("name=\"image[]\";"));
        JSONObject second = submit(task().put("references", new JSONArray().put(reference).put(reference)));
        await(second.getString("id"), "completed");
        assertTrue(fixture.lastBody.contains("name=\"image[]\";"));
        assertTrue(fixture.lastBody.contains("Content-Type: image/png"));
        assertTrue(fixture.lastBody.contains("name=\"model\""));
    }

    public void testUrlResultsAndErrorRedaction() throws Exception {
        fixture.urlResult = true;
        JSONObject first = submit(task());
        await(first.getString("id"), "completed");
        fixture.urlResult = false;
        fixture.generationError = true;
        JSONObject second = submit(task());
        JSONObject failed = await(second.getString("id"), "failed");
        assertFalse(failed.getString("error").contains("test-secret-value"));
        assertEquals(2, fixture.generations.get());
    }

    public void testEmptyBase64FallsBackToValidUrl() throws Exception {
        fixture.urlResult = true;
        fixture.emptyBase64 = true;
        JSONObject job = submit(task());
        JSONObject completed = await(job.getString("id"), "completed");
        JSONObject result = completed.getJSONArray("results").getJSONObject(0);
        assertTrue(java.util.Arrays.equals(fixture.png, Files.readAllBytes(
            backend.mediaFile(result.getString("id")).toPath())));
        assertEquals(0, new File(context.getFilesDir(), "frame/temp").list().length);
    }

    public void testWhitespaceMetadataLimitRejectsBeforeResponseFinishes() throws Exception {
        fixture.whitespaceMetadata = true;
        JSONObject job = submit(task());
        assertTrue(fixture.whitespaceSent.await(10, TimeUnit.SECONDS));
        long deadline = System.currentTimeMillis() + 5000;
        JSONObject found = null;
        do {
            JSONArray list = jobs();
            for (int i = 0; i < list.length(); i++)
                if (list.getJSONObject(i).getString("id").equals(job.getString("id"))) found = list.getJSONObject(i);
            if (found != null && found.getString("status").equals("failed")) break;
            Thread.sleep(20);
        } while (System.currentTimeMillis() < deadline);
        assertNotNull(found);
        assertEquals("failed", found.getString("status"));
        assertTrue(found.getString("error").contains("信息过大"));
        assertEquals(0, new File(context.getFilesDir(), "frame/temp").list().length);
        fixture.finishWhitespace.countDown();
    }

    public void testMalformedResponseCleansEarlierImagesAndNeverRetries() throws Exception {
        fixture.malformedResult = true;
        JSONObject job = submit(task());
        JSONObject failed = await(job.getString("id"), "failed");
        assertTrue(failed.getJSONArray("results").length() == 0);
        File outputs = new File(context.getFilesDir(), "frame/outputs");
        File partials = new File(context.getFilesDir(), "frame/temp");
        assertEquals(0, outputs.list().length);
        assertEquals(0, partials.list().length);
        assertEquals(1, fixture.generations.get());
    }

    public void testRedirectIsRejectedWithoutFollowingOrRetrying() throws Exception {
        fixture.redirect = true;
        JSONObject job = submit(task());
        await(job.getString("id"), "failed");
        assertEquals(1, fixture.generations.get());
        assertEquals(0, new File(context.getFilesDir(), "frame/outputs").list().length);
    }

    public void testOversizedUrlImageIsRejectedBeforeSaving() throws Exception {
        fixture.urlResult = true;
        fixture.oversizedDownload = true;
        JSONObject job = submit(task());
        JSONObject failed = await(job.getString("id"), "failed");
        assertTrue(failed.getString("error").contains("75 MB"));
        assertEquals(0, new File(context.getFilesDir(), "frame/outputs").list().length);
        assertEquals(0, new File(context.getFilesDir(), "frame/temp").list().length);
    }

    public void testUploadRejectsInvalidBytesAndLeavesNoPartialFiles() throws Exception {
        JSONObject invalid = new JSONObject().put("files", new JSONArray().put(new JSONObject()
            .put("name", "pretend.png").put("type", "image/png")
            .put("data", Base64.encodeToString("not an image".getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP))));
        expectFailure(() -> backend.call("POST", "/uploads", invalid));
        invalid.getJSONArray("files").getJSONObject(0).put("data", "%%%%");
        expectFailure(() -> backend.call("POST", "/uploads", invalid));
        assertEquals(0, new File(context.getFilesDir(), "frame/uploads").list().length);
        assertEquals(0, new File(context.getFilesDir(), "frame/temp").list().length);
    }

    public void testMultipartFieldNamesCannotInjectHeaders() throws Exception {
        JSONObject upload = new JSONObject().put("files", new JSONArray().put(new JSONObject()
            .put("name", "reference.png").put("type", "image/png")
            .put("data", Base64.encodeToString(fixture.png, Base64.NO_WRAP))));
        String reference = backend.call("POST", "/uploads", upload)
            .getJSONArray("files").getJSONObject(0).getString("id");
        JSONObject job = submit(task().put("references", new JSONArray().put(reference))
            .put("extra", new JSONObject().put("custom\"\r\nInjected: bad", "value")));
        await(job.getString("id"), "completed");
        assertFalse(fixture.lastBody.contains("\r\nInjected: bad"));
        assertTrue(fixture.lastBody.contains("custom%22%0D%0AInjected: bad"));
    }

    public void testCancellationDisconnectsAndQueuedConnectionIsSnapshotted() throws Exception {
        save(1, "test-secret-value");
        fixture.block = true;
        JSONObject first = submit(task());
        assertTrue(fixture.started.await(10, TimeUnit.SECONDS));
        JSONObject second = submit(task());
        save(1, "changed-secret-value");
        backend.call("POST", "/jobs/" + first.getString("id") + "/cancel", null);
        await(first.getString("id"), "cancelled");
        fixture.block = false;
        fixture.release.countDown();
        await(second.getString("id"), "completed");
        assertEquals("Bearer test-secret-value", fixture.lastGenerationAuthorization);
        assertEquals(0, backend.activeCount());
    }

    public void testRestartInterruptsPersistedWorkWithoutResubmission() throws Exception {
        Store store = new Store(context);
        JSONArray persisted = new JSONArray()
            .put(task().put("id", "queued-id").put("status", "queued"))
            .put(task().put("id", "running-id").put("status", "running"));
        store.writeJobs(persisted);
        backend = new Backend(context);
        JSONArray result = jobs();
        assertEquals(2, result.length());
        assertEquals("interrupted", result.getJSONObject(0).getString("status"));
        assertEquals("interrupted", result.getJSONObject(1).getString("status"));
        assertTrue(result.getJSONObject(0).has("finishedAt"));
        assertEquals(0, fixture.generations.get());
    }

    public void testOverBudgetAtomicWritePreservesReadableHistory() throws Exception {
        Store store = new Store(context);
        File target = new File(store.root, "jobs.json");
        byte[] original = "[{\"id\":\"retained\",\"status\":\"completed\"}]".getBytes(StandardCharsets.UTF_8);
        Store.writeAtomic(target, original, 64);
        byte[] oversized = new byte[65];
        java.util.Arrays.fill(oversized, (byte) 'x');
        expectFailure(() -> Store.writeAtomic(target, oversized, 64));
        assertEquals("retained", store.readJobs().getJSONObject(0).getString("id"));
        assertTrue(java.util.Arrays.equals(original, Files.readAllBytes(target.toPath())));
        assertFalse(new File(store.root, "jobs.json.new").exists());
    }

    public void testOneHundredIndependentTasksRunConcurrently() throws Exception {
        save(100, "test-secret-value");
        fixture.block = true;
        for (int i = 0; i < 100; i++) submit(task().put("prompt", "task " + i));
        long deadline = System.currentTimeMillis() + 30000;
        while (fixture.generations.get() < 100 && System.currentTimeMillis() < deadline) Thread.sleep(25);
        assertEquals(100, fixture.generations.get());
        assertEquals(100, backend.activeCount());
        fixture.block = false;
        fixture.release.countDown();
        deadline = System.currentTimeMillis() + 60000;
        while (backend.activeCount() > 0 && System.currentTimeMillis() < deadline) Thread.sleep(50);
        assertEquals(0, backend.activeCount());
        assertEquals(100, jobs().length());
        for (int i = 0; i < 100; i++) assertEquals("completed", jobs().getJSONObject(i).getString("status"));
    }

    private void save(int concurrency, String key) throws Exception {
        backend.call("PUT", "/settings", settings(concurrency, key));
        backend.call("POST", "/profiles/default/models", new JSONObject());
    }

    private JSONObject settings(int concurrency, String key) throws Exception {
        return new JSONObject().put("concurrency", concurrency).put("profiles", new JSONArray()
            .put(new JSONObject().put("id", "default").put("name", "Fixture")
                .put("baseUrl", fixture.base()).put("apiKey", key).put("timeout", 30)
                .put("models", new JSONArray())));
    }

    private JSONObject task() throws Exception {
        return new JSONObject().put("profileId", "default").put("model", "fixture-image")
            .put("prompt", "test prompt").put("n", 1).put("size", "1024x1024")
            .put("quality", "auto").put("background", "auto").put("outputFormat", "png")
            .put("references", new JSONArray()).put("extra", new JSONObject());
    }

    private JSONObject submit(JSONObject task) throws Exception { return backend.call("POST", "/jobs", task); }
    private JSONArray jobs() throws Exception { return backend.call("GET", "/jobs", null).getJSONArray("jobs"); }
    private JSONObject await(String id, String status) throws Exception {
        long deadline = System.currentTimeMillis() + 20000;
        do {
            JSONArray list = jobs();
            for (int i = 0; i < list.length(); i++) {
                JSONObject job = list.getJSONObject(i);
                if (id.equals(job.getString("id")) && status.equals(job.getString("status"))) return job;
                if (id.equals(job.getString("id")) && "failed".equals(job.getString("status")) && !status.equals("failed"))
                    fail("Unexpected job failure: " + job.optString("error"));
            }
            Thread.sleep(20);
        } while (System.currentTimeMillis() < deadline);
        fail("Timed out waiting for " + status);
        return null;
    }

    private interface Action { void run() throws Exception; }
    private void expectFailure(Action action) throws Exception {
        try { action.run(); fail("Expected rejection"); } catch (AssertionError error) { throw error; }
        catch (Exception expected) { assertNotNull(expected.getMessage()); }
    }
    private String readFiles(File root) throws Exception {
        StringBuilder text = new StringBuilder();
        File[] files = root.listFiles();
        if (files != null) for (File file : files) {
            if (file.isDirectory()) text.append(readFiles(file));
            else text.append(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
        }
        return text.toString();
    }

    private static final class Fixture implements AutoCloseable {
        final ServerSocket server = new ServerSocket(0, 120);
        final AtomicInteger generations = new AtomicInteger();
        final CountDownLatch started = new CountDownLatch(1);
        final CountDownLatch release = new CountDownLatch(1);
        final CountDownLatch whitespaceSent = new CountDownLatch(1);
        final CountDownLatch finishWhitespace = new CountDownLatch(1);
        final byte[] png;
        volatile boolean invalidModels, block, urlResult, generationError, malformedResult, redirect, oversizedDownload,
            emptyBase64, whitespaceMetadata;
        volatile String lastBody = "", lastPath = "", lastAuthorization = "", lastGenerationAuthorization = "";
        Fixture() throws Exception {
            Bitmap image = Bitmap.createBitmap(2, 3, Bitmap.Config.ARGB_8888);
            image.eraseColor(0xff16a06a);
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            image.compress(Bitmap.CompressFormat.PNG, 100, bytes);
            image.recycle();
            png = bytes.toByteArray();
            Thread accept = new Thread(() -> {
                while (!server.isClosed()) try {
                    Socket socket = server.accept();
                    Thread request = new Thread(() -> respond(socket), "fixture-http");
                    request.setDaemon(true);
                    request.start();
                } catch (Exception ignored) { }
            }, "fixture-accept");
            accept.setDaemon(true);
            accept.start();
        }
        String base() { return "http://127.0.0.1:" + server.getLocalPort() + "/v1"; }
        void respond(Socket socket) {
            try (Socket connection = socket) {
                connection.setSoTimeout(35000);
                InputStream in = new BufferedInputStream(connection.getInputStream());
                String first = line(in);
                String path = first.split(" ")[1];
                Map<String, String> headers = new HashMap<>();
                String header;
                while (!(header = line(in)).isEmpty()) {
                    int colon = header.indexOf(':');
                    headers.put(header.substring(0, colon).toLowerCase(), header.substring(colon + 1).trim());
                }
                int length = Integer.parseInt(headers.getOrDefault("content-length", "0"));
                ByteArrayOutputStream body = new ByteArrayOutputStream();
                for (int i = 0; i < length; i++) body.write(in.read());
                String authorization = headers.getOrDefault("authorization", "");
                lastAuthorization = authorization;
                byte[] response;
                int status = 200;
                if (path.endsWith("/models")) {
                    response = (invalidModels ? "{\"data\":[{\"id\":null}]}"
                        : "{\"data\":[{\"id\":\"fixture-image\"},{\"id\":\"fixture-image\"}]}")
                        .getBytes(StandardCharsets.UTF_8);
                } else if (path.equals("/result.png")) {
                    response = png;
                } else {
                    lastBody = body.toString("ISO-8859-1");
                    lastPath = path;
                    lastGenerationAuthorization = authorization;
                    generations.incrementAndGet();
                    started.countDown();
                    if (block) release.await(30, TimeUnit.SECONDS);
                    if (redirect) {
                        status = 302;
                        response = "{}".getBytes(StandardCharsets.UTF_8);
                    } else if (generationError || !validPayload(path, headers, first)) {
                        status = 400;
                        response = "{\"error\":{\"message\":\"denied test-secret-value\"}}".getBytes(StandardCharsets.UTF_8);
                    } else {
                        String item = urlResult ? "\"url\":\"http://127.0.0.1:" + server.getLocalPort() + "/result.png\""
                            : "\"b64_json\":\"" + Base64.encodeToString(png, Base64.NO_WRAP) + "\"";
                        if (emptyBase64) item += ",\"b64_json\":\"\"";
                        String invalid = malformedResult ? ",{\"url\":\"file:///not-permitted\"}" : "";
                        response = ("{\"data\":[{" + item + ",\"revised_prompt\":\"fixture revision\"}" + invalid + "]}")
                            .getBytes(StandardCharsets.UTF_8);
                    }
                }
                OutputStream out = connection.getOutputStream();
                if (whitespaceMetadata && path.equals("/v1/images/generations")) {
                    byte[] prefix = "{\"data\":[{\"b64_json\"".getBytes(StandardCharsets.US_ASCII);
                    byte[] suffix = (":\"" + Base64.encodeToString(png, Base64.NO_WRAP) + "\"}]}").getBytes(StandardCharsets.US_ASCII);
                    int spaces = 4 * 1024 * 1024 + 1;
                    out.write(("HTTP/1.1 200 OK\r\nContent-Length: " + (prefix.length + spaces + suffix.length)
                        + "\r\nConnection: close\r\nContent-Type: application/json\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                    out.write(prefix);
                    byte[] chunk = new byte[8192];
                    java.util.Arrays.fill(chunk, (byte) ' ');
                    try {
                        for (int remaining = spaces; remaining > 0; remaining -= Math.min(remaining, chunk.length))
                            out.write(chunk, 0, Math.min(remaining, chunk.length));
                        out.flush();
                    } finally { whitespaceSent.countDown(); }
                    finishWhitespace.await(15, TimeUnit.SECONDS);
                    out.write(suffix);
                    out.flush();
                    return;
                }
                long responseLength = oversizedDownload && path.equals("/result.png") ? 75L * 1024 * 1024 + 1 : response.length;
                out.write(("HTTP/1.1 " + status + " OK\r\nContent-Length: " + responseLength
                    + (redirect ? "\r\nLocation: " + base() + "/images/generations" : "")
                    + "\r\nConnection: close\r\nContent-Type: application/json\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                out.write(response);
                out.flush();
            } catch (Exception ignored) { }
        }
        private boolean validPayload(String path, Map<String, String> headers, String first) {
            if (!first.startsWith("POST ") || !headers.getOrDefault("authorization", "").startsWith("Bearer ")) return false;
            try {
                if (path.equals("/v1/images/generations")) {
                    if (!headers.getOrDefault("content-type", "").startsWith("application/json")) return false;
                    JSONObject payload = new JSONObject(lastBody);
                    return payload.getString("model").equals("fixture-image") && !payload.getString("prompt").isEmpty()
                        && payload.get("n") instanceof Number && payload.getInt("n") >= 1 && payload.getInt("n") <= 10
                        && payload.getString("size").equals("1024x1024") && payload.getString("quality").equals("auto")
                        && payload.getString("output_format").equals("png") && payload.getString("background").equals("auto")
                        && !payload.has("references") && !payload.has("apiKey");
                }
                return path.equals("/v1/images/edits") && headers.getOrDefault("content-type", "").startsWith("multipart/form-data; boundary=")
                    && lastBody.contains("name=\"model\"\r\n\r\nfixture-image\r\n") && lastBody.contains("Content-Type: image/png\r\n")
                    && lastBody.contains("name=\"prompt\"\r\n\r\ntest prompt\r\n")
                    && lastBody.contains(new String(png, StandardCharsets.ISO_8859_1));
            } catch (Exception error) { return false; }
        }
        private String line(InputStream in) throws Exception {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            int value;
            while ((value = in.read()) != -1) {
                if (value == '\n') break;
                if (value != '\r') bytes.write(value);
                if (bytes.size() > 16000) throw new Exception("Header too long");
            }
            if (value == -1 && bytes.size() == 0) throw new Exception("Disconnected");
            return bytes.toString("US-ASCII");
        }
        @Override public void close() throws Exception { release.countDown(); finishWhitespace.countDown(); server.close(); }
    }
}
