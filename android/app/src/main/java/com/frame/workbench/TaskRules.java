package com.frame.workbench;

import org.json.JSONArray;
import org.json.JSONObject;
import java.net.URI;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

final class TaskRules {
    static final int MAX_CONCURRENCY = 100;
    static final long MAX_REFERENCE = 20L * 1024 * 1024;
    static final long MAX_IMAGE = 75L * 1024 * 1024;
    private static final Set<String> RESERVED = new HashSet<>(Arrays.asList(
        "model", "prompt", "n", "size", "quality", "background", "output_format",
        "response_format", "stream", "partial_images", "image", "images", "mask",
        "api_key", "apiKey", "__proto__", "constructor", "prototype"));
    private static final Pattern SIZE = Pattern.compile("^(\\d{2,4})x(\\d{2,4})$");
    private static final Set<String> PRESETS = new HashSet<>(Arrays.asList(
        "auto", "1024x1024", "1536x1024", "1024x1536"));

    static JSONObject validate(JSONObject input) throws Exception {
        if (input == null) throw new Exception("任务必须是 JSON 对象。");
        String prompt = string(input, "prompt", "").trim();
        if (prompt.isEmpty() || prompt.length() > 32000)
            throw new Exception("提示词不能为空，且不能超过 32000 个字符。");
        String model = string(input, "model", "").trim();
        if (model.isEmpty() || model.length() > 200) throw new Exception("请选择有效的模型。");
        int count = integer(input, "n", 1, 1, 10);
        String size = string(input, "size", "1024x1024");
        if (!PRESETS.contains(size)) {
            Matcher match = SIZE.matcher(size);
            boolean valid = match.matches();
            int width = valid ? Integer.parseInt(match.group(1)) : 0;
            int height = valid ? Integer.parseInt(match.group(2)) : 0;
            long pixels = (long) width * height;
            if (!valid || width % 16 != 0 || height % 16 != 0 || Math.max(width, height) > 3840
                || Math.min(width, height) == 0 || Math.max(width, height) > Math.min(width, height) * 3
                || pixels < 655360 || pixels > 8294400 || model.matches("^gpt-image-1(?:[.-].*|$)"))
                throw new Exception("尺寸不受支持：自定义宽高须为 16 的倍数，最长边不超过 3840，比例不超过 3:1，总像素为 655360 至 8294400；旧模型仅支持预设尺寸。");
        }
        String quality = string(input, "quality", "auto");
        Set<String> qualities = new HashSet<>(Arrays.asList("auto", "low", "medium", "high"));
        if (model.matches("^gpt-image-2\\.[56]-.*")) qualities.addAll(Arrays.asList("xhigh", "max"));
        if (!qualities.contains(quality)) throw new Exception("当前模型不支持所选质量。");
        String format = string(input, "outputFormat", "png");
        String background = string(input, "background", "auto");
        if (!Arrays.asList("png", "jpeg", "webp").contains(format)) throw new Exception("输出格式只支持 PNG、JPEG、WebP。");
        if (!Arrays.asList("auto", "opaque", "transparent").contains(background)) throw new Exception("背景选项无效。");
        if (background.equals("transparent") && (format.equals("jpeg") || model.startsWith("gpt-image-2")))
            throw new Exception("当前模型或输出格式不支持透明背景。");
        Object rawReferences = input.has("references") ? input.get("references") : new JSONArray();
        if (!(rawReferences instanceof JSONArray)) throw new Exception("参考图必须是数组。");
        JSONArray references = (JSONArray) rawReferences;
        if (references.length() > 16) throw new Exception("参考图最多支持 16 张。");
        JSONArray cleanedReferences = new JSONArray();
        for (int i = 0; i < references.length(); i++) {
            Object value = references.get(i);
            if (!(value instanceof String) || !((String) value).matches("^(uploads|outputs)/[a-f0-9-]+\\.(png|jpeg|webp)$"))
                throw new Exception("参考图片路径无效。");
            cleanedReferences.put(value);
        }
        Object extraValue = input.has("extra") ? input.get("extra") : new JSONObject();
        if (extraValue instanceof String) {
            try { extraValue = new JSONObject(((String) extraValue).isEmpty() ? "{}" : (String) extraValue); }
            catch (Exception error) { throw new Exception("高级参数必须是有效的 JSON 对象。"); }
        }
        if (!(extraValue instanceof JSONObject)) throw new Exception("高级参数必须是 JSON 对象。");
        JSONObject extra = (JSONObject) extraValue;
        for (String key : keys(extra)) if (RESERVED.contains(key)) throw new Exception("高级参数包含保留字段，请使用任务面板中的对应选项。");
        if (extra.toString().length() > 10000) throw new Exception("高级参数过长。");
        if (extra.has("output_compression")) integer(extra, "output_compression", 100, 0, 100);
        String title = string(input, "title", "未命名任务");
        if (title.length() > 80) title = title.substring(0, 80);
        String profileId = string(input, "profileId", "default");
        return new JSONObject().put("title", title).put("profileId", profileId).put("model", model)
            .put("prompt", prompt).put("n", count).put("size", size).put("quality", quality)
            .put("outputFormat", format).put("background", background)
            .put("references", cleanedReferences).put("extra", new JSONObject(extra.toString()));
    }

    static String string(JSONObject object, String key, String fallback) throws Exception {
        if (!object.has(key)) return fallback;
        Object value = object.get(key);
        if (!(value instanceof String)) throw new Exception(key + " 必须是字符串。");
        return (String) value;
    }

    static int integer(JSONObject object, String key, int fallback, int min, int max) throws Exception {
        if (!object.has(key)) return fallback;
        Object value = object.get(key);
        if (!(value instanceof Number)) throw new Exception(key + " 必须是整数。");
        double number = ((Number) value).doubleValue();
        if (!Double.isFinite(number) || number != Math.rint(number) || number < min || number > max)
            throw new Exception(key + " 必须是 " + min + " 到 " + max + " 的整数。");
        return (int) number;
    }

    static boolean bool(JSONObject object, String key, boolean fallback) throws Exception {
        if (!object.has(key)) return fallback;
        Object value = object.get(key);
        if (!(value instanceof Boolean)) throw new Exception(key + " 必须是布尔值。");
        return (Boolean) value;
    }

    static String baseUrl(String value) throws Exception {
        if (value.isEmpty()) value = "https://api.openai.com/v1";
        URI url;
        try { url = new URI(value.trim()); } catch (Exception error) { throw new Exception("API 地址无效。"); }
        if (!Arrays.asList("http", "https").contains(url.getScheme()) || url.getHost() == null
            || url.getRawUserInfo() != null || url.getRawQuery() != null || url.getRawFragment() != null)
            throw new Exception("API 地址应为不含用户名、查询参数和片段的 HTTP(S) 地址。");
        String path = url.getRawPath();
        if (path == null || path.isEmpty() || path.equals("/")) path = "/v1";
        String result = url.getScheme() + "://" + url.getRawAuthority() + path;
        return result.replaceAll("/+$", "");
    }

    static void apiKey(String key) throws Exception {
        if (key.length() > 2000 || key.contains("\r") || key.contains("\n"))
            throw new Exception("API Key 格式无效。");
        if (key.trim().matches("(?i)^https?://.*")) throw new Exception("API Key 中填写的是网址。请将网址填入 API 地址，并从服务商复制调用密钥到 API Key。");
    }

    static String redact(String text, String key) {
        String result = text == null || text.isEmpty() ? "请求失败，请检查连接设置。" : text;
        if (key != null && !key.isEmpty()) result = result.replace(key, "[密钥已隐藏]");
        return result.replaceAll("sk-[A-Za-z0-9_-]{8,}", "[密钥已隐藏]");
    }

    static Iterable<String> keys(JSONObject object) {
        java.util.ArrayList<String> result = new java.util.ArrayList<>();
        java.util.Iterator<String> keys = object.keys();
        while (keys.hasNext()) result.add(keys.next());
        return result;
    }
}
