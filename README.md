<div align="center">

# LuckyRay Mobile

### 把素材与想法，带在身边。

随身素材库 · Markdown 知识库 · LuckyRay 桌面协同

[下载 Android 公开测试版](https://github.com/xiaorui2886/LuckyRayMobile/releases/download/v0.2.2/LuckyRay-Mobile-0.2.2-arm64-update.apk) · [唯一官网](https://luckyray.me) · [桌面端](https://github.com/xiaorui2886/LuckyRay) · [构建与测试](BUILDING.md) · [问题反馈](https://github.com/xiaorui2886/LuckyRayMobile/issues)

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

当前公开测试版为 **0.2.2**（发布标签 `v0.2.2`，应用版本 `0.2.2 / 2002`）。本次修复缩略图等待时的双指缩放、清晰图片加载后的缩放保持，以及旧媒体类型缓存导致的原图/视频读取问题。

开发验收在小米 8 / Android 10 / WebView 83 完成同签名覆盖安装与数据保留、实际双指缩放和拖动检查；此前原图缓存恢复与动态视频播放也有小米 8 实测。14 Ultra、多机型、全量同步、LSH/模型、所有视频编码及音频实听未在本轮验证。远端大图分片导入曾返回 `SERVICE_UNAVAILABLE`，仍未解决。本版**不含手机远程画布及其入口**。

### 下载与安装

[**直接下载已签名 APK · Android ARM64 · 约 30.1 MiB**](https://github.com/xiaorui2886/LuckyRayMobile/releases/download/v0.2.2/LuckyRay-Mobile-0.2.2-arm64-update.apk)

[完整版本说明](https://github.com/xiaorui2886/LuckyRayMobile/releases/tag/v0.2.2) · [SHA256SUMS.txt](https://github.com/xiaorui2886/LuckyRayMobile/releases/download/v0.2.2/SHA256SUMS.txt) · [构建与签名信息](https://github.com/xiaorui2886/LuckyRayMobile/releases/download/v0.2.2/BUILD-INFO.json)

- 最低 Android 7.0（API 24），仅支持 ARM64，包名为 `com.luckyray.mobile`。本机素材与笔记可独立使用；电脑内容需要兼容桌面端运行并配对授权。
- 这是 **release 优化构建的公开测试版**，不是稳定版。沿用现有 **Android Debug 测试证书**，不是应用商店生产签名。
- 已验证同签名旧安装可保留数据覆盖升级。若系统提示签名冲突，请保留现有资料并核对安装来源，不要卸载或清数据绕过。
- Actions 的 unsigned 中间产物不能直接安装，请使用上面的已签名 Release 下载。公开 CI 的 unsigned 中间产物不等于已签名发行包；对应源码和验证边界见下方说明。

APK 大小：**31,584,736 字节**。SHA-256：

```text
0ea2582a05d4c276c0193bf9f02890998a4f15d206d4a26f608fcf55878021b8
```

签名证书 SHA-256：`f57c2370cb6dfd4f51b869199f6c415825dc4eae5db22054ae8542c9292541e4`。

### 功能更新

**0.2.2 新增修复**
- 缩略图已显示但清晰内容未就绪时可双指放大与拖动；清晰图片到达后保留缩放和位置。
- 双指转单指、取消和指针捕获丢失时正确衔接，保留 1–4 倍限制。
- 在既有授权范围内重新读取被旧通用 MIME 缓存影响的原图和视频，保留准确的失败提示。

**从 R8 以来保留的累计功能**（并非全部在本次新增）：

- **笔记编辑**：Markdown 实时预览、笔记双向链接、目录导航与表格单元格编辑。
- **统一知识库**：集中浏览本机与已授权电脑的笔记，支持已缓存内容离线阅读、文件夹整理与回收站。未缓存的电脑内容仍需连接兼容桌面端获取。
- **素材与附件**：素材瀑布流、图片与视频查看、最近浏览和笔记附件。
- **本地图谱**：搜索、筛选与交互，继续使用 Canvas 绘制。
- **桌面协同**：保留原有配对与同步，以及从手机导入素材到已授权电脑素材库的能力。需要兼容桌面端运行、配对并授权。

本版**不包含手机远程画布及其入口**。缩略图放大不增加细节；超过原有 32 MiB 自动展示上限的大图使用受限清晰预览。远端大图导入、部分真机手势及未测机型/媒体范围见 [0.2.2 完整发行说明](https://github.com/xiaorui2886/LuckyRayMobile/releases/tag/v0.2.2)。

### 源码状态

本仓库的产品源码、版本配置、锁文件、构建所需资源和第三方声明已同步为 0.2.2 产品快照，来源提交为 `86972f3fb9aca7c85fafffc272b08f427fe0c055`。采用经审核的文件快照，不导入私库协作历史、内部回执、设备资料或签名私钥。

[0.2.2 发行页](https://github.com/xiaorui2886/LuckyRayMobile/releases/tag/v0.2.2)同时提供明确命名的 `LuckyRay-Mobile-0.2.2-source.zip`，包含逐文件来源清单、构建说明和审核边界。安装包沿用已验收的同一签名 APK；源码同步与公开 CI 不等同于 APK 逐字节可复现证明。

公开构建与检查请查看[当前 CI 记录](https://github.com/xiaorui2886/LuckyRayMobile/actions/workflows/ci-lite.yml)，以对应提交的实际结果为准。此前 R7 的[固定源码](https://github.com/xiaorui2886/LuckyRayMobile/tree/d866cbca1e2e490e6befb4a849f14cd9fea3ca4e)与[构建记录](https://github.com/xiaorui2886/LuckyRayMobile/actions/runs/39390323694)仅供历史参考。构建与签名边界见 [BUILDING.md](BUILDING.md)。

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

