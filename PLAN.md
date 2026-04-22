# claw-farm (claw-farm-fork) 实现计划：MVP 阶段一

**生成时间:** 2026-04-22
**状态:** 准备执行
**来源:** HANDOFF-START-HERE.md + bridge-contract.md

---

## 执行摘要

本计划覆盖 `claw-farm-fork` (OpenClaw 执行层) 的首个开发阶段。重点领域：

1. **Bridge Contract 实现** - 标准化操作响应
2. **Workspace Layout** - 统一实例目录结构
3. **Export/Import** - 备份 bundle 生成与恢复
4. **Sidecar Attach Points** - Provider 配置挂载点

**核心原则:** claw-farm 是执行层，不是业务逻辑层。保持平台业务规则（计费、权益、用户管理）在 claw-bay-api。

---

## Wave 1: Bridge Contract 标准化

### 任务 1.1: CF-BRIDGE-001 - Bridge Contract 实现

**目标:** 按 contract 规范实现所有 bridge 操作含标准化响应格式。

**上下文:**
- 仓库: claw-farm (OpenClaw fork)
- Bridge 是 claw-bay-api 与 runtime 之间的接口
- 所有操作必须返回标准化 JSON 响应
- MVP 仅支持 OpenClaw 运行时类型

**输入:**
- `docs/contracts/bridge-contract.md` (完整 contract 规范)
- 当前 `src/` 结构
- `src/commands/` 中现有 commands

**必需变更:**
1. 在 `src/lib/bridge-response.ts` 创建统一响应构建器:
   ```typescript
   interface BridgeResponse {
     ok: boolean;
     action: string;
     runtimeState?: RuntimeState;
     message: string;
     observedAt: string;
     runtimeInstanceKey?: string;
     runtimeWorkspaceSlug?: string;
     errorCode?: string;
     retryable?: boolean;
     metadata?: Record<string, unknown>;
   }
   ```
2. 实现 `instance.create` bridge 命令:
   - 输入: `{project, userId, displayName, autoStart}`
   - 生成 `runtimeInstanceKey` 和 `runtimeWorkspaceSlug`
   - 创建 workspace 目录结构
   - 返回标准化响应
3. 实现 `instance.start` bridge 命令
4. 实现 `instance.stop` bridge 命令
5. 实现 `instance.restart` bridge 命令
6. 实现 `instance.delete` bridge 命令:
   - 清理 workspace 目录
   - 清理 compose projects
7. 实现 `instance.sync` bridge 命令:
   - 检查运行时状态
   - 返回当前 compose 状态
8. 定义错误码:
   - `adapter-unavailable`
   - `runtime-missing`
   - `runtime-conflict`
   - `runtime-command-failed`
   - `unknown`

**验收标准:**
- 所有操作返回符合 contract 的 JSON
- 错误响应有 `errorCode` 和 `retryable`
- 成功响应有 `runtimeState` 和 `runtimeInstanceKey`
- 响应格式通过 TypeScript 类型验证
- 所有操作可通过 CLI 调用

**非目标:**
- 无 Hermes 运行时支持
- 无多节点放置
- 无平台计费/权益逻辑

---

## Wave 2: Workspace Layout 标准化

### 任务 2.1: CF-WORKSPACE-001 - Workspace Layout

**目标:** 按 contract 标准化实例 workspace 目录结构。

**上下文:**
- 每个实例有专用 workspace 目录
- Layout 必须一致以支持 backup/export
- MVP layout: `config/, skills/, sessions/, runtime/, cache/, tmp/`

**输入:**
- `docs/architecture/mvp-detailed-design.md` (Section 7.1)
- `docs/architecture/data-architecture.md` (Section 7)
- `docs/contracts/backup-bundle-contract.md` (包含/排除路径)

**必需变更:**
1. 定义 workspace root path 配置
2. 在 `src/lib/workspace-layout.ts` 创建 workspace layout creator:
   ```
   {runtimeInstancesRoot}/{runtimeWorkspaceSlug}/
     config/
     skills/
     sessions/
     runtime/
     cache/
     tmp/
   ```
3. 确保 `instance.create` 创建完整 layout
4. 确保 `instance.delete` 清理所有目录
5. 添加 workspace 验证函数
6. 在 `docs/workspace-layout.md` 文档化 layout

**验收标准:**
- 每个实例有标准化 workspace
- create 后所有目录存在
- delete 后所有目录清理
- Layout 匹配 backup contract 预期

---

## Wave 3: Export/Import 实现

### 任务 3.1: CF-EXPORT-001 - 实例导出

**目标:** 实现 `instance.export` bridge 操作用于备份 bundle 创建。

**上下文:**
- Export 创建备份 bundle 用于 RustFS 上传
- MVP: 仅全量导出
- 输出: `instance.tar.zst`, `manifest.json`, `sha256.txt`

**输入:**
- `docs/contracts/bridge-contract.md` (Section 6.7)
- `docs/contracts/backup-bundle-contract.md` (完整 contract)
- `docs/architecture/data-architecture.md` (Section 7)

**必需变更:**
1. 创建 `src/commands/export.ts`:
   - 输入: `{project, userId, runtimeWorkspaceSlug, exportRoot, includedPaths, excludedPaths, bundleFormat}`
   - 在 `exportRoot` 下创建临时导出目录
   - 复制包含路径 (config, skills, sessions, runtime metadata)
   - 跳过排除路径 (cache, tmp)
   - 创建含必需字段的 `manifest.json`
   - 创建 `tar.zst` 归档
   - 生成 `sha256.txt` checksum
2. 创建 manifest generator:
   ```json
   {
     "manifestVersion": "1",
     "backupId": "...",
     "instanceId": "...",
     "userId": "...",
     "runtimeType": "openclaw",
     "workspaceSlug": "...",
     "createdAt": "ISO8601",
     "fileCount": number,
     "sizeBytes": number,
     "checksum": "sha256:...",
     "includedPaths": ["config", "skills", "sessions"],
     "excludedPaths": ["cache", "tmp"]
   }
   ```
3. 使用 Node.js crypto 创建 checksum generator
4. 创建 tar.zst compressor (使用 `tar` + `zstd` 或 JS library)
5. 按 bridge contract 返回响应:
   ```json
   {
     "ok": true,
     "action": "export",
     "bundlePath": "...",
     "manifestPath": "...",
     "checksumPath": "...",
     "fileCount": 128,
     "sizeBytes": 10485760,
     "bundleChecksum": "sha256:..."
   }
   ```

**验收标准:**
- Export 创建所有三个文件 (bundle, manifest, checksum)
- Manifest 包含所有必需字段
- Checksum 匹配实际 bundle
- Manifest 中无宿主机绝对路径
- Bundle 中无排除目录
- 响应匹配 bridge contract

---

### 任务 3.2: CF-IMPORT-001 - 实例导入

**目标:** 实现 `instance.import` bridge 操作用于备份恢复。

**上下文:**
- Import 从备份 bundle 恢复实例
- 恢复前必须验证 bundle
- 支持实例间迁移

**输入:**
- `docs/contracts/bridge-contract.md` (Section 6.8)
- `docs/contracts/backup-bundle-contract.md` (验证规则)

**必需变更:**
1. 创建 `src/commands/import.ts`:
   - 输入: `{project, userId, runtimeWorkspaceSlug, bundlePath, manifestPath}`
2. 创建 bundle validator:
   - 读取并解析 manifest
   - 验证 `manifestVersion` 为 "1"
   - 验证 checksum 匹配 bundle
   - 验证 `runtimeType` 为 "openclaw" (MVP)
3. 创建 directory restorer:
   - 将 tar.zst 解压到目标 workspace
   - 保持目录结构
   - 处理冲突 (覆盖或合并)
4. 创建 rollback handler:
   - 失败时尽可能恢复之前状态
   - 记录失败原因
5. 按 bridge contract 返回响应:
   ```json
   {
     "ok": true,
     "action": "import",
     "restoredFileCount": 128,
     "bundleChecksum": "sha256:...",
     "rebuildRequired": false
   }
   ```

**验收标准:**
- Import 恢复前验证 manifest
- Import 恢复所有包含路径
- Import 优雅处理缺失/损坏 bundle
- 失败响应包含失败原因
- 响应匹配 bridge contract

---

## Wave 4: Sidecar Attach Points

### 任务 4.1: CF-SIDECAR-001 - Sidecar Attach Points

**目标:** 为 sidecar providers 创建配置挂载点。

**上下文:**
- Sidecar providers 需要配置访问
- MVP: 微信 (weixin) provider
- Attach point 应为标准化位置

**输入:**
- `docs/contracts/provider-sidecar-contract.md`
- Provider runtime 需求

**必需变更:**
1. 定义 workspace 中 sidecar config 位置:
   - `{workspace}/runtime/sidecar-{provider}/`
   - 示例: `{workspace}/runtime/sidecar-weixin/`
2. 在 `src/lib/sidecar-attach.ts` 创建 sidecar attach helper:
   - 生成 config mount path
   - 生成 health endpoint URL template
   - 生成 runtime handle identifier
3. 确保 compose templates 支持 sidecar volume mounts
4. 文档化 attach point 约定

**验收标准:**
- Sidecar config 位置标准化
- Provider 可通过 attach point 访问实例配置
- Health endpoint template 定义
- Runtime handle 遵循命名约定

---

## Wave 5: 测试与文档

### 任务 5.1: Bridge Test Fixtures

**目标:** 为所有 bridge 操作创建测试 fixtures。

**必需变更:**
1. 创建 `tests/fixtures/` 目录
2. 为每个操作创建成功 fixtures
3. 为每个错误码创建失败 fixtures
4. 确保 fixtures 可被 claw-bay-api adapter tests 重用

**验收标准:**
- 每个操作有成功 fixture
- 每个错误码有失败 fixture
- Fixtures 匹配 contract 响应格式

---

### 任务 5.2: 文档更新

**目标:** 文档化 bridge 实现和 workspace 约定。

**必需变更:**
1. 更新 `README.md` 含:
   - Bridge 操作列表
   - CLI 使用示例
   - 配置需求
2. 创建 `docs/workspace-layout.md`
3. 创建 `docs/bridge-operations.md` 含:
   - 每个操作的输入/输出
   - 错误码和处理
   - Retry 建议

**验收标准:**
- 所有操作文档化
- Workspace layout 文档化
- 错误处理指导存在

---

## 执行优先级

**顺序:**
1. Wave 1 (Bridge) - 所有操作的基础
2. Wave 2 (Workspace) - export/import 前必需
3. Wave 3 (Export/Import) - 核心备份功能
4. Wave 4 (Sidecar) - Provider 集成
5. Wave 5 (Testing/Docs) - 最后阶段

**依赖关系:**
- Export 需要 workspace layout
- Import 需要 export 验证逻辑
- Sidecar attach 需要 workspace 结构

---

## 与 claw-bay-api 集成

**Bridge 调用流程:**
```
claw-bay-api -> ClawFarmBridgeAdapter -> CLI invocation -> Response JSON -> API mapping
```

**claw-bay-api 所需配置:**
- `CLAW_FARM_REPO_ROOT` - claw-farm 仓库路径
- `CLAW_FARM_PROJECT` - 项目名称 (如 "clawbay-prod")
- `RUNTIME_INSTANCES_ROOT` - workspace root 路径

---

## 验证检查清单

阶段完成前验证:

- [ ] `instance.create` 返回有效响应
- [ ] `instance.start/stop/restart/delete/sync` 通过 CLI 工作
- [ ] Workspace layout 正确创建
- [ ] Export 生成 bundle + manifest + checksum
- [ ] Import 验证并恢复 bundle
- [ ] Sidecar attach point 位置定义
- [ ] 所有 fixtures 创建
- [ ] 文档更新

---

## 注意事项

- 保持与上游 OpenClaw 的最小变更
- 所有平台特定代码应在 adapter/wrapper 文件中
- 不要嵌入计费、用户管理或权益逻辑
- Bridge 应可通过 CLI 和未来可能的 HTTP mode 调用
- 响应中所有文件路径应为相对路径或通过 env 可配置