# Android 1.0.0 验收记录

日期：2026-11-15。

## 环境

- 独立 AVD：`frame_qa_api34`，显式使用 `emulator-5580`。
- Android 14 / API 34 / Google APIs / x86_64；WebView 113。
- JDK 17、Gradle 8.2、Android Gradle Plugin 8.2.2、SDK 34。
- 严格本地模拟上游，不调用付费图像服务，不使用用户真实 API 密钥。
- 未操作连接中的实体手机。

## 结果

| 检查 | 结果 |
| --- | --- |
| JavaScript 单元与集成测试 | 36 通过 |
| Android BackendTest | 17 通过 |
| Android ShellTest | 3 通过 |
| 最终正式签名 APK 完整仪器测试 | 20 通过，11.939 秒 |
| Debug / Release 构建 | 通过 |
| Android Lint | 0 错误；保留同步持久化、JS 页面和中文原生提示等提示项 |
| 正式 APK 签名 | APK Signature Scheme v2 验证通过，3072 位 RSA |

原生测试覆盖队列、100 并发、真实模型替换、密钥隐藏及持久化、
图片字节和尺寸校验、multipart 多图、超时/取消、无自动重试、重启中断、
并发快照、响应上限和原子历史写入。

文件导出补充了两个回归：Activity 重建后仍能完成保存；
丢弃的系统保存对话框不会阻塞下次导出。均先复现再修复。
最终另用与正式包相同签名的测试 APK，直接针对发布 APK 运行全部 20 项测试，
包含实际触控打开设置。正式包的 WebView 调试保持关闭。

## 界面实测

1. 连续 5 次冷启动，工作台与配置均正常加载。
2. 界面设置本地测试地址与密钥，将并发设为 100，获取仅有两个实际模型的列表。
   设置与任务模型均使用这两个实际 ID。
3. JSON 一次导入 100 个不同提示词；第 5 项独立覆盖模型、竖图尺寸和两张输出。
   每页 25 项，草稿持久化 100 项。
4. 统一参数只勾选画质，确认独立模型、尺寸、数量和提示词保留。
   随后单独修改第 5 项画质，其余任务保持原值。
5. 从界面执行「全部生成」。本地上游观测峰值并发为 100，
   切到主屏幕后仍有前台服务。100 项全部完成，共 101 张图片。
   模拟上游未发现参数协议错误。
6. 预览结果，保存到 `Pictures/FRAME`，复用为新任务参考图。
7. 用 Android 系统文件选择器同时选择 PNG、JPEG、WebP；
   连同复用图片共 4 张参考图，通过 `image[]` multipart 成功生成。
8. 系统选择器导入 JSON 文件；校验和导入成功。
   系统保存对话框导出 JSON 示例，验证实际文件内容；
   AI JSON 提示词复制成功。
9. URL 形式的图像结果成功落盘；
   一个任务的 429 不影响其他任务，错误中不含测试密钥；
   活动任务可取消；强制停止再打开后标记已中断，无重提交。
10. 手机竖屏 393×778、横屏 802×345、1.5 倍系统字体、
    1600×2560 / density240 平板尺寸均无页面横向溢出。
    已查看截图，文字和主要控件未发生重叠。

## 复现

仅在独立、无个人数据的测试模拟器执行。界面脚本按干净安装设计，
重复运行前应重置该测试安装的数据；不要对日常使用的安装执行重置。

```powershell
$env:JAVA_HOME = '你的 JDK 17 路径'
$env:ANDROID_HOME = '你的 Android SDK 路径'
$env:FRAME_QA_SERIAL = 'emulator-5580'
npm ci
node tools/android-fixture.mjs
```

另开终端：

```powershell
cd android
.\gradlew.bat :app:assembleDebug :app:assembleDebugAndroidTest
adb -s emulator-5580 install -r app/build/outputs/apk/debug/app-debug.apk
adb -s emulator-5580 install -r app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb -s emulator-5580 shell am instrument -w com.frame.workbench.test/android.test.InstrumentationTestRunner
adb -s emulator-5580 shell am start -n com.frame.workbench/.MainActivity
cd ..
node tools/android-ui-qa.mjs
node tools/android-lifecycle-qa.mjs
```

系统文件选择器另用 `tools/android-tree.mjs` 按实际 UI XML 坐标操作。
验收截图、测试结果与设备日志位于本地 `output/android/`，该目录不上传。
批量压力测试的返回图片为 256×256 测试素材，不代表真实模型的画质或耗时。

## 范围

Android 8/9、ARM 设备和各厂商省电策略未进行实机验证。
Android 8 系统镜像下载未完成，因此未将其记录为已测试平台。
100 并发的实际成功率仍取决于服务商限流、额度及用户网络；
本次验证的是应用并发调度和协议，未测试商业服务商的配额。
