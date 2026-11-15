# Android 安装与构建

## 安装

在项目 Releases 下载 `FRAME-1.0.0.apk`，通过 Android 安装器打开。
若系统提示，请仅为实际用于安装的浏览器或文件管理器开启安装应用权限。
安装后打开「API 连接与设置」，填写自己的地址和 API Key，点击「获取模型」并保存。

APK 独立联网运行，不需要电脑、Node.js 或局域网服务器。
手机和电脑版的数据分别存储，不会自动同步。

## 兼容性

| 项目 | 要求 |
| --- | --- |
| Android | 8.0 / API 26 及以上 |
| Android System WebView / Chrome | 105 及以上；过旧时应用显示更新提示 |
| CPU | ARM32、ARM64、x86、x86_64；不含平台专用 native 库 |
| 实际验证 | Android 14 / API 34 / x86_64，WebView 113 |
| 屏幕 | 已检查手机竖屏、横屏、平板尺寸与 1.5 倍系统字体 |

Android 8/9、ARM 手机和各厂商系统尚未实机验证。
支持范围由最低系统版本及平台 API 约束确定，不等同于所有设备均已测试。

## 功能

与电脑版共享 React 工作台，包含多连接、真实模型获取、独立提示词和参考图、
比例与自定义尺寸、画质、数量、格式、背景及额外 JSON 参数。
支持 500 个草稿、100 个并行任务、JSON 导入预览、统一默认值、选择性批改、
跨页选择、筛选、历史、预览和图片复用。

Android 的 API 通信、文件、任务队列及历史由 Java 原生层处理，
不依赖浏览器直接请求上游服务。API 密钥使用 Android Keystore 加密保存在应用私有目录。
应用不会预置服务商没有返回的模型。

- 参考图通过系统文件选择器多选 PNG/JPEG/WebP，最多 16 张，单张不超过 20 MB。
- Android 10 及以上下载图片到 `Pictures/FRAME`；Android 8/9 使用系统保存对话框。
- JSON 示例和 AI 提示词通过系统保存对话框导出；提示词也可复制到剪贴板。
- 开始生成后使用前台服务显示任务进度通知；允许通知便于查看运行状态。
- 系统强制停止或杀死进程后，未完成任务在下次打开时标记为「已中断」。
  不会自动重试或重复提交付费请求。省电策略仍可能限制后台运行。
- 取消本机请求不保证服务商停止已开始的生成或免除计费。
- 100 并发需要接口额度、限流与网络条件允许。

## 从源码构建

需要 Node.js 22.12+、JDK 17、Android SDK Platform 34 / Build Tools 34.0.0。
首次构建需要联网下载 npm 和 Gradle 依赖。

```powershell
npm ci
$env:JAVA_HOME = '你的 JDK 17 路径'
$env:ANDROID_HOME = '你的 Android SDK 路径'
cd android
.\gradlew.bat :app:assembleDebug :app:lintDebug
```

也可以在 Android Studio 打开 `android/`。`preBuild` 自动构建网页并打包进 APK。
调试 APK 位于 `android/app/build/outputs/apk/debug/app-debug.apk`。

Windows 下构建自己签名的发布版：

```powershell
.\tools\build-android.ps1
```

脚本首次在 `android/signing/` 生成本地私钥。
密码用 Windows 当前用户的 DPAPI 凭据文件保存，均已被 Git 排除。
请自行妥善备份签名材料；公开源码不包含项目正式发布所用的私钥。
自行签名的包不能直接覆盖项目发布包，卸载会删除手机内的应用数据。

## 项目结构

| 目录 | 作用 |
| --- | --- |
| `src/`、`shared/` | 电脑与 Android 共用界面和校验 |
| `server/` | 电脑本地 Node.js 服务 |
| `android/app/src/main/` | Android 原生通信、持久化、文件与服务 |
| `android/app/src/androidTest/` | 原生仪器测试 |
| `tests/` | 桌面、批量规则、平台适配测试 |
| `tools/android-*` | 本地模拟服务和模拟器验收辅助工具 |
