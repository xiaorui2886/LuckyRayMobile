<div align="center">

# LuckyRay Mobile

### 把素材与想法，带在身边。

随身素材库 · Markdown 知识库 · LuckyRay 桌面协同

[唯一官网](https://luckyray.me) · [桌面端](https://github.com/xiaorui2886/LuckyRay) · [构建与测试](BUILDING.md) · [问题反馈](https://github.com/xiaorui2886/LuckyRayMobile/issues)

![Android](https://img.shields.io/badge/platform-Android-7c6ba1?style=flat-square)
[![MIT](https://img.shields.io/badge/license-MIT-7c6ba1?style=flat-square)](LICENSE)
[![Build](https://github.com/xiaorui2886/LuckyRayMobile/actions/workflows/ci-lite.yml/badge.svg)](https://github.com/xiaorui2886/LuckyRayMobile/actions/workflows/ci-lite.yml)

</div>

## 一个随身入口，接上你的资料库

灵感不一定出现在电脑前。LuckyRay Mobile 让你在手机上整理素材、阅读和编辑笔记，也能连接 LuckyRay 桌面，访问获授权的资料与桌面 AI 服务。

- **素材库**：查看、搜索和整理本机素材，连接桌面后访问电脑上的素材。
- **知识库**：文件夹与 Markdown 笔记、阅读与编辑、图片预览、笔记链接与引用。
- **桌面协同**：配对后访问桌面提供的能力。电脑端功能需要兼容的 LuckyRay 桌面运行并授权。
- **手机优先**：围绕触控、键盘、窄屏与 Android 使用体验持续改进。

## 当前状态

这是正在开发的 **Android 优先版本**，当前应用源码版本为 **0.2.0**。本次开放的是已安装测试过的 R5 开发快照，仍可能有交互和设备兼容问题，不能把一次构建通过当成所有手机实测通过。

当前没有在此仓库发布稳定版 APK。Actions 的 APK 是开发测试产物，签名、覆盖安装及数据备份注意事项见 [BUILDING.md](BUILDING.md)。请勿为安装测试包而卸载含重要资料的现有应用。

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
