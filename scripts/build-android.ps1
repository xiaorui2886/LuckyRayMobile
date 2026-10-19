[CmdletBinding()]
param(
    [string]$JavaHome = $env:JAVA_HOME,
    [string]$AndroidHome = $env:ANDROID_HOME,
    [string]$GradleUserHome = $env:GRADLE_USER_HOME,
    [string]$CargoTargetDir = $env:CARGO_TARGET_DIR,
    [string]$SocketTempDirectory = (Join-Path $env:USERPROFILE '.gradle\luckyray-sockets'),
    [string]$GitBash = (Join-Path $env:ProgramFiles 'Git\bin\bash.exe'),
    [ValidateSet('aarch64', 'armv7', 'i686', 'x86_64')]
    [string]$Target = 'aarch64'
)
$ErrorActionPreference = 'Stop'
$mobileRoot = Split-Path -Parent $PSScriptRoot
if (-not $AndroidHome) { $AndroidHome = $env:ANDROID_SDK_ROOT }
if (-not $JavaHome -or -not (Test-Path -LiteralPath "$JavaHome\bin\java.exe")) { throw 'Set JavaHome to an installed JDK 17 directory.' }
if (-not $AndroidHome -or -not (Test-Path -LiteralPath "$AndroidHome\platform-tools")) { throw 'Set AndroidHome to the Android SDK directory.' }
if (-not (Test-Path -LiteralPath $GitBash)) { throw 'Set GitBash to Git for Windows bin/bash.exe (not the WSL launcher).' }
$mobileCli = Join-Path $mobileRoot 'node_modules\@tauri-apps\cli\tauri.js'
if (-not (Test-Path -LiteralPath $mobileCli)) { throw 'Run pnpm install --frozen-lockfile in this checkout first.' }
$mobileNode = (Get-Command node -CommandType Application | Select-Object -First 1).Source
$mobileScopedCargoTarget = & $mobileNode (Join-Path $PSScriptRoot 'configure-android-build.mjs') --cargo-target-dir $CargoTargetDir
if ($LASTEXITCODE -ne 0) { throw 'Could not resolve the checkout-scoped Android Cargo target.' }
Write-Host "Android Cargo target (checkout-scoped): $mobileScopedCargoTarget"
$mobileSocketTemp = [IO.Path]::GetFullPath($SocketTempDirectory)
if ($mobileSocketTemp.Length -gt 75 -or $mobileSocketTemp -match '["\r\n]') { throw 'Choose a shorter socket temp path (at most 75 characters, no quotes or newlines).' }
New-Item -ItemType Directory -Path $mobileSocketTemp -Force | Out-Null
$mobileEnvironment = @{
    JAVA_HOME = $JavaHome
    ANDROID_HOME = $AndroidHome
    ANDROID_SDK_ROOT = $AndroidHome
    NDK_HOME = (Join-Path $AndroidHome 'ndk\27.2.12479018')
    LUCKYRAY_NODE = $mobileNode
    CARGO_TARGET_DIR = $mobileScopedCargoTarget
    PATH = "$JavaHome\bin;$env:PATH"
    JAVA_TOOL_OPTIONS = (($env:JAVA_TOOL_OPTIONS + ' "-Djdk.net.unixdomain.tmpdir=' + $mobileSocketTemp.Replace('\', '/') + '"').Trim())
    # Gradle does not include this socket property in daemon compatibility.
    # A new single-use daemon must inherit it; an old daemon may have already
    # initialized JDK's static socket directory from a different environment.
    GRADLE_OPTS = (($env:GRADLE_OPTS + ' -Dorg.gradle.daemon=false').Trim())
}
# Kotlin's incremental path converter cannot relativize Cargo plugin sources
# and the generated project across Windows drives. Use a full Kotlin compile
# only for that layout; this changes build caching, not packaged app behavior.
$mobileCargoHome = $env:CARGO_HOME
if (-not $mobileCargoHome) { $mobileCargoHome = Join-Path $env:USERPROFILE '.cargo' }
if (-not [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($mobileCargoHome)).Equals([IO.Path]::GetPathRoot($mobileRoot), [StringComparison]::OrdinalIgnoreCase)) {
    $mobileEnvironment['ORG_GRADLE_PROJECT_kotlin.incremental'] = 'false'
    Write-Host 'Cargo sources and project are on different drives: Kotlin incremental compilation disabled for this build.'
}
if ($GradleUserHome) { $mobileEnvironment.GRADLE_USER_HOME = $GradleUserHome }
$mobilePrevious = @{}
$mobilePushed = $false
try {
    foreach ($mobileName in $mobileEnvironment.Keys) {
        $mobilePrevious[$mobileName] = [Environment]::GetEnvironmentVariable($mobileName, 'Process')
        [Environment]::SetEnvironmentVariable($mobileName, $mobileEnvironment[$mobileName], 'Process')
    }
    Push-Location $mobileRoot
    $mobilePushed = $true
    & "$JavaHome\bin\java.exe" (Join-Path $PSScriptRoot 'java\JavaSelectorProbe.java')
    if ($LASTEXITCODE -ne 0) { throw 'Java local IPC preflight failed; Android build was not started.' }
    & $mobileNode $mobileCli android init --ci --skip-targets-install
    if ($LASTEXITCODE -ne 0) { throw 'Tauri Android generation failed.' }
    & $GitBash (Join-Path $PSScriptRoot 'apply-android-patches.sh')
    if ($LASTEXITCODE -ne 0) { throw 'Android project configuration failed.' }
    & $mobileNode $mobileCli android build --apk --target $Target --ci --verbose
    if ($LASTEXITCODE -ne 0) { throw 'Tauri Android build failed; inspect the preceding task output.' }
} finally {
    try {
        if ($mobilePushed) { Pop-Location }
    } finally {
        foreach ($mobileName in $mobilePrevious.Keys) {
            if ($null -eq $mobilePrevious[$mobileName]) {
                Remove-Item -LiteralPath "Env:\$mobileName" -ErrorAction SilentlyContinue
            } else {
                [Environment]::SetEnvironmentVariable($mobileName, $mobilePrevious[$mobileName], 'Process')
            }
        }
    }
}
