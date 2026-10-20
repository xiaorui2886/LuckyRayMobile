<div align="center">

# LuckyRay Mobile

### 把素材与想法，带在身边。

随身素材库 · Markdown 知识库 · LuckyRay 桌面协同

[下载 Android 公开测试版](https://github.com/xiaorui2886/LuckyRayMobile/releases/download/v0.2.0-r7/LuckyRay-Mobile-0.2.0-R7-android-arm64.apk) · [唯一官网](https://luckyray.me) · [桌面端](https://github.com/xiaorui2886/LuckyRay) · [构建与测试](BUILDING.md) · [问题反馈](https://github.com/xiaorui2886/LuckyRayMobile/issues)

![Android](https://img.shields.io/badge/platform-Android-7c6ba1?style=flat-square)
[![MIT](https://img.shields.io/badge/license-MIT-7c6ba1?style=flat-square)](LICENSE)
[![Build](https://github.com/xiaorui2886/LuckyRayMobile/actions/workflows/ci-lite.yml/badge.svg?branch=task%2Fmobile-r7-release-20261020)](https://github.com/xiaorui2886/LuckyRayMobile/actions/runs/39390323694)

</div>

## 一个随身入口，接上你的资料库

灵感不一定出现在电脑前。LuckyRay Mobile 让你在手机上整理素材、阅读和编辑笔记，也能连接 LuckyRay 桌面，访问获授权的资料与桌面 AI 服务。

- **素材库**：查看、搜索和整理本机素材，连接桌面后访问电脑上的素材。
- **知识库**：文件夹与 Markdown 笔记、阅读与编辑、图片预览、笔记链接与引用。
- **桌面协同**：配对后访问桌面提供的能力。电脑端功能需要兼容的 LuckyRay 桌面运行并授权。
- **手机优先**：围绕触控、键盘、窄屏与 Android 使用体验持续改进。

## 当前状态

当前公开测试版为 **0.2.0 · R7**（发布标签 `v0.2.0-r7`）。R7 已在 MI 8 上由用户实机验收通过；其他设备的交互与兼容性仍需要反馈，不把一台设备的验收扩大为所有手机通过。

### 下载与安装

[**直接下载已签名 APK · Android ARM64 · 约 27.9 MiB**](https://github.com/xiaorui2886/LuckyRayMobile/releases/download/v0.2.0-r7/LuckyRay-Mobile-0.2.0-R7-android-arm64.apk)

[版本说明](https://github.com/xiaorui2886/LuckyRayMobile/releases/tag/v0.2.0-r7) · [SHA256SUMS](https://github.com/xiaorui2886/LuckyRayMobile/releases/download/v0.2.0-r7/SHA256SUMS) · [构建与签名信息](https://github.com/xiaorui2886/LuckyRayMobile/releases/download/v0.2.0-r7/BUILD-INFO.json)

- 最低 Android 7.0（API 24），仅支持 ARM64。本机素材与笔记可独立使用；电脑内容需要兼容桌面端运行并配对授权。
- 这是 **release 优化构建的公开测试版**，不是稳定版。应用内版本保持已验收的 `0.2.0 / 2000`，没有为发布重编或修改 APK。
- 沿用现有 **Android Debug 测试证书**，已验证同签名旧安装可保留数据覆盖升级；没有更换签名，也不冒称应用商店生产签名。
- 若系统提示签名冲突，请保留现有资料并核对安装来源，不要卸载或清数据绕过。Actions 的 unsigned 中间产物不能直接安装，请使用上面的已签名 Release 下载。

APK 大小：**29,209,168 字节**。SHA-256：

```text
4b20dd946e145ae0c4433c92dba9a545b8d2028e0ec8721a07b67bf9a5ec5395
```

签名证书 SHA-256：`f57c2370cb6dfd4f51b869199f6c415825dc4eae5db22054ae8542c9292541e4`。

### 本轮改进

- 电脑笔记首开不再错误闪现未连接；仅为可见和附近少量笔记补齐正文，保留草稿、版本与电脑/库身份保护。
- 素材收藏文本固定为“收藏”，状态只由图标体现，减少同步提示干扰。
- 菜单遮罩与 Android 状态栏联动，嵌套关闭与切换主题后正确恢复。
- 本机图片优先原图；电脑缩略图在清晰内容解码后平滑切换，复用缓存并保留自动获取与大图保护。

对应[固定产品源码](https://github.com/xiaorui2886/LuckyRayMobile/tree/d866cbca1e2e490e6befb4a849f14cd9fea3ca4e)与[公开构建记录](https://github.com/xiaorui2886/LuckyRayMobile/actions/runs/39390323694)。签名和安装边界详见 [BUILDING.md](BUILDING.md)。

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
