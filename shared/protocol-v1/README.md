# LuckyRay Mobile — Protocol V1 (Frozen)

> 状态：**FROZEN**（M2 冻结，M3 Desktop Gateway 必须遵守）
> 日期：2026-08-08
> 位置：仓库内 `shared/protocol-v1`（框架无关，不复制进 Desktop repo）

## 范围

Mobile ↔ Desktop Gateway 之间的应用层契约。传输层（HTTPS/WSS + TLS fingerprint pinning）见
`docs/M1-RESULT.md`（M1 已验证）。

## 核心原则

1. **`desktop_instance_id` 是手机缓存命名空间**。所有实体缓存的业务身份 = `(desktop_instance_id, desktop_entity_id)`。
2. **`content_hash` 禁止作为业务主键**。只用于文件完整性、去重辅助、下载校验（同一文件在 Desktop 上可能有不同业务关系）。
3. **禁止把 Desktop 绝对路径（如 `C:\...`）作为 Mobile 可消费业务字段**。文件一律通过 Gateway resource endpoint 按需获取。
4. **WS 只是实时提示，durable sync changelog 才是真相**。Mobile 不依赖 WS 保证数据不丢。
5. **`opId` 是 Capture 幂等键**。Desktop 必须按 `opId` 去重。
6. **Note 修改必须携带 `expectedRevision`**；冲突返回 `409 REVISION_CONFLICT`。

## 错误码兼容规则（M2.4 澄清）

失败响应 JSON 的 `code` 是 Protocol V1 的权威错误码。一个条件只能有一个
规范 `code`：

- 笔记 revision 冲突：`REVISION_CONFLICT`（HTTP 409）
- durable cursor 过期：`CURSOR_TOO_OLD`（HTTP 410，Mobile 从 cursor 0 做 full
  resync，**不得清空 capture outbox**）

为兼容已验证的 M2 Mock Gateway 和早期 fixture，Mobile 接收端还会归一化以下
**receive-only legacy aliases**，但新的 Gateway 不得把它们写入错误响应的
`code`：

- `NOTE_REVISION_CONFLICT` → `REVISION_CONFLICT`
- `RESYNC_REQUIRED` → `CURSOR_TOO_OLD`（旧 Mock 曾将其作为
  `X-LuckyRay-Code` header 的恢复提示；它不是第二个 Protocol V1 错误码）

## 目录

```
protocol-v1/
  README.md            本文件
  schemas/             JSON Schema（权威，机器可校验）
  typescript/          TypeScript 类型（与 schemas 同步）
  fixtures/            契约 fixture（测试与示例用）
```

## 同步模型（durable sync）

```
sync_sequence: 单调递增整数（服务端持久化）
SyncChange { seq, entityType, entityId, operation: upsert|delete, revision?, updatedAt }

Mobile 流程:
  GET /v1/sync/changes?after=<cursor>&limit=200
  → changes seq=cursor+1 .. +200
  → SQLite 单事务 apply
  → commit sync_cursor = 最大 seq（per desktop_instance_id）

删除必须以 tombstone/change event 形式出现（不能只消失）。
```

## 版本与兼容

- `protocolVersion: 1`
- 未知字段必须忽略（forward compatible）；缺必填字段必须报错
- 新 Desktop 实例（新 `instanceId`）必须重新 pairing；pin rotation 策略待 V1.1

## 传输认证（M2.4 安全澄清）

- 除 `GET /v1/hello` 与 `POST /v1/pair` 外，所有受保护的 HTTPS 请求和
  WSS upgrade 都必须使用 `Authorization: Bearer <device credential>`。
- `WS /v1/events` 的 URL 只能标识 endpoint；**不得**在 query/path 中传递
  device credential（例如 `?token=`）。这样凭据不会进入 URL 日志、历史记录或
  中间层 telemetry。
- 此澄清不改变 Protocol V1 endpoint、配对或 TLS fingerprint pinning 语义。

## 端点草案（Gateway 必须实现的子集）

| Method | Path | 说明 |
|---|---|---|
| GET | `/v1/hello` | DesktopIdentity |
| POST | `/v1/pair` | 一次性 secret 换 device credential |
| GET | `/v1/sync/changes?after=&limit=` | durable changelog |
| GET | `/v1/assets?page=&limit=&kind=&q=` | 分页素材列表 |
| GET | `/v1/assets/:id` | 素材详情 |
| GET | `/v1/assets/:id/thumbnail` | 缩略图（resource） |
| GET | `/v1/assets/:id/file` | 原文件（resource，按需下载） |
| GET | `/v1/notes` | 笔记列表 |
| GET | `/v1/notes/:id` | 笔记文档（含 revision） |
| PATCH | `/v1/notes/:id` | 更新（必带 expectedRevision）→ 409 REVISION_CONFLICT |
| POST | `/v1/capture` | CaptureOperation（opId 幂等） |
| GET | `/v1/ai/runs` | run 列表 |
| GET | `/v1/ai/turns/:id/events?after=` | turn 事件流（增量） |
| POST | `/v1/ai/turns/:id/stop` | stop / cancel |
| WS | `/v1/events` | 实时提示（非权威；WSS upgrade 使用 Authorization header） |
