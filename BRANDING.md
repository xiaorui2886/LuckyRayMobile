# LuckyRay Mobile Android 图标受控生成

## 保留完整原图边缘

当前方案统一保留箭头、深色面板及整圈蓝紫外沿，不按品牌、型号分支，不重新绘制标志。

所有受支持 Android 版本使用同一个高分辨率透明 BitmapDrawable。没有不透明垫底、额外 inset 或自适应外壳；roundIcon 也引用相同原图。旧箭头前景和采样渐变背景已撤下。

## 原图及派生资源

- src-tauri/icons/icon.png：桌面 512px 存档，字节不变；来源 8479bbf20cf01d608b2415e746d74fe12b4081e7，SHA-256 fed987e1689e8bdb15eaad881e18e0f5d38bda3bc83fc17c2a10a4b977fd0a0c。
- src-tauri/icons/luckyray-original.png：完整 1254px 透明品牌原图，字节不变；SHA-256 74924112feeb2451c738b8a21fb252d501c0e4b94ab4d75b16846cb0f5e666ae。
- src-tauri/icons/luckyray-android.png：1254px 派生图，保留每一字节 alpha 和所有 alpha>=250 的原始 RGBA。只在八像素范围内借用近不透明邻居的 RGB，清理半透明边缘的白色消光残留；不腐蚀透明度、不增加底色。
- android/drawable-nodpi/ic_launcher_artwork.png：926×926 透明原图内容。原图 alpha>=8 的可见范围加两像素留边为 [177,128,1098,1054]，以原始像素直接拷贝，再用透明像素补方形；不重采样，不裁任何可见倒角，不另加深色边框。六个原图控制点包含半透明边缘、左侧外沿、顶部紫边、右侧及底部蓝边。
- android/mipmap-anydpi-v21/ic_launcher.xml：高分辨率位图入口，指向上述 nodpi 图片；gravity=fill、滤波开启。构建时派生内容完全相同的 round XML。当前应用 minSdk=24，两者在受支持系统均可用。
- 十张 48/72/96/144/192px 普通和 round PNG：保留整个 1254px 画布的密度 fallback，用于模板兼容；同档 normal/round 字节一致。

来源、导出范围、控制点和文件哈希固定在 src-tauri/icons/luckyray-branding.json revision 8。正常构建只校验并复制受控资源，不依赖 Photoshop、Python 或在线图像服务。既有包名、数据路径、版本、签名和应用功能不变。

## 验证范围及系统限制

资源回归逐行比较导出图与原图派生像素，逐字节比较全画布 alpha，验证所有近不透明原图像素不变，并检查六处外沿控制点。原图 (181,513) 是 alpha=227 的半透明消光像素，只允许清理 RGB，alpha 必须仍为 227；其余五个不透明控制点保留原始 RGBA。

之前的 cover 裁切和箭头分层遗漏外沿，均不能记作本需求通过。当前还原原图边缘，不等于能控制每种启动器的兼容外壳：

- [Android AdaptiveIconDrawable 源码](https://github.com/aosp-mirror/platform_frameworks_base/blob/master/graphics/java/android/graphics/drawable/AdaptiveIconDrawable.java)在绘制图层之前填黑，透明自适应背景不能保证输出透明，因此本版不使用该包装。
- 启动器可能给旧式位图增加兼容底圈；系统/OEM 的主题、阴影与兼容处理不由图片资源决定。本版不承诺跨所有启动器消除系统加框。
- 必须分别验证实际 APK 资源和目标设备显示；资源测试不能替代真实设备的视觉验收。

## 可重复生成与构建

维护工具：Python 3、Pillow==12.3.0。

    python scripts/generate-android-icons.py
    python scripts/generate-android-icons.py --check
    node scripts/apply-android-icons.mjs --verify-source
    node --experimental-strip-types --test tests/androidIconsR8.test.ts

生成器先验证两个源图固定哈希，再生成派生图、完整高分辨率位图、十张 fallback PNG、一项 v21 XML 和清单。--check 只读逐字节对比。

Windows/Linux 共用流程：Tauri init → apply-android-patches.sh → apply-android-icons.mjs。应用脚本先校验所有源文件和几何约束，再写入十二项 Android 资源并派生 round XML，共十三项；精确删除旧 v26/v33 icon XML、前景/背景 PNG 和背景颜色 XML，不删除父目录或无关文件。反复 init/patch 的结果一致。

实际 APK 应解析资源表，验证十张 fallback PNG、一张 926px nodpi 图、两项 v21 bitmap XML，确认无旧 adaptive 覆盖层；还需验证版本/ABI、权限、签名及实际启动。维护工具与测试夹具不进入发行包。品牌资源归 LuckyRay 所有，其他第三方许可证不变。
