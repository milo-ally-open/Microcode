# Model Integration and Harness-Agnostic Gateway Specification

- Status: Direct Microcode integration remains available; the standalone gateway and default TUI RPC routing are implemented in an initial form. Protocol limitations and harness certification gates below remain in effect.
- Updated: 2026-09-30
- Scope: (I) Microcode's direct, in-process integration with pi-ai/pi-agent-core, including model discovery, credentials, and context handling; (II) a harness-independent gateway that exposes the same model ecosystem to Microcode and external harnesses.
- Current dependency baseline: `@earendil-works/pi-ai@0.87.1` and `@earendil-works/pi-agent-core@0.87.1`. The checked-in `package.json` and `bun.lock` are authoritative.
- Repository guidance: follow [AGENTS.md](../../AGENTS.md) for repository-wide working agreements. This document defines the model integration and gateway product/acceptance contract.

## Purpose and structure

Microcode should benefit from Pi's broad and evolving provider ecosystem without copying provider catalogs, authentication flows, or API implementations. There are two related but distinct integration modes:

1. **Direct Microcode integration**: Microcode's own Agent/TUI uses the pinned Pi runtime in-process. This is the existing integration path and must remain intact; `microcode --no-daemon` continues to use it without routing through the gateway.
2. **Harness-independent Model Gateway**: a separately running local API service uses the same Pi model runtime and credentials, and exposes standard wire protocols to Microcode or other harnesses. It provides model inference only; it is not an Agent harness.

Part II builds on the provider/model/auth foundation in Part I, but is additive: gateway implementation belongs under `src/daemon/` and must not rewrite or replace the existing direct Pi integration. If default startup later routes the Microcode TUI through the daemon, that is a transport selection at the boundary; `--no-daemon` preserves the existing in-process path and the model/provider/auth behavior remains equivalent. External harnesses retain their own tools, permissions, prompts, context strategy, approvals, and session lifecycle. Support for a provider through pi-ai does not by itself establish compatibility with every gateway protocol or harness.

# Part I — Direct model integration in Microcode

## 1. Goals and upstream update principle

Microcode uses Pi-provided Provider implementations, model catalogs, API adapters, and authentication wherever practical; it should not maintain parallel vendor protocol implementations. Providers frequently add models and alter context windows, capabilities, and authentication, so the project should track Pi releases and ship reviewed updates promptly.

“Up to date” means monitor upstream, assess compatible releases, and deliver changes through dependency upgrades, tests, builds, and releases. It does **not** mean downloading catalogs or code at runtime or silently switching users to unreviewed upstream behavior. A released Microcode binary uses its pinned and bundled dependencies.

The exact installed/pinned package is runtime truth. Live documentation and moving source links are discovery references only. If Pi lacks a provider or capability, prefer contributing a generic implementation upstream instead of copying the provider into Microcode. Never edit dependency source or fetch unpinned implementation/catalog data at runtime.

## 2. Current architecture and ownership

- `src/models/registry.ts` uses `builtinModels()` to construct the shared Pi `Models` collection and injects Microcode's `EncryptedCredentialStore`.
- `src/models/authChoices.ts` builds login choices from provider auth descriptors rather than a per-vendor UI list.
- `src/tui/app.ts` uses Pi model APIs for login, auth checks, and logout; Pi providers own OAuth, refresh, credential conversion, and request authentication.
- `src/entry.ts` calls `registerBunOAuthFlows()` so OAuth loaders are available in a Bun standalone executable.
- `src/models/EncryptedCredentialStore.ts` implements Pi's credential-store interface with encrypted persistence. Microcode must not add a parallel OAuth token file or vendor-specific credential cache.
- `src/models/custom.ts` supports user-defined API-compatible models. Custom models currently use API keys and must not execute arbitrary OAuth callback code.

Authentication belongs to a Provider, not each individual model. Model metadata and authentication mechanisms are separate concerns. Do not create vendor-specific Microcode OAuth modules unless Pi demonstrably cannot support a required, permitted behavior.

## 3. Provider and authentication discovery

The following is a snapshot of the locked `pi-ai@0.87.1` catalog, not a permanent allowlist. It must be checked against `builtinProviders()` and the actual registered model collection; tests and runtime discovery must not hard-code this list as the way to discover providers.

| Provider ID | Current authentication descriptor | Notes |
|---|---|---|
| `anthropic` | API key + subscription OAuth | Pi provides Claude Pro/Max OAuth. |
| `openai-codex` | Subscription OAuth | Pi provides browser and device-code login. |
| `github-copilot` | API key/token + subscription OAuth | Pi manages OAuth and model availability. |
| `kimi-coding` | API key + subscription OAuth | Pi provides Kimi Code device authorization. |
| `xai` | API key + subscription OAuth | Pi labels OAuth as SuperGrok/X Premium. |
| `meta` | API key + subscription OAuth | Pi labels OAuth as Muse subscription. |
| `openrouter` | API key + non-subscription OAuth | Account linking/API-key retrieval, not consumer subscription login. |
| `radius` | API key + non-subscription OAuth | Gateway account authentication, not model-vendor subscription. |

Other API-key providers in this snapshot: `amazon-bedrock`, `ant-ling`, `azure-openai-responses`, `baseten`, `cerebras`, `cloudflare-ai-gateway`, `cloudflare-workers-ai`, `deepseek`, `fireworks`, `google`, `google-vertex`, `groq`, `huggingface`, `minimax`, `minimax-cn`, `mistral`, `moonshotai`, `moonshotai-cn`, `nvidia`, `openai`, `opencode`, `opencode-go`, `qwen-token-plan`, `qwen-token-plan-cn`, `qwen-token-plan-individual`, `together`, `vercel-ai-gateway`, `xiaomi`, `xiaomi-token-plan-ams`, `xiaomi-token-plan-cn`, `xiaomi-token-plan-sgp`, `zai`, and `zai-coding-cn`.

If Pi adds an OAuth provider, directory-driven UI should discover it and delegate login to that provider. For cloud identity or another non-interactive auth method, show only the configuration guidance actually supported; do not invent an OAuth flow.

### 3.1 Auth option rules

1. Show OAuth when `provider.auth.oauth` exists. Use `isSubscription` to distinguish subscription authorization from account linking; prefer upstream `loginLabel`/`name` copy.
2. Show interactive API-key login only when `provider.auth.apiKey.login` exists.
3. Do not show OAuth for API-key-only providers or label every OAuth method “browser login” or “subscription login.”
4. Where multiple methods exist, let the user choose; a saved API key must not suppress an explicitly selected OAuth path.
5. Tests should enumerate the exact pinned provider directory and verify discovered OAuth/API-key options, labels, and registered implementations. An upstream directory change should be reflected without maintaining duplicate vendor lists.

Pi containing OAuth code proves technical implementation exists, not that all regions, account tiers, commercial distributions, or third-party clients are permitted. Before shipping subscription OAuth, record policy source, eligible account/region, review date, owner, and release decision. Gate uncertain OAuth; keep vendor-permitted API key or cloud identity paths available.

Do not read another CLI's credential files, browser cookies, device identity, or keychain entries to impersonate it. Do not scrape private APIs or reuse first-party client IDs without permission. The current baseline excludes Google Gemini Code Assist/Gemini CLI consumer OAuth; retain public Gemini API-key and Google Cloud/Vertex routes without importing Gemini CLI tokens.

### 3.2 Login lifecycle and secret handling

- Pass `AbortSignal` through Pi login and user prompts; support provider prompt types such as `select`, `secret`, `text`, and `manual_code`.
- Validate `auth_url` and `device_code` links as HTTP(S). Keep URLs visible/copyable while opening a browser; keep device codes and verification URLs visible during polling.
- Show Pi instructions/progress, but never expose access/refresh/device tokens, authorization codes, or callback query parameters in TUI state, logs, or errors.
- Report success only after `models.login()` and credential persistence both succeed. Opening a browser is not authorization success; device login waits for approval and token exchange.
- On cancellation, abort login, restore prompt/browser-callback resources, and leave no partial credentials. Sanitize errors.
- Ordinary CI must not call vendor OAuth endpoints. Live OAuth smoke tests are manual and use dedicated non-production accounts.

### 3.3 API keys, cloud identity, and plan products

A vendor's Coding Plan offering does not imply OAuth. API-compatible plans still use the vendor's documented key, endpoint, API dialect, and model catalog. Cloud identities and ambient credentials use Pi-supported cloud auth, not a fabricated generic OAuth path.

Alibaba Model Studio's `qwen-token-plan*` providers represent Token Plan endpoints, not Alibaba Coding Plan merely because both are subscriptions. For any later Coding Plan integration, verify the dedicated key, endpoint, API compatibility, model allowlist, and usage restrictions; prefer a Pi upstream provider. Xiaomi regional Token Plan and Z.AI Coding Plan retain their distinct provider IDs, credential environment variables, and endpoints.

Plan-specific keys must not fall back to generic keys, and base URLs must not be silently rewritten to switch billing products. Auth status may show Provider ID, endpoint type, and credential source, never secret contents. Custom models must explicitly configure `contextWindow`; do not infer it from a URL or key.

## 4. Pi dependency update workflow

### 4.1 Discover and assess

1. Review official Pi releases and community change signals; verify compatible `pi-ai`/`pi-agent-core` versions, release notes, and relevant provider/model changes. Community reports are leads, not a runtime support promise.
2. Compare the pinned Provider/model IDs, provider/API identity, `contextWindow`, `maxTokens`, modalities, price metadata, auth descriptors, OAuth loaders, API adapters, callback/device behavior, and agent-core compaction defaults.
3. If a vendor model is missing from Pi, check for upstream work and contribute reusable provider/protocol support to `earendil-works/pi`. Duplicate it in Microcode only with a documented necessity, compatibility plan, and maintenance owner.
4. Price/subscription metadata describes upstream catalog data; it is not a Microcode bill and does not establish a user's subscription quota.

### 4.2 Upgrade and verify

The repository currently pins `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` to the same exact version. Unless Pi release guidance says otherwise, update them together:

```sh
bun add --exact @earendil-works/pi-ai@<version> @earendil-works/pi-agent-core@<version>
```

Update `package.json`, `bun.lock`, affected code, and directory-driven tests. Inspect the exact published package before upgrade; Pi `main` and its README do not replace the installed package as behavioral truth. Run tests, type/build validation, and standalone compilation before packaging/release. A released catalog update reaches users only when they install the new Microcode release.

Suggested validation:

```sh
bun test ./tests
bun run build --no-install
```

The default build may install/replace the generated executable; prefer `--no-install` during validation. Standalone compilation verifies OAuth loader packaging and CLI startup, not a real vendor authorization. Check `git diff --check` and generated artifact state before commit.

Monitoring may run frequently and produce upgrade candidates/PRs; a release still requires locked dependencies, review, tests, and build. Never claim a vendor-announced model is available before the Pi version containing it has been shipped. Release notes should identify provider/model/context/auth changes and limitations.

## 5. Model metadata and context handling

Built-in `contextWindow` values come from model objects in the locked `pi-ai` catalog. Microcode must not maintain a parallel built-in context-window table. Environment overrides such as `BASE_URL` may change endpoint routing, not catalog context size. User/project custom-model configuration (`~/.microcode/config.json` or `.microcode/config.json`) must explicitly define `contextWindow` and pass it unchanged into the model object.

When switching models, update both Agent and `CompactionManager` to the selected model's context window. `src/agent/MicrocodeAgent.ts` provides `transformContext` to pi-agent-core; before model calls it runs `prepareModelContext()` and `compactIfNeeded()`:

1. First clean eligible old tool output while retaining the three most recent results per tool class; this does not call a model.
2. `CompactionManager.isCompactionNeeded()` checks the local token estimate against the current model `contextWindow` and the pinned pi-agent-core default threshold.
3. The current pinned version enables automatic compaction by default with `reserveTokens` of 16,384; estimated usage **greater than** `contextWindow - reserveTokens` triggers it.
4. Microcode estimates messages at roughly one token per four characters and uses a fixed image estimate. This is a safety approximation, not vendor tokenization; the displayed context percentage uses the same estimate.
5. When triggered, summarize earlier conversation with the selected model and retain recent context. `/compact` triggers manually. If model summarization fails, retain a lightweight fallback and continue; the provider can still reject a request that exceeds its true limit.

On Pi upgrades, check model metadata and compaction defaults. Verify model switching changes the threshold source and all calls use the selected model's context window.

## 6. Direct integration acceptance and code map

Acceptance criteria:

- `/model list` comes from the exact pinned Pi catalog; each provider/model appears once and its source is traceable.
- `/login`, `/auth`, and `/logout` match provider auth descriptors, including non-subscription OAuth; API-key-only providers do not show OAuth.
- Subscription OAuth and account-linking labels differ; unreviewed vendor policy is not represented as generally permitted. Google consumer OAuth is not imported.
- API keys, cloud identity, and plan-specific endpoints follow Pi definitions; there is no silent cross-product key fallback or endpoint rewrite.
- Login handles browser URL, device/manual codes, prompts, cancellation, errors, and success timing; Pi owns refresh/request auth and Microcode encrypts credentials. No secrets leak.
- OAuth interaction, refresh, logout, failure, and concurrent credential-store behavior have tests that need no vendor secrets. Real OAuth remains manual.
- Bun standalone build includes the pinned Pi OAuth loaders and the compiled CLI starts; development-mode success alone is insufficient.
- Upstream upgrades include lockfile, tests, build checks, and release notes; users need a new release to receive new catalog data.

Current progress recorded by the source spec: Provider-driven login discovery, coverage of eight OAuth providers in the pinned catalog (six subscription + OpenRouter/Radius two non-subscription), and removal of duplicate Codex auth wrapping are complete. Routine tests and compilation were reported passing. Real vendor login, dedicated end-to-end OAuth verification, and provider-by-provider policy/region/account eligibility review remain open.

Key code entry points:

- `src/models/registry.ts` — Pi catalog, shared model collection, custom providers.
- `src/models/authChoices.ts` — auth options generated from Provider descriptors.
- `src/models/EncryptedCredentialStore.ts` — Pi credential interface and encrypted persistence.
- `src/entry.ts` — Bun standalone OAuth loader registration.
- `src/tui/app.ts` — `/login`, `/logout`, `/auth`, prompts, and browser links.
- `src/models/custom.ts` — user model definitions and explicit context window.
- `src/agent/MicrocodeAgent.ts` and `src/session/CompactionManager.ts` — context transform and auto-compaction.
- `tests/models/authChoices.test.ts` — provider OAuth/API-key discovery.
- `package.json` and `bun.lock` — exact dependency versions.

## 7. Pi live references

Use these moving upstream links to discover changes, then verify every behavior against the exact pinned release:

- [Pi pi-ai README and OAuth design](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md#oauth-providers)
- [Pi built-in provider registry](https://github.com/earendil-works/pi/blob/main/packages/ai/src/providers/all.ts)
- [Pi Bun OAuth loader](https://github.com/earendil-works/pi/blob/main/packages/ai/src/bun-oauth.ts)
- [Pi Kimi Code provider](https://github.com/earendil-works/pi/blob/main/packages/ai/src/providers/kimi-coding.ts)
- [Pi xAI provider](https://github.com/earendil-works/pi/blob/main/packages/ai/src/providers/xai.ts)
- [Gemini CLI authentication](https://github.com/google-gemini/gemini-cli/blob/main/docs/get-started/authentication.mdx) and [third-party service policy](https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/tos-privacy.md)
- [Google Gemini CLI consumer migration announcement](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/)
- [Alibaba Qwen Code](https://help.aliyun.com/zh/model-studio/qwen-code), [Token Plan](https://help.aliyun.com/zh/model-studio/token-plan-team-quickstart), and [Coding Plan FAQ](https://help.aliyun.com/zh/model-studio/coding-plan-faq)
- [Anthropic Claude Pro/Max and Claude Code](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan)
- [OpenAI Codex CLI and ChatGPT plans](https://help.openai.com/en/articles/11381614-api-codex-cli-and-sign-in-with-chatgpt)

# Part II — Harness-independent Model Gateway

## 8. Summary and product contract

Microcode separates model access from any particular Agent harness through a local Model Gateway daemon. The gateway owns the Pi provider/model collection, resolves Microcode upstream credentials, calls the selected provider, and translates between harness-facing wire protocols and Pi's normalized model stream.

The gateway is a **model inference/API compatibility service**, not an Agent runtime. It must not execute client tool calls, inspect client workspaces, apply Microcode system prompts, or own Codex/Claude Code/DeepSeek harness loops. Each harness remains responsible for its context policy, tools, approvals, retries, and session lifecycle.

Startup contract:

| Invocation | Required behavior |
|---|---|
| `microcode` | Ensure the per-user daemon is running, verify public health/model discovery and private RPC protocol with a handshake, then connect the Microcode TUI; leave the daemon available after TUI exit. Reuse one healthy compatible daemon. If startup/handshake fails, print the reason and explicitly fall back to the existing in-process path for this invocation. The listener host resolves as CLI `--gateway-host` > `MICROCODE_GATEWAY_HOST` > user `gateway.host` > `127.0.0.1`; port precedence remains CLI > environment > config > `43127`. |
| `microcode --no-daemon` | Preserve current direct mode: do not start, stop, or connect to the daemon; TUI uses in-process Pi runtime. |
| `microcode gateway status` | Report reachability, daemon/protocol version, and listener address without secrets. |
| `microcode gateway stop` | Gracefully stop the daemon; distinct from `--no-daemon`. |

`--no-daemon` applies only to that invocation and must not stop a daemon used by other clients. A successful default-start handshake prints the protocol version and model count. Startup/handshake failure must be visible and explicitly announce the in-process fallback; never silently switch paths. The explicit `microcode gateway start` command reports failure rather than claiming the gateway is ready.

## 9. Gateway goals and boundaries

Goals:

1. Stable model-access boundary independent of harness.
2. Reuse pinned Pi catalogs, metadata, auth, APIs, normalized events, tool-call parsing, usage/cost, cancellation, and compatibility options where supported.
3. Serve multiple wire protocols through one model runtime.
4. Preserve Microcode TUI/Agent behavior, permissions, compaction, tools, sessions, and output when routed through the daemon.
5. Keep upstream credentials inside the daemon; external clients use a separate Microcode gateway token.
6. Update Pi through reviewed releases, never runtime mutation or unpinned downloads.
7. Make protocol/model feature limitations explicit; harness-neutral architecture does not promise every model/protocol feature combination.

Non-goals and strict boundaries:

- No hosted multi-tenant gateway, public SaaS, billing, or remote account service in the first release.
- Loopback remains the default bind address. Explicit host binding, including `0.0.0.0` or a selected interface address, is supported; hosted multi-tenant service concerns remain outside this implementation phase.
- Never execute model-returned tools. Return function calls to the harness; receive results in later requests.
- Do not expose Microcode Bash/Read/Write/Edit/MCP/permission/task/workspace tools.
- No harness credential scraping, cookie reuse, private client APIs, unauthorized OAuth identity reuse, or provider credential export.
- No dependency fork or edits in `node_modules`. Implement adapters in Microcode and contribute general provider support upstream where appropriate.
- Text-only success is not a compatibility claim; named harness/version requires protocol tests and smoke test.
- No runtime fetching of provider catalogs, API adapters, OAuth code, or capabilities.

## 10. Architecture and runtime separation

```text
Codex ───────── OpenAI Responses adapter ─────┐
Claude Code ─── Anthropic Messages adapter ───┤
Other harness ─ Chat Completions adapter ─────┤
                                              ▼
Microcode TUI ─ versioned local RPC ──> Gateway service/core
                                              │
                                      pi-ai Models collection
                                              │
                       OpenAI / Anthropic / Google / DeepSeek / …

microcode --no-daemon: TUI ──> same pi-ai runtime in-process
```

Layer responsibilities:

1. **Harness protocol adapters** parse/validate one client dialect and serialize responses/events. They are independent of upstream vendor IDs.
2. **Gateway service** authenticates callers, resolves public model IDs, enforces resource limits, maps options/capabilities, propagates cancellation/backpressure, and emits provider-neutral failures.
3. **Model runtime** is a narrow Microcode-owned interface over the pinned Pi collection. It resolves models/auth and invokes generation without HTTP/harness response semantics.
4. **Pi provider layer** owns upstream provider, model catalog, auth, and API implementations; the installed version is the capability source of truth.

The daemon runs as the current OS user, independently of a project working directory and TUI lifetime, launched through an internal command/entry path of the installed executable. TUI-to-daemon traffic uses authenticated, versioned local streaming RPC so no Pi events are lost to a public dialect. Public routes use their protocol contracts.

All new daemon lifecycle, service, internal RPC, and public protocol adapter code belongs under `src/daemon/`. Reuse the existing model catalog, provider auth, credential-store, and Pi integration behavior rather than moving or reimplementing it. Changes outside `src/daemon/` should be limited to necessary CLI/startup wiring and an explicit runtime transport boundary; do not refactor the existing direct path as a prerequisite for gateway work.

## 11. Pi reuse and moving-document policy

- Build the daemon registry from Pi provider factories/catalogs; do not duplicate built-in provider/model ID lists.
- Use Pi model APIs for enumeration, auth resolution/check/login/logout/refresh, and generation. Use `models.stream()` when provider-specific options are needed; use `streamSimple()` only when its normalized options suffice.
- Preserve normalized text, reasoning/thinking (when supplied), tool-call deltas, usage/cost, stop reason, provider errors, and abort events. Adapters translate; they do not reimplement upstream HTTP APIs.
- Use actual registered model metadata for provider/API identity, modalities, reasoning, context, and output limits. Never synthesize unsupported capabilities.
- Resolve upstream credentials through the existing Microcode encrypted credential integration inside the daemon. Never return provider keys, OAuth tokens, auth headers, or raw auth diagnostics.
- Preserve custom models through public Pi provider/API interfaces. Reconcile the current custom-model protocol switch gap without arbitrary code execution or duplicated provider logic.

Keep these live discovery references indexed and revisit them when designing/changing provider integration:

- [pi-ai live README](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md) — providers, catalog, auth, stream/events, custom providers, compatibility options, APIs.
- [pi-ai live source tree](https://github.com/earendil-works/pi/tree/main/packages/ai/src), [provider registry](https://github.com/earendil-works/pi/blob/main/packages/ai/src/providers/all.ts), and [API implementations](https://github.com/earendil-works/pi/tree/main/packages/ai/src/api).

At implementation and on each provider/protocol change, review the live README and relevant source for discovery, then verify all APIs/types against the exact installed dependency. If a useful change is absent from the pinned version, update package and lockfile through review, adapt Microcode, and test/build/package. Keep links current if upstream paths change. Record package version and review date for meaningful API changes. Do not block ordinary application startup on live docs and never fetch moving main/catalog data at runtime. Part I defines the full auth/OAuth and upgrade workflow.

## 12. Normalized gateway request and event semantics

The internal boundary between adapters and runtime is Microcode-owned; public DTOs and raw Pi provider payloads must not leak across it.

Minimum request semantics:

- Public model ID resolving to exactly one registered provider/model pair.
- Ordered system/developer/user/assistant/tool-result messages.
- Text and supported image content; explicit errors for unsupported content.
- Tool declarations, choice, IDs/arguments, and results; tools remain caller-owned.
- Streaming/non-streaming choice and supported common sampling/output limits.
- Supported reasoning, response-format, and optional affinity settings where meaningful.
- Cancellation source linked to client disconnect and explicit cancel; safe request correlation ID.

Minimum normalized events: response/model start; text start/delta/end; reasoning start/delta/end only when upstream supplies it and target protocol supports it; tool-call start/name/ID/partial/final arguments; reported usage/cost; completion/stop reason; failure/abort with valid partial output. Adapters must follow protocol event order. Missing usage/reasoning must be marked unavailable, not fabricated. Reject or explicitly document unsupported requested options instead of silently claiming they were honored.

## 13. Public API and protocol profiles

The listener exposes versioned `/v1` routes. The deterministic default is `127.0.0.1:43127`. Host precedence is `--gateway-host <host>` > `MICROCODE_GATEWAY_HOST` > `gateway.host` in `~/.microcode/config.json` > loopback. Port precedence is `--gateway-port <port>` > `MICROCODE_GATEWAY_PORT` > `gateway.port` in the same config > `43127`. Invalid selected values fail startup; a conflicting live daemon is not stopped or silently replaced, and default TUI startup falls back to direct mode for that invocation. Wildcard bind addresses are translated to a loopback destination for the local TUI client.

| Endpoint | Contract |
|---|---|
| `GET /v1/models` | Stable IDs for models available from this gateway; default ID `provider/model`; optional unique aliases. No credentials or private auth state. |
| `GET /healthz` | Minimal liveness/readiness and protocol version; no credentials, prompts, filesystem paths, or session data. |
| `GET /v1/models/{id}` | Optional only if a tested client requires it. |

Model enumeration reads the running registry and last-known catalogs. Refresh is startup/explicit policy-driven, never a network call on every inference. Availability reflects installed Pi version and user model configuration.

### 13.1 OpenAI Responses — Codex target

- Route: `POST /v1/responses`.
- Accept the documented input/messages, instructions, model, function tools/tool choice, stream, output limits, and compatible options required by the tested Codex client.
- Implement the Responses-shaped object and/or SSE lifecycle required by that client: response, output-item/content-part lifecycle, text deltas/completion, function argument deltas/completion, final response, and relevant errors.
- Compatibility is not inferred from generic OpenAI support. Current official Codex configuration identifies `responses` as the custom-provider wire API. Use the [Codex configuration reference](https://developers.openai.com/codex/config-reference/) and [Responses streaming guide](https://developers.openai.com/api/docs/guides/streaming-responses) as contract references, then verify actual supported client behavior.
- Before claiming support, inspect tested Codex fields, headers, stream, model naming, and response chaining. Store/map response IDs if required; never forward upstream opaque IDs as gateway IDs.
- Responses `function_call` item `id` and `call_id` are distinct: generate a gateway item ID, preserve the call correlation ID, and associate later `function_call_output` input by `call_id`.
- Never expose normalized raw `ThinkingContent` as a Responses `reasoning.summary` by default. Accept `reasoning.summary` values `auto`, `concise`, `detailed`, and `none`; `none` explicitly disables summaries. For positive values, accept only Pi upstream APIs that explicitly support summaries, request that option through Pi's API-specific stream interface, and return the provider-supplied summary only when the client opted in. Reject unsupported summary requests; never return redacted thinking.
- Reject hosted search/computer/file tools unless implemented. Function calls are returned to Codex, never executed by gateway.
- Smoke test a configured Codex client with a text turn and function-tool round trip; keep opt-in where installation/account access is unavailable in CI.

### 13.2 Anthropic Messages — Claude Code target

- Route: `POST /v1/messages` using Anthropic-compatible request/response and streaming event formats.
- Support the exact tested release's model, system/developer content, ordered messages, max tokens, tools/tool choice, streaming, sampling, image blocks, and thinking options.
- For normalized adaptive thinking, preserve Anthropic `display: "summarized"` versus `"omitted"`; omitted mode may return only an empty thinking block and provider signature, never the reasoning text. Reject unsupported display modes and fixed-budget thinking rather than silently changing privacy semantics.
- Serialize message/content-block lifecycle, text/tool-use blocks, partial JSON, usage/stop, errors, and thinking only where upstream and mapping genuinely support them.
- Map gateway client authentication separately from upstream Anthropic credentials. An incoming `x-api-key` must not override or disclose saved credentials.
- Real Claude Code smoke test must verify configurable base URL, auth/version headers, model names, stream, tool loop, and stop/usage behavior.

### 13.3 OpenAI Chat Completions — DeepSeek/general target

- Route: `POST /v1/chat/completions` with standard JSON/SSE chunks and `GET /v1/models`.
- Implement the common chat/tool subset required by the named DeepSeek harnesses and generic compatible clients.
- Pi's ability to call DeepSeek upstream does not prove that DeepSeek clients can call the gateway; ingress and egress protocol compatibility are independent.
- “DeepSeek harness” is not a wire protocol. Identify exact client/version and its dialect/extensions. Use Responses or Chat Completions adapter according to observed client contract.

Each adapter declares supported protocol/version, fields, emitted events, errors, and unsupported-feature behavior. Keep public protocols stable for patch releases; version breaking internal RPC separately. Microcode-specific extensions must be optional/namespaced. Distinguish model availability from per-protocol feature compatibility.

## 14. Tools, sessions, and reasoning

Tool declarations are forwarded via the selected Pi adapter; returned calls are serialized with stable IDs/names/arguments. The client harness runs tools and submits results in later requests. The gateway must not import Microcode's AgentToolManager, permission manager, MCP registry, or filesystem tools for external requests.

Public requests do not enter Microcode TUI sessions or JSONL transcripts by default. Any optional audit trail stores metadata only, never prompt/completion/tool content. Internal TUI RPC may preserve the full normalized Pi stream; public adapters expose only reasoning/content the protocol and upstream truly provide. Chat Completions omits normalized thinking rather than inventing the non-standard `reasoning_content` extension. For Responses, raw normalized thinking is omitted by default; a client may request `reasoning.summary` as `auto`, `concise`, or `detailed`, or explicitly disable it with `none`; positive values require a summary-capable selected Pi API. Never synthesize reasoning summaries or disclose hidden/redacted provider data. Maintain a tested capability matrix for structured output, modalities, reasoning, caching, and tools.

## 15. Authentication, privacy, and security

### 15.1 Client authentication

- Generate a random gateway token using cryptographic randomness. Store it in a per-user Microcode gateway state directory with owner-only permissions (`0600` file, `0700` directory where supported). Never reuse provider credentials.
- Authenticate all inference/model routes. Accept Bearer auth for OpenAI-style clients and protocol-native auth for Anthropic-style clients, mapping both to the same token validation; reject before provider work.
- Provide `microcode gateway token` to retrieve the public client token and `microcode gateway token --rotate` to rotate it explicitly. Rotation is rejected while a known gateway endpoint is running; stop the daemon first so existing clients are not silently invalidated mid-session. Do not print the token on ordinary startup/status or in logs. Redact authorization and provider diagnostics.
- Bind to loopback by default. `--gateway-host`, `MICROCODE_GATEWAY_HOST`, `gateway.host`, and the TUI `/gateway` command may explicitly select another valid IP address or hostname. This adds listener binding only; it does not add TLS termination, remote identity, or multi-tenant controls.

### 15.2 Request isolation and limits

- Bound public API request bodies to 2 MiB and authenticated local TUI model RPC bodies to 32 MiB (the latter may carry the full pre-compaction transcript to the summarizer). Keep JSON depth (64), messages/input entries (500), tool count (128), per-tool schema size (64 KiB), aggregate tool schema size (256 KiB), output tokens (also capped by the selected model), client concurrency (8), upstream request time (10 minutes), and stream-idle time (90 seconds) bounded. Keep defaults conservative and cover overrides with tests.
- Propagate disconnect abort to Pi and release resources. Preserve backpressure; do not buffer unbounded generations.
- Never allow request-controlled upstream URLs, arbitrary headers/auth source, local paths, shell commands, or dynamic imports. Resolve model IDs only from registered catalog/allowlist.
- Default logs omit request bodies, reasoning, tool arguments/results, and generated text. Safe diagnostics may include request ID, dialect, model/provider ID, timings, usage, status, and redacted error class.
- Do not enable CORS without a concrete browser client; if required, allowlist origins and never combine wildcard origin with credentials.

## 16. Daemon lifecycle and private TUI RPC

- Default startup performs an idempotent handshake. Reuse a compatible daemon; otherwise acquire a per-user lock, recheck, launch one detached process, and await readiness with bounded backoff.
- Persist minimal discovery metadata (PID/process identity, endpoint, protocol version). Validate process/health before trusting metadata; handle stale records and port conflicts safely.
- Bootstrap the same Bun OAuth registration and same Pi model/auth registry used by direct mode.
- TUI uses authenticated, versioned local streaming RPC with cancel support. Cover provider/model listing and resolution, auth status/login/logout as designed, generation, titles, compaction, and cancellation. Do not only proxy `streamFn` while hidden direct model calls remain.
- `--no-daemon` chooses the direct runtime before Agent/TUI construction and binds no listener. It is useful for debugging, daemon failure recovery, or users who do not want a resident service.
- TUI `/gateway` opens a bind-address picker for loopback, all IPv4 interfaces, discovered local IPv4 addresses, or direct `/gateway <host>` input. Selecting a different address persists `gateway.host`, restarts the daemon, verifies the handshake, and reconnects the current TUI client.
- Implement `gateway status` and `gateway stop` at minimum. Stop gracefully, abort active streams with stable cancellation result, flush needed credential/catalog writes, then exit. Public token rotation is explicit and only allowed while stopped; restart/log inspection may follow.
- Negotiate internal RPC version. On mismatch, explain and provide a safe restart path; never silently use incompatible schemas. A missing private handshake route is treated as an outdated daemon and suggests `microcode gateway stop` only when no other client is using it; startup itself falls back to direct mode without stopping a shared daemon.

## 17. Daemon-local model adapter

Do not make refactoring the existing direct model call sites a prerequisite for the gateway. Implement the daemon's model adapter/runtime under `src/daemon/`, using the pinned Pi APIs and existing Microcode model/credential integration as appropriate. Keep existing `src/models/` provider discovery, authentication, and direct generation behavior intact. If the TUI's default mode is routed through the daemon, add only the transport selection/client boundary needed for that mode; `--no-daemon` must continue to invoke the pre-existing in-process path.

The daemon needs a narrow interface between its protocol adapters/service and Pi generation. Names below are illustrative, not a requirement to duplicate all Pi types or to migrate the rest of the application to this interface:

```ts
interface ModelRuntime {
  listModels(): Promise<GatewayModelDescriptor[]> | GatewayModelDescriptor[]
  listProviders(): Promise<GatewayProviderDescriptor[]> | GatewayProviderDescriptor[]
  resolveModel(id: string): Promise<GatewayModelDescriptor> | GatewayModelDescriptor
  stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent>
  complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResult>
  getAuthStatus?(): Promise<GatewayAuthStatus[]>
  login?(providerId: string, interaction: AuthInteraction): Promise<void>
  logout?(providerId: string): Promise<void>
}
```

Use Pi types internally where suitable. The daemon/RPC boundary must cover the model operations required by the TUI if default mode uses the daemon, including:

- `MicrocodeAgent` model selection, `CompactionManager` generation, and `streamFn`;
- TUI model list/switch and `/auth`/`/login`/`/logout`;
- title generation and any other `getModels().completeSimple()` call;
- CLI `model list` and startup model selection.

Direct and daemon mode must resolve equivalent models/auth/capabilities and produce semantically equivalent events with a shared fake provider. In daemon mode, no TUI model operation may accidentally bypass the RPC boundary. In `--no-daemon` mode, retain the existing direct call path rather than routing through daemon code.

## 18. Errors, streaming, and resources

- Map provider auth/model/config failures to stable dialect-appropriate errors without secrets or stack traces.
- Distinguish malformed/unsupported request, unauthenticated/unauthorized, unknown model, provider error, rate/concurrency rejection, timeout, and client cancellation.
- For SSE, set headers before first event, flush promptly, preserve event order, and terminate cleanly. Emit final error/completion only where valid for dialect. Abort must not appear successful.
- If provider fails after partial output, preserve it where valid and report failure per protocol. Do not retry non-idempotent or partially delivered generations without proven-safe semantics.
- Record cost/usage only when upstream reports it or Pi supplies an estimate; label actual versus estimated.

## 19. Gateway test and acceptance criteria

### 19.1 Unit and protocol contract

- Request/serializer fixtures per dialect: text, system/developer, images where supported, tools/results, refusal/error, usage, reasoning, malformed and unsupported fields.
- Fake Pi runtime tests model routing, auth isolation, ordered stream events, partial JSON tool args, cancellation, provider errors, usage; CI needs no live keys or vendor calls.
- Prove tools are returned to caller and never executed by Microcode.
- Prove upstream keys/OAuth headers never appear in public responses/logs/model lists.
- Prove `GET /v1/models` uses running registry, is deterministic, reflects a pinned catalog upgrade, and does no per-request network refresh.
- Explicitly test conversion loss; unsupported behavior must error rather than silently drop data.

### 19.2 Daemon and TUI integration

- Concurrent default starts create at most one daemon, wait for readiness, and reuse compatible process.
- Every default TUI startup validates `/healthz`, authenticated `GET /v1/models`, and versioned private RPC handshake; print success details or a clear failure followed by the direct-mode fallback notice.
- `microcode --no-daemon` neither starts nor connects, binds no gateway listener, and passes direct Agent/model tests.
- Model switching, auth commands, titles, compaction, reasoning/tool rendering, and cancellation match direct mode via RPC.
- TUI exit leaves daemon running; `gateway stop` shuts it down and aborts active streams.
- Cover stale PID/endpoint, occupied port, invalid token, daemon crash, RPC-version mismatch, and no-silent-fallback.

### 19.3 Harness compatibility gates

- **Codex**: exact supported CLI/app version against Responses endpoint; text and function-tool round trip including real stream/request headers; implement observed chaining/cancel/events before claiming support.
- **Claude Code**: exact supported release against `/v1/messages`; auth/version headers, streaming, tool loop, model and stop/usage semantics.
- **DeepSeek harness**: name exact client/version and wire protocol; model-provider name is not evidence of harness compatibility.
- Keep smoke tests opt-in when proprietary clients/accounts are unavailable in CI; document tested versions and limitations.

### 19.4 Build and packaging

- Installed executable launches detached daemon and locates user config/credential store independently of project CWD.
- Verify `bun test ./tests`, `bun run build --no-install`, packaging, and daemon start/stop smoke test. Unit tests alone do not prove daemon behavior.
- Do not hand-edit generated output or replace the installed executable during validation.

## 20. Implementation sequence

1. **Additive daemon runtime** — create daemon-local Pi runtime/adapters in `src/daemon/`, reusing existing model catalog, credentials, and auth behavior. Do not migrate/refactor the existing direct integration path; add parity tests.
2. **Daemon and private RPC** — implement single-instance lifecycle, health/version handshake, local authentication, stream/backpressure/cancel, and CLI lifecycle. Add only the transport wiring needed for default-mode TUI RPC; verify `--no-daemon` still uses the existing direct path before public protocols.
3. **Responses adapter** — implement minimum complete profile required by an actual Codex client, fixtures, and manual smoke test.
4. **Anthropic Messages adapter** — implement/test Claude Code profile against selected release.
5. **Chat Completions adapter** — add protocol required by named DeepSeek/OpenAI-compatible harnesses and verify exact client.
6. **Capabilities/update policy** — publish model/protocol compatibility metadata and maintain Pi update/review workflow before stable gateway declaration.

Each phase must be independently testable. Do not begin public protocol compatibility work until runtime seam and daemon RPC parity/cancellation are tested.

## 21. Open implementation decisions

Resolve these in an implementation PR or spec amendment before shipping; do not hide defaults:

1. **Resolved:** default port `43127`; precedence is CLI `--gateway-port` > `MICROCODE_GATEWAY_PORT` > user config `gateway.port` > default. A different live daemon causes a clear conflict; it is never stopped or replaced implicitly.
2. **Resolved:** gateway state is stored under `~/.microcode/daemon/`; `microcode gateway token` retrieves the public token and `microcode gateway token --rotate` replaces it only when the daemon is stopped. Keep it distinct from provider credentials and the private TUI RPC token.
3. Local RPC transport across Linux/macOS/Windows and Bun compiled binaries.
4. First Codex and Claude Code target versions; whether observed clients require persistent response IDs/conversation storage.
5. Exact DeepSeek harness/client and its ingress dialect/extensions.
6. Catalog refresh policy (startup-only, explicit command, or bounded TTL); never refresh for every inference request.
7. Initial request/concurrency limits and whether one shared local token is adequate for a local-only release.

Any decision changing product goals, protocol guarantees, security boundary, or `--no-daemon` semantics must update this specification before implementation is complete.
