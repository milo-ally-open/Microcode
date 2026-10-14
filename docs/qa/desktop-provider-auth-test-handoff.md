# Desktop 模型与 Provider 接入问题测试交付件

| 项目 | 内容 |
| --- | --- |
| 产品 | Microcode Desktop |
| 交付类型 | 测试工程师问题定位与验证建议 |
| 日期 | 2026-10-14 |
| 当前结论 | OAuth 登录操作存在较长等待且缺少阶段反馈；真实 Provider/API 连通性尚未完成端到端验证 |
| 修复状态 | 按产品要求暂缓模型接入修复 |

## 1. 问题摘要

用户在桌面设置中选择 Provider 登录方式后，界面持续显示“Waiting for sign-in…”，其他认证按钮也会被禁用。OAuth 登录需要系统浏览器完成授权，并等待本机回调或设备码流程结束；当前界面没有显示“正在打开浏览器、等待授权、交换凭据、验证凭据”等阶段，因此等待期间看起来像卡死。

现有源码能够确认登录链路会等待 Provider SDK 的 `login()` 完成，并在结束后再读取设置确认凭据状态。仅凭当前代码和截图，无法确认用户遇到的单次等待具体停在浏览器打开、回调监听、网络令牌交换、凭据保存还是 Provider 端拒绝；这些需要带阶段日志的实际 OAuth 测试才能定论。

## 2. 已确认事实

### 2.1 登录按钮等待整个认证过程

- `src/desktop/renderer/SettingsPanel.tsx:91-99` 在调用 `bridge.loginProvider()` 前设置 pending 状态，直到整个 Promise 完成才清除；`SettingsPanel.tsx:188-190` 将按钮改成“Waiting for sign-in…”并提供取消按钮。
- `src/desktop/DesktopBackend.ts:401-442` 调用并等待 `modelSettings.login()`；登录结束后还会刷新设置，并要求 Provider 报告已配置凭据，否则按失败处理。
- `src/desktop/DesktopBackendHost.ts:138-149` 的桌面 RPC 默认超时为 30 分钟。`src/desktop/authPrompt.ts:6,95-145` 中 Windows 原生认证窗口也有 30 分钟超时。

### 2.2 OAuth 浏览器启动成功不等于授权完成

- `src/desktop/DesktopBackend.ts:424-435` 收到 `auth_url` 后异步打开系统浏览器，同时继续等待 `modelSettings.login()`；设备码则交给原生提示窗口。
- `src/desktop/authPrompt.ts:190-218` 在 Windows 使用 `rundll32.exe` 打开 URL。该 Promise 在启动浏览器进程后就会完成，不代表用户已经登录，也不代表 OAuth 回调已到达。
- 当前实现刻意不把 Provider 的进度文本转发给界面或日志（`DesktopBackend.ts:436`），所以用户无法区分“等待浏览器授权”和“等待令牌交换”等状态。
- 已安装依赖 `@earendil-works/pi-ai` 版本为 `0.87.1`（`package.json:25`、`bun.lock` 对应锁定条目）。该版本的 OpenAI Codex OAuth 使用本机 `localhost:1455` 回调（`node_modules/@earendil-works/pi-ai/dist/auth/oauth/openai-codex.js:26,245-315`）；Anthropic 使用本机 `53692` 回调（`.../anthropic.js:17,73-138`）。授权页完成后，还需要回调成功并由 Provider 流程完成后续令牌处理。

### 2.3 “已配置凭据”与“真实 API 可用”不是同一验证

- `src/desktop/settings.ts:60-75` 的模型切换前置检查只查模型目录和 Provider 的 `checkAuth()` 凭据状态；它没有发出模型 API 请求。
- Agent 真正请求模型是在 `src/agent/MicrocodeAgent.ts:190-191` 调用 `streamSimple()` 时。因此，登录成功或模型切换成功不能单独证明网络连通、账号权限、配额、模型可用性或响应协议正确。
- 凭据写入走 `pi-ai` 的凭据修改流程及 `src/models/EncryptedCredentialStore.ts:80-124,189-235` 的加密凭据文件/系统密钥库路径。测试时不得输出密钥、OAuth code、token 或完整回调 URL。

### 2.4 当前自动化覆盖未验证完整 OAuth 成功链路

- `tests/desktop/backend.test.ts:127-185` 使用模拟 Provider 验证 API key 提示、取消和凭据不泄漏，没有调用真实 OAuth 服务。
- 发布烟测 `src/desktop/main.ts:360-369` 只确认 OpenAI Codex OAuth 能进入等待状态并可取消；它没有完成浏览器授权、接收回调或保存真实 OAuth 凭据。
- `tests/models/authChoices.test.ts:9-38` 检查 OAuth Provider 的认证选项注册与元数据，不验证网络登录或模型 API。

### 2.5 模型切换报错与 OAuth 等待是不同故障点

截图中的 `Invalid payload for switchModel` 是桌面 IPC 模型切换请求载荷校验错误，不足以证明 Provider OAuth 或模型服务不可用。当前工作区已有 `src/desktop/model-selection.ts:1-8`，由 `src/desktop/preload.ts:29` 在 IPC 边界投影出 `id/provider/api` 字段；对应测试位于 `tests/desktop/model-selection.test.ts`。这属于本地已有改动，本次交付不改动认证实现。

## 3. 测试判断与待验证假设

| 观察 | 结论类别 | 说明 |
| --- | --- | --- |
| 点击认证后按钮长时间显示等待 | 源码已确认的行为 | UI 等待整个 SDK 登录 Promise；没有细粒度阶段状态 |
| OAuth 完成浏览器页面后仍等待 | 待现场验证 | 可能是本机回调未到达/端口不可用、令牌交换请求未完成或保存凭据失败；当前截图和源码不能确定是哪一项 |
| API Key、OAuth 等所有认证方式都无法使用 | 未证实 | 现有自动化仅覆盖模拟 API Key 和 OAuth 启动/取消，尚无各 Provider 的真实认证矩阵 |
| 凭据显示已配置但模型请求失败 | 独立待验证 | `checkAuth()` 不执行推理请求；需使用脱敏结果单独验证 Provider API |

## 4. 建议的复测步骤

1. 对每个认证选项单独记录 Provider ID、认证类型、应用版本、操作系统、点击时间和结束方式；记录不得包含密钥、OAuth code/token 或完整授权 URL。
2. OAuth 流程记录四个时间点：点击登录、浏览器启动、浏览器显示完成、桌面确认登录完成/失败。若停留，记录最终是否出现本机回调错误或 30 分钟 RPC 超时。
3. 分别验证回调端口是否可监听、浏览器授权后回调是否到达、令牌交换是否返回、凭据保存后 Provider 状态是否变为 configured。仅收集状态码、耗时和脱敏错误类别。
4. 登录通过后，再对选定模型发送最小化请求，分开记录 HTTP/API 错误类别、首 token 时间和总耗时；不要把登录状态当成 API 连通性结论。
5. 覆盖用户取消、关闭浏览器、授权拒绝、回调端口占用、离线/代理网络、凭据库不可用、重复点击，以及授权完成但 API 请求失败等场景。

## 5. 本轮处置

本轮不修复 Provider 登录或模型 API 逻辑。问题归类为“认证过程阶段不可见，真实 OAuth/API 成功路径覆盖不足”，而不是已证明的单一服务故障。后续若开始修复，建议先为认证流程补充不含敏感信息的阶段状态和可关联诊断事件，再用真实但专用的测试账号验证 OAuth 回调及最小 API 请求。
