package com.frame.workbench;

import android.app.Activity;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.Uri;
import android.test.InstrumentationTestCase;
import org.json.JSONObject;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import android.webkit.WebView;
import android.view.MotionEvent;
import android.os.SystemClock;

public class ShellTest extends InstrumentationTestCase {
    public void testTouchOpensSettings() throws Exception {
        Intent intent = new Intent(getInstrumentation().getTargetContext(), MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        MainActivity activity = (MainActivity) getInstrumentation().startActivitySync(intent);
        java.lang.reflect.Field field = MainActivity.class.getDeclaredField("web");
        field.setAccessible(true);
        WebView web = (WebView) field.get(activity);
        try {
            boolean ready = false;
            for (int i = 0; i < 80; i++) {
                if ("true".equals(evaluate(web, "!!document.querySelector('.app-shell')"))) { ready = true; break; }
                Thread.sleep(100);
            }
            assertTrue("The released workbench must load", ready);
            String bounds = evaluate(web, "(function(){var r=document.querySelector('[aria-label=\"API 连接与设置\"]').getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2,devicePixelRatio];})()");
            org.json.JSONArray point = new org.json.JSONArray(bounds);
            int[] origin = new int[2];
            getInstrumentation().runOnMainSync(() -> web.getLocationOnScreen(origin));
            float x = origin[0] + (float) (point.getDouble(0) * point.getDouble(2));
            float y = origin[1] + (float) (point.getDouble(1) * point.getDouble(2));
            long time = SystemClock.uptimeMillis();
            MotionEvent down = MotionEvent.obtain(time, time, MotionEvent.ACTION_DOWN, x, y, 0);
            MotionEvent up = MotionEvent.obtain(time, time + 100, MotionEvent.ACTION_UP, x, y, 0);
            getInstrumentation().sendPointerSync(down);
            getInstrumentation().sendPointerSync(up);
            down.recycle(); up.recycle();
            boolean opened = false;
            for (int i = 0; i < 40; i++) {
                if ("true".equals(evaluate(web, "!!document.querySelector('#settings-title')"))) { opened = true; break; }
                Thread.sleep(100);
            }
            assertTrue("A physical touch must open API settings", opened);
        } finally { getInstrumentation().runOnMainSync(activity::finish); }
    }

    private String evaluate(WebView web, String script) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        String[] value = new String[1];
        getInstrumentation().runOnMainSync(() -> web.evaluateJavascript(script, result -> {
            value[0] = result; done.countDown();
        }));
        assertTrue("WebView JavaScript did not respond", done.await(5, TimeUnit.SECONDS));
        return value[0];
    }

    public void testNewTaskCanExportAfterAbandonedPicker() throws Exception {
        getInstrumentation().getTargetContext().getSharedPreferences("frame-exports", Activity.MODE_PRIVATE)
                .edit().clear().commit();
        Intent intent = new Intent(getInstrumentation().getTargetContext(), MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        MainActivity activity = (MainActivity) getInstrumentation().startActivitySync(intent);
        IntentFilter filter = new IntentFilter(Intent.ACTION_CREATE_DOCUMENT);
        filter.addCategory(Intent.CATEGORY_OPENABLE);
        filter.addDataType("application/json");
        android.app.Instrumentation.ActivityMonitor picker = getInstrumentation().addMonitor(filter, null, true);
        Exports[] owners = new Exports[2];
        try {
            getInstrumentation().runOnMainSync(() -> {
                try {
                    owners[0] = new Exports(activity, Backend.get(activity));
                    owners[0].save(new JSONObject().put("name", "abandoned.json")
                            .put("text", "{\"old\":true}").put("type", "application/json"));
                    owners[0].close();
                    owners[1] = new Exports(activity, Backend.get(activity));
                    owners[1].save(new JSONObject().put("name", "new.json")
                            .put("text", "{\"new\":true}").put("type", "application/json"));
                } catch (Exception error) { throw new RuntimeException(error); }
            });
            assertEquals("A fresh task must open the picker for a new export", 2, picker.getHits());
        } finally {
            getInstrumentation().removeMonitor(picker);
            getInstrumentation().runOnMainSync(() -> {
                if (owners[1] != null) owners[1].close();
                activity.getSharedPreferences("frame-exports", Activity.MODE_PRIVATE).edit().clear().commit();
                activity.finish();
            });
        }
    }

    public void testExportSurvivesActivityOwnerRecreation() throws Exception {
        Intent intent = new Intent(getInstrumentation().getTargetContext(), MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        MainActivity activity = (MainActivity) getInstrumentation().startActivitySync(intent);
        File target = new File(activity.getCacheDir(), "export-recreation-result.json");
        target.delete();
        Backend backend = Backend.get(activity);
        Exports[] owners = new Exports[2];
        getInstrumentation().runOnMainSync(() -> {
            try {
                owners[0] = new Exports(activity, backend);
                owners[0].save(new JSONObject().put("name", "recreation.json")
                        .put("text", "{\"version\":1}").put("type", "application/json"));
                owners[0].close();
                owners[1] = new Exports(activity, backend, true);
                owners[1].onResult(11, Activity.RESULT_OK, new Intent().setData(Uri.fromFile(target)));
            } catch (Exception error) { throw new RuntimeException(error); }
        });
        long deadline = System.currentTimeMillis() + 5000;
        while ((!target.exists() || target.length() == 0) && System.currentTimeMillis() < deadline) Thread.sleep(50);
        assertTrue("The chosen document must be written after recreation", target.isFile());
        assertEquals("{\"version\":1}", new String(Files.readAllBytes(target.toPath()), StandardCharsets.UTF_8));
        getInstrumentation().runOnMainSync(() -> { owners[1].close(); activity.finish(); });
    }
}
