import { rateLimitDelay } from "./contentReadCooldown.ts";

export function videoFailureCopy(error: unknown): string {
  const code = String(error);
  if (rateLimitDelay(error) !== null) return "读取频繁，请稍后重试。";
  if (/CODEC_UNSUPPORTED/.test(code)) return "这段视频的格式或编码暂不受本机支持。可以在电脑打开，或换兼容版本。";
  if (/TYPE_UNSUPPORTED|CACHED_TYPE_UNCONFIRMED/.test(code)) return "暂时无法识别这段视频的文件类型，尚未开始播放。请检查电脑端素材后重试。";
  if (/(?:CONTENT_HTTP_|\bhttp\s+)403\b|FORBIDDEN|GRANT_REQUIRED/.test(code)) return "没有读取这段视频的权限，请在电脑授权后重试。";
  if (/(?:CONTENT_HTTP_|\bhttp\s+)401\b|REVOKED|PAIRING_REQUIRED/.test(code)) return "电脑授权已失效，请检查连接设置。";
  if (/SOURCE_CHANGED/.test(code)) return "连接已变化，请回到素材库后重新打开。";
  if (/VERSION_CHANGED/.test(code)) return "电脑上的原文件已更新，请重新播放。";
  return "暂时无法播放，请检查连接后重试。";
}
