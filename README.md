<div align="center">

# LuckyRay Mobile

### 把素材与想法，带在身边。

随身素材库 · Markdown 知识库 · LuckyRay 桌面协同

[下载 Android 公开测试版](https://github.com/xiaorui2886/LuckyRayMobile/releases/download/v0.2.1/LuckyRay-Mobile-0.2.1-arm64-update.apk) · [唯一官网](https://luckyray.me) · [桌面端](https://github.com/xiaorui2886/LuckyRay) · [构建与测试](BUILDING.md) · [问题反馈](https://github.com/xiaorui2886/LuckyRayMobile/issues)

![Android](https://img.shields.io/badge/platform-Android-7c6ba1?style=flat-square)
[![MIT](https://img.shields.io/badge/license-MIT-7c6ba1?style=flat-square)](LICENSE)
[公开源码构建与测试](https://github.com/xiaorui2886/LuckyRayMobile/actions/workflows/ci-lite.yml)

</div>

## 一个随身入口，接上你的资料库

灵感不一定出现在电脑前。LuckyRay Mobile 让你在手机上整理素材、阅读和编辑笔记，也能连接 LuckyRay 桌面，访问获授权的资料与桌面 AI 服务。

- **素材库**：查看、搜索和整理本机素材，连接桌面后访问电脑上的素材。
- **知识库**：文件夹与 Markdown 笔记、阅读与编辑、图片预览、笔记链接与引用。
- **桌面协同**：配对后访问桌面提供的能力。电脑端功能需要兼容的 LuckyRay 桌面运行并授权。
- **手机优先**：围绕触控、键盘、窄屏与 Android 使用体验持续改进。

## 当前状态

当前公开测试版为 **0.2.1**（发布标签 `v0.2.1`，应用版本 `0.2.1 / 2001`）。本轮在小米 8 上验证了同签名覆盖安装和数据保留、启动，以及主页、素材、知识库和图谱的限定检查。14 Ultra、多机型、完整新业务回归、真实同步确认、模型/LSH 和图谱整体流畅度尚未在本轮验证，不将单机限定检查扩大为全功能或全机型通过。

### 下载与安装

[**直接下载已签名 APK · Android ARM64 · 约 30.1 MiB**](https://github.com/xiaorui2886/LuckyRayMobile/releases/download/v0.2.1/LuckyRay-Mobile-0.2.1-arm64-update.apk)

[完整版本说明](https://github.com/xiaorui2886/LuckyRayMobile/releases/tag/v0.2.1) · [SHA256SUMS.txt](https://github.com/xiaorui2886/LuckyRayMobile/releases/download/v0.2.1/SHA256SUMS.txt) · [构建与签名信息](https://github.com/xiaorui2886/LuckyRayMobile/releases/download/v0.2.1/BUILD-INFO.json)

- 最低 Android 7.0（API 24），仅支持 ARM64，包名为 `com.luckyray.mobile`。本机素材与笔记可独立使用；电脑内容需要兼容桌面端运行并配对授权。
- 这是 **release 优化构建的公开测试版**，不是稳定版。沿用现有 **Android Debug 测试证书**，不是应用商店生产签名。
- 已验证同签名旧安装可保留数据覆盖升级。若系统提示签名冲突，请保留现有资料并核对安装来源，不要卸载或清数据绕过。
- Actions 的 unsigned 中间产物不能直接安装，请使用上面的已签名 Release 下载。当前公开源码构建也不能视为此 APK 的对应构建，详见下方源码状态。

APK 大小：**31,584,736 字节**。SHA-256：

```text
159d8859a09da50d1ba02b35007733eae6dd5a4d88b33ea220217d930d2289c5
```

签名证书 SHA-256：`f57c2370cb6dfd4f51b869199f6c415825dc4eae5db22054ae8542c9292541e4`。

### 功能更新

以下汇总自上次公开 R8 以来的累计改进，不代表全部在 0.2.1 打包时新开发。从最近一次已验证的内部产品构建到本安装包，仅调整版本号为 `0.2.1 / 2001`。

- **笔记编辑**：Markdown 实时预览、笔记双向链接、目录导航与表格单元格编辑。
- **统一知识库**：集中浏览本机与已授权电脑的笔记，支持已缓存内容离线阅读、文件夹整理与回收站。未缓存的电脑内容仍需连接兼容桌面端获取。
- **素材与附件**：素材瀑布流、图片与视频查看、最近浏览和笔记附件。
- **本地图谱**：搜索、筛选与交互，继续使用 Canvas 绘制。
- **桌面协同**：保留原有配对与同步，以及从手机导入素材到已授权电脑素材库的能力。需要兼容桌面端运行、配对并授权。

本版**不包含手机远程画布及其入口**。ComfyUI 原文件的媒体类型及缓存问题仍待修复，本版没有宣称解决该问题。完整功能说明与测试边界见 [0.2.1 Release](https://github.com/xiaorui2886/LuckyRayMobile/releases/tag/v0.2.1)。

### 源码状态

与 0.2.1 安装包对应的公开源码快照正在审核和同步。同步完成前，本仓库当前公开源码、`v0.2.1` 标签及 GitHub 自动生成的 Source code 压缩包对应此前的公开源码，**不能作为此 APK 的准确构建源码**。完成审核后将提供固定的公开源码链接。

此前 R7 的[固定产品源码](https://github.com/xiaorui2886/LuckyRayMobile/tree/d866cbca1e2e490e6befb4a849f14cd9fea3ca4e)与[公开构建记录](https://github.com/xiaorui2886/LuckyRayMobile/actions/runs/39390323694)仅供历史参考。通用构建与签名边界见 [BUILDING.md](BUILDING.md)，0.2.1 安装包信息以本次 Release 为准。

iOS 尚未提供经过验证的发行包。手机端不捆绑本地大模型；桌面 AI 功能依赖桌面服务与用户自己的配置。

## 开发与参与

前端使用 React 19、TypeScript、Vite；原生层使用 Tauri 2 与 Rust，并包含 Android 桥接代码。

```sh
pnpm install --frozen-lockfile
pnpm build
```

完整 Android 环境、构建、测试入口见 [BUILDING.md](BUILDING.md)。

欢迎提出可复现的问题和小而清晰的改进。提交前请阅读 [贡献指南](CONTRIBUTING.md)；安全问题请阅读 [SECURITY.md](SECURITY.md)，不要在公开 Issue 上传账号信息、配对凭据或个人资料。

本仓库承载公开源码、公开问题反馈、构建测试与发行产物。维护团队的内部任务派发和交接记录不随源码公开。源码同步采用审核后的文件快照，不导入内部协作历史。

## 许可

LuckyRay 自有源码采用 [MIT License](LICENSE)。第三方依赖、图标与组件保留各自许可，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

如果这个项目对你有帮助，欢迎点一个 Star，也欢迎把真实使用中的反馈带回来。
