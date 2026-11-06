# 第三方组件与许可

项目根目录的 MIT 许可适用于 LuckyRay 自有代码，不替代第三方组件的原始许可。

本项目通过锁文件引用第三方依赖；完整版本以 `pnpm-lock.yaml` 和 `src-tauri/Cargo.lock` 为准。构建时下载的依赖请保留其许可证、版权和 NOTICE 文件。以下为主要组件说明，并非全量依赖法律审计报告。

- React、TypeScript、Vite、CodeMirror、react-markdown、remark / unified：沿用各软件包随附许可。
- 图谱本地布局复用 LuckyRay 桌面实现及 d3-force、d3-dispatch、d3-quadtree、d3-timer；ISC 许可与版权声明保留在 `third-party/graph-d3.txt`，并通过 `public/third-party/graph-d3.txt` 随应用打包。
- Tauri、tauri-apps plugins 及 Android 构建集成：沿用对应官方源码的 MIT / Apache-2.0 等许可。生成模板和基于模板维护的构建文件也受其原始条款约束，许可副本保留在 `third-party/tauri/`。
- Rust 原生依赖（包括 Tokio、Serde、Reqwest、Rustls、Rusqlite 等）：各自许可见锁定版本的软件包。
- AndroidX、CameraX、Material、Google ML Kit 及其依赖：依赖声明见 `scripts/apply-android-patches.sh`，适用各组件发布时的许可与条款，不由本项目 MIT 许可重新授权。
- AndroidX Media3、Guava 与 failureaccess：保留 `scripts/android-src/MEDIA3-NOTICE.txt`。Android 补丁脚本将该说明与 Apache-2.0 许可一并放入生成应用的 assets。

本仓库不提供第三方服务账号、密钥或配对凭据；用户自行连接的桌面服务和第三方服务仍适用其各自条款。

如果你发现遗漏或不准确的署名，请提交不含私人信息的 Issue 或 PR，注明文件、原始来源与许可。
