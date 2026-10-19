fn main() {
    tauri_build::build();

    let is_android = std::env::var("CARGO_CFG_TARGET_OS").map(|v| v == "android").unwrap_or(false);
    if is_android {
        // NDK r27 defaults to 4 KiB. Both ELF load segments and APK ZIP
        // alignment must support 16 KiB; zipalign cannot fix ELF segments.
        println!("cargo:rustc-link-arg=-Wl,-z,max-page-size=16384");
        println!("cargo:rustc-link-arg=-Wl,-z,common-page-size=16384");
        if let Ok(ndk) = std::env::var("NDK_HOME") {
            let arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
            let triple = match arch.as_str() {
                "x86_64" => "x86_64",
                "aarch64" => "aarch64",
                "arm" => "arm",
                "x86" => "i386",
                _ => return,
            };
            let sep = "\\";
            let dir = format!("{ndk}{sep}toolchains{sep}llvm{sep}prebuilt{sep}windows-x86_64{sep}lib{sep}clang{sep}18{sep}lib{sep}linux{sep}{triple}");
            println!("cargo:rustc-link-search={dir}");
        }
    }
}
