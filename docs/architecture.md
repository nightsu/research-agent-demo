# Research Agent 架构说明

本文描述 demo 的运行边界、事件协议和可扩展点。它以当前代码为准，适合配合一次 quick research 请求逐文件阅读。

## 组件与职责

| 组件 | 主要文件 | 职责 |
| --- | --- | --- |
| UI 工作台 | `components/research/research-workbench.tsx` | 发起 / 取消 / 重试研究，并按运行终态组合进度、打印流、报告与来源抽屉 |
| 流客户端 | `components/research/use-research-stream.ts` | POST 请求、任意字节分块解码、事件校验、终态和取消 |
| UI 投影 | `components/research/research-view-model.ts` | 从事件日志去重来源、关联评估、编号引用并派生展示状态 |
| 打印投影 | `components/research/research-printer-model.ts` | 把追加事件日志聚合为计划、搜索批次、缺口、结论与综合记录 |
| 打印视图 | `components/research/research-printer.tsx` | 渲染结构化记录，并管理自动跟随、暂停阅读和来源入口 |
| 来源抽屉 | `components/research/source-drawer.tsx` | 在不离开报告位置的前提下展示来源、评分和采用理由 |
| HTTP / NDJSON 实现 | `lib/server/research-route.ts` | `createResearchRoute()` 实现输入校验、NDJSON 背压、请求 / consumer 取消和唯一终态 |
| Next.js Route 包装 | `app/api/research/route.ts` | 装配生产 model / workflow / Tavily 依赖，只导出 Next.js 允许的 `POST` 与 `maxDuration` |
| 工作流编排 | `lib/agent/research-agent.ts` | 显式 research loop、预算、超时、重试、状态迁移和公开失败 |
| 状态账本 | `lib/agent/research-state.ts` | 合法状态转换、来源 / 评估合并及终态数据 |
| 事件协议 | `lib/agent/research-events.ts` | 类型化可观察事件与一行一个 NDJSON 编解码 |
| 模型边界 | `lib/providers/research-model.ts` | 结构化生成、一次格式修复、来源评估及引用完整性 |
| 提供商选择 | `lib/providers/index.ts` | Kimi / DeepSeek 环境切换与凭据读取 |
| 网络工具 | `lib/tools/tavily.ts` | Tavily Search / Extract 请求、URL 和响应校验、来源 ID |
| Prompt 边界 | `lib/agent/prompts.ts` | 不可信数据包裹、输入截断、证据序列化和阶段指令 |

## 总体架构

```mermaid
flowchart TB
    subgraph Browser[浏览器]
      UI[ResearchWorkbench]
      Hook[useResearchStream]
      VM[deriveResearchViewModel]
      UI --> Hook
      Hook --> VM --> UI
    end

    subgraph Server["Next.js 服务端"]
      Wrapper["app/api/research/route.ts"]
      Factory[createResearchRoute]
      Handler[generated POST handler]
      Agent[runResearch]
      State[reduceResearchState]
      Events[researchEventSchema]
      Model[ResearchModel]
      Provider[Kimi or DeepSeek]
      Tavily[Tavily adapter]

      Wrapper -- production dependencies --> Factory
      Factory -- returns --> Handler
      Wrapper -- exports as POST --> Handler
      Handler --> Agent
      Agent <--> State
      Agent --> Events --> Handler
      Agent --> Model --> Provider
      Agent --> Tavily
    end

    Hook -- POST /api/research --> Handler
    Handler -- typed NDJSON --> Hook
    Provider -- structured generation --> Model
    Tavily -- HTTPS --> Web[("Tavily Search / Extract")]
```

模型与 Tavily 没有直接连线。模型提出计划、评价和跟进查询；只有 `runResearch` 能把经过 schema 和预算约束的数据交给 `searchWeb` / `extractSources`，而凭据只存在于服务端适配器。

## 请求时序

```mermaid
sequenceDiagram
    participant U as User
    participant H as useResearchStream
    participant W as app route module
    participant F as createResearchRoute
    participant R as generated POST handler
    participant A as runResearch
    participant M as ResearchModel / Provider
    participant T as Tavily

    Note over W,R: module initialization
    W->>F: createResearchRoute(production deps)
    F-->>W: POST handler
    Note over U,R: request runtime
    U->>H: submit(question, depth, timeRange)
    H->>R: POST /api/research + AbortSignal
    R->>A: runResearch(input, deps, signal)
    A-->>R: plan.started
    R-->>H: typed NDJSON event
    A->>M: generatePlan()
    M-->>A: ResearchPlan
    A-->>R: plan.completed
    R-->>H: typed NDJSON event
    loop until sufficient or bounded
      A-->>R: search.started
      R-->>H: typed NDJSON event
      A->>T: searchWeb()
      T-->>A: Source[]
      A-->>R: search.completed
      R-->>H: typed NDJSON event
      opt unread sources and budget available
        A->>T: extractSources()
        T-->>A: raw content map
        A-->>R: source.read
        R-->>H: typed NDJSON event
      end
      A->>M: evaluateSources()
      A-->>R: source.evaluated
      R-->>H: typed NDJSON event
      A->>M: assessEvidence()
      A-->>R: conclusion.updated
      R-->>H: typed NDJSON event
      opt evidence gap
        A-->>R: gap.detected + follow-up queries
        R-->>H: typed NDJSON event
      end
    end
    A-->>R: report.started
    R-->>H: typed NDJSON event
    A->>M: generateReport(callbacks)
    loop valid partialOutputStream snapshots
      M-->>A: onPartialReport(partial)
      A-->>R: report.delta
      R-->>H: typed NDJSON event
    end
    M-->>A: onValidating()
    A-->>R: report.validating
    R-->>H: typed NDJSON event
    M->>M: final reportSchema + citation validation
    opt repairable final structured-output error
      M-->>A: onRepairing()
      A-->>R: report.repairing
      R-->>H: typed NDJSON event
      M->>M: one hidden non-streaming repair + validation
    end
    M-->>A: validated ResearchReport
    A-->>R: report.completed or research.partial
    R-->>H: typed NDJSON terminal event
```

图中从 `createResearchRoute()` handler 发出的每个箭头实际上都是 Zod 校验后的一行 NDJSON。`app/api/research/route.ts` 不实现协议，只把生产依赖传给 factory 并暴露 Next.js 允许的 route exports。客户端不能假设网络 chunk 等于一条事件，因此 `useResearchStream` 先用 `TextDecoder` 累积字节，再按换行切分和调用 `decodeEventLine`。

## 真实报告流

最终报告不是“完整 DOM 加一层逐字动画”。它来自 AI SDK 的结构化 partial output：同一次正常模型调用一边产生可阅读草稿，一边在结束时交付必须通过 Zod、来源 ID 和引用完整性校验的正式 `ResearchReport`。

```mermaid
flowchart TB
    Strategy{"ModelCapabilities<br/>structuredOutputs"}
    Native["native branch<br/>Output.object(reportSchema)<br/>json_schema"]
    Prompted["prompted branch<br/>appendJsonContract + Output.json<br/>json_object"]
    Model["one AI SDK streamText call"]
    Partial["partialOutputStream<br/>PartialResearchReport snapshots"]
    Callbacks["provider callbacks<br/>serial await + stream cleanup"]
    Repair["hidden once-only repair<br/>no second visible draft"]
    Projector["reportDraftToMarkdown<br/>append or replace"]
    Agent["Research Agent<br/>delivery ack then sequence++"]
    Route["NDJSON route<br/>schema + desiredSize backpressure"]
    Hook["useResearchStream<br/>ref accumulator + 40 ms flush"]
    Events["run.events<br/>durable low-frequency facts"]
    Draft["run.reportDraft<br/>transient Markdown snapshot"]
    Streamdown["standalone Streamdown<br/>inert links, no images or raw HTML"]
    Workspace["ResearchWorkbench<br/>responsive scroll owner"]
    Formal["ResearchReportView<br/>validated citations"]

    Strategy -->|"true"| Native --> Model
    Strategy -->|"false"| Prompted --> Model
    Model --> Partial --> Callbacks --> Projector --> Agent --> Route --> Hook
    Model -->|"partial stream ends"| Callbacks
    Callbacks -->|"final output validates"| Agent
    Callbacks -->|"repairable structured-output error"| Repair --> Agent
    Hook -->|"stage and terminal events"| Events
    Hook -->|"report.delta only"| Draft --> Streamdown --> Workspace
    Events --> Workspace
    Agent -->|"report.completed or research.partial"| Route
    Workspace -->|"same document flow, no replay"| Formal
```

### 服务端：partial snapshot 到有序 delta

`generateReport()` 消费 `partialOutputStream`，并串行 `await onPartialReport`。这样 provider stream 不会跑在应用背压前面；consumer 中断或回调失败时，迭代器清理也不会被随后读取 final output 的错误覆盖。原生分支让 AI SDK 按完整 `reportSchema` 产生 partial；prompted 分支则先用本地 deep-partial Zod schema 检查每个快照。尚未形成合法字段组合的 partial 会被跳过，而不会变成公开 delta；最终 output 无论来自哪个分支，都必须再通过完整 `reportSchema`。每个合法 partial object 才进入纯函数 `reportDraftToMarkdown()`，只按正式报告顺序投影已经存在的字段和已知引用编号，不补造字段、URL 或来源。

partial structured output 通常只增长，但这不是协议保证。若新 Markdown 以旧值开头，`createReportDraftUpdate()` 只发送后缀 `append`；若模型修订了前文，则发送完整 `replace` snapshot；相同投影不发事件。Agent 只有在 route 确认交付后才递增从 0 开始的 `sequence`，因此客户端遇到重复、跳号或倒序时可以把它当作协议错误，而不是猜测性合并。错误会保留最后一版合法草稿，公开失败信息仍经过安全映射，原始 provider 输出、私有推理和修复提示不会进入 NDJSON。

partial stream 结束后先发 `report.validating`。只有最终结构化输出属于可修复错误时才发 `report.repairing`，并最多进行一次隐藏的非流式修复；第二次尝试不回放 delta，避免清空或反驳用户正在阅读的第一版草稿。鉴权、限流、网络、取消和 callback 错误不伪装成格式修复。修复也失败、网络中断或用户取消时，已有草稿保留为 `incomplete`。

`createResearchRoute()` 继续承担唯一终态与 `ReadableStream.desiredSize` 背压：每个回调必须等上一条 NDJSON 获得容量才能继续。`report.delta` 不是终态；`report.completed`、`research.partial`、`research.cancelled` 或 `research.failed` 仍然只能出现一个。

### 客户端：持久事实与瞬态草稿分离

`run.events` 保存可回放的低频研究事实，包括 `report.started`、`report.validating`、`report.repairing` 和唯一终态。高频 `report.delta` 虽然先经过严格 schema 与 sequence 校验，却只进入 ref 中的 accumulator，不追加到 `run.events`。Hook 立即在 ref 上应用 append / replace，每 40 ms 最多向 React flush 一次；终态、取消和失败先同步 flush，避免最后一批合法文本丢失。新运行、重试和 generation 切换同时清理 ref 与 timer，使旧请求不能污染新草稿。

草稿由独立 `streamdown` 包渲染，不安装 assistant-ui，也不引入 Thread、Message 或额外 Runtime。草稿禁用 raw HTML 插件，把链接渲染成不可点击文本并丢弃图片；它没有 `aria-live`，避免每 40 ms 重读整篇文档。`prefers-reduced-motion` 只关闭 caret 和 entry transition，文本本身仍随真实 delta 增长。正式报告继续由 `ResearchReportView` 渲染，并只让已收集来源的安全引用打开 `SourceDrawer`。

### 滚动所有权与正式替换

桌面宽度大于 960 px 时，`.workspace-content` 是右侧唯一纵向 scroll owner，报告草稿保持 `overflow-y: visible`；表格只允许自身横向滚动。宽度不超过 960 px 时，`.workspace-content` 改为 visible overflow，document / window 成为唯一纵向 owner；固定的“Back to latest report”按钮恢复跟随。跨过 960 px 的 media query 时，Workbench 动态迁移 owner 和 following 状态，而不是让两个容器同时滚动。

`report.started` 第一次进入报告 surface 时定位到报告顶部。之后只有仍在 following 状态的内容增长才贴近底部；用户上滚会暂停自动跟随并保持 `scrollTop`，点击按钮恢复。正式报告替换草稿时不再次滚到顶部、不因为终态单独滚到底部，并通过 `hadReportDraft` 关闭 `report-feed` 入场动画，所以阅读位置与内容不会重复播放。

建议按数据实际经过的顺序学习：

1. `lib/agent/research-events.ts`：公开协议、sequence 和错误边界；
2. `lib/providers/research-model.ts`：`partialOutputStream`、callback、cleanup 与一次隐藏修复；
3. `lib/agent/report-draft.ts`：partial object 如何变成确定性 Markdown 和 append / replace；
4. `lib/agent/research-agent.ts`：callback 如何映射为有序事件；
5. `lib/server/research-route.ts`：NDJSON 背压、取消和唯一终态；
6. `components/research/use-research-stream.ts`：ref accumulator、40 ms batching 与 protocol failure；
7. `components/research/streaming-report-draft.tsx`：独立 Streamdown 的渲染安全；
8. `components/research/research-workbench.tsx`：报告 surface、跟随暂停和响应式 owner 迁移；
9. `components/research/research-report.tsx` 与 `source-drawer.tsx`：正式替换与引用交互。

## 一次搜索迭代如何映射到代码

以计划中的第一个 query 为例：

1. `runResearch()` 从 `pendingQueries` 取出 query，调用 `transition({ type: "search.started" })`；`reduceResearchState()` 设置 `activeQuery`，同时 emit `search.started`。
2. `invoke()` 为本次工具调用增加 1 个 operation，派生带超时的 `AbortSignal`，再调用 `searchWeb()`。
3. `searchWeb()` 校验 query / time range，`request("/search")` 才真正携带 `TAVILY_API_KEY` 发出 HTTPS 请求；响应通过 `tavilySearchResponseSchema`，URL 规范化后生成稳定 source ID。
4. `uniqueSources()` 去除已有 canonical URL，按 `maxResultsPerRound` 截断；`search.completed` 进入状态账本与事件流。
5. 对尚无 `rawContent` 且没尝试过的来源，`extractSources()` 调用 `/extract`；成功内容通过一次或多次 `sources.read` 合并回同一来源，并发出 `source.read`。
6. `createResearchModel().evaluateSources()` 使用 `sourceEvaluationPrompt()`，只接收本轮尚未评估的来源。`validateSourceEvaluations()` 强制每个已知 source ID 恰好有一项评估，未知或重复 ID 会失败。
7. `assessEvidence()` 只接收 accepted evidence。`evidence.assessed` 更新持久工作流状态，`conclusion.updated` 向 UI 输出简短摘要；不足时 `gap.detected` 把去重后的 follow-up query 放回队列头部。

这条路径刻意没有让模型直接调用 `searchWeb`：query 是模型输出，但执行权、次数、凭据、超时和外部响应形状都属于应用。

## 状态与事件为什么不同

`ResearchState` 是服务端编排的最小权威快照：当前 phase、活动 query、累积来源、评估、证据结论、缺口与最终报告。`reduceResearchState()` 拒绝非法迁移，因此模型输出、route handler 和 UI 都不能自行发明状态。

`ResearchEvent` 是面向传输和教学 UI 的追加日志：它保留搜索开始原因、provider 返回数量、逐来源读取 / 评估、结论更新以及 `progress.updated` 的真实 operation / search round 指标。状态不需要保存全部搜索历史或 telemetry，事件也不暴露所有内部字段。两者通过 `transition(action, events)` 在同一编排点关联，但有不同目的：

- state 用于决定下一步并维护不变量；
- event 用于观察、回放和派生 UI；
- 二者都不包含 provider 私有 chain-of-thought。

客户端的 `deriveResearchViewModel()` 不是第二个业务状态机。它只把事件投影为展示所需的来源去重、评估映射、计数、最后一条 metrics 和引用序号。

## 结构化打印流

`derivePrinterRecords()` 与 `deriveResearchViewModel()` 读取同一份追加事件日志，但职责不同：前者保留研究过程的叙事顺序，后者派生页面当前快照。打印投影是纯函数，因此刷新渲染或回放相同事件会得到相同记录；它不能产生服务端没有公开的新结论。

一次搜索的 `search.started`、`search.completed`、`source.read` 和 `source.evaluated` 会按 query 与稳定 source ID 聚合为一个批次。相同 query 可能在后续轮次再次执行，所以完成事件必须反向匹配最近的未完成批次。无法关联的未知 source ID 不会被补造成来源卡片，原事件仍留在日志中供协议测试诊断。

运行时 `ResearchPrinter` 跟随最新批次；用户离开底部阅读历史后，自动滚动暂停，直到用户自行回到底部或点击恢复按钮。完整或部分报告产生后，工作台把报告提升为主内容并折叠过程；失败和取消没有可替代的最终结论，因此保持过程展开。报告引用和打印流来源统一打开 `SourceDrawer`，关闭后把焦点还给原触发元素。

公开打印记录只包括计划、工具行动原因、来源判断、证据缺口和阶段结论，不包括 provider 私有 chain-of-thought。建议按以下顺序阅读代码：

1. `lib/agent/research-events.ts`：协议允许公开哪些事实；
2. `components/research/use-research-stream.ts`：字节流如何变成事件日志；
3. `components/research/research-printer-model.ts`：事件如何聚合成业务记录；
4. `components/research/research-printer.tsx`：打印和滚动跟随如何实现；
5. `components/research/research-workbench.tsx`：不同终态如何改变信息层级；
6. `components/research/source-drawer.tsx`：来源阅读与焦点如何跨区域衔接。

## 操作预算与修复回调

`limits.ts` 同时限制总 operations、搜索轮次、每轮结果、正文读取数和单次超时。operation 不是 UI event 数，而是有成本或风险的外部 / 模型调用：

- 每次 `invoke()` 在调用模型、Search 或 Extract 前计数；
- `invokeModel()` 把 `onModelCall` 传到 provider；一次正常结构化生成占 1 个 operation；
- `generateValidated()` 只在缺少 / 无效结构化输出时允许一次 repair generation；第二次 `onModelCall()` 会再占 1 个 operation；
- 每次 tool operation 完成（成功或失败）、每次 provider call（包括 repair）以及 search round 增加后都会发 `progress.updated`；模型 / 工具原始失败不会被 telemetry 发送失败覆盖；
- 鉴权、限流、传输与取消错误不会触发结构化修复；
- 编排在中间阶段用 `hasBudget()` 预留后续评估、证据判断和最终报告空间。预算不足会停止扩展搜索并尽量生成标明限制的 partial report。

整次 research run 共享一次 recoverable Tavily Search 重试额度，而不是每个 query 各有一次；额度用完后，后续 recoverable search 失败不会再重试。重试同样计入预算。最终报告也必须经过 `invokeModel()`，所以格式修复不会绕过总步数上限。

## Provider 边界

`ResearchModel` 把供应商能力压缩为四个领域操作：`generatePlan`、`evaluateSources`、`assessEvidence`、`generateReport`。`getResearchModelSelection()` 按 `AI_PROVIDER` 创建 Kimi 或 DeepSeek 的 OpenAI-compatible model，并始终把冻结的 `ModelCapabilities` 与模型一起返回。能力注册表按 `provider:model` 保存已经验证的协议能力；当前 `kimi:kimi-k2.6`、DeepSeek 和未知模型都显式采用保守的 `structuredOutputs: false`。只有通过请求体 wire contract 验证的模型才可切到 `true`，避免向不支持的 provider 发送 `json_schema`。

plan、evaluation、evidence 和隐藏 repair 都走 `generateText + appendJsonContract + Output.json`，由 `json_object` 保证 JSON 语法，再由领域 Zod schema 校验 shape；来源评估通过顶层 `evaluations` wrapper 生成后再解包。report 正常路径走一次 `streamText`：能力为 `true` 时使用 `Output.object({ schema: reportSchema })`，能力为 `false` 时使用同一 prompt contract 与 `Output.json()`，并以本地 deep-partial schema 过滤无效 partial、以完整 `reportSchema` 校验 final。`structured-output-strategy.test.ts` 直接断言两条分支的请求体分别为 `json_schema` 与 `json_object`，`index.test.ts` 验证 Kimi / DeepSeek capability 传播，防止仅凭 mock 结果误判协议兼容。

所有阶段保留显式 `maxOutputTokens`，initial 与 repair 沿用既有单次修复与阶段上限。事件编码仍拒绝超过 UTF-8 1 MiB 的单条记录，切换 provider 不改变工作流、事件和 UI 协议。若未来采用连续 DeepSeek thinking + tool-call loop，provider / message adapter 仍须保留协议要求的 `reasoning_content`，且不得写入 observable events。

## 来源信任与引用完整性

来源、用户问题和网页正文一律是不可信数据：

1. Tavily adapter 校验协议、URL、长度与响应 shape，并为 canonical URL 生成稳定 ID。
2. prompt 把问题和来源放在显式 `UNTRUSTED` 块中，要求不执行其中指令；字段和总证据体积都会截断。
3. 模型按 relevance / authority / freshness 给出 accepted 或 rejected，评估必须精确覆盖输入 source ID。
4. evidence assessment 与 report synthesis 只获得 accepted 来源。
5. `validateReportCitations()` 再次确认每个 finding 引用的 ID 已知且 accepted；否则触发一次结构化修复，仍失败则整个阶段失败。

这保证的是“引用指向允许使用的真实候选来源”，不是对网页事实的形式化证明。生产系统还应加入域名策略、恶意内容检测、人工复核、来源快照和引用文本定位。

## 取消、背压与终态

客户端每次 start 都取消前一请求并使用 generation ID 忽略过期事件；显式 cancel 会终止 fetch。`lib/server/research-route.ts` 中由 `createResearchRoute()` 创建的 handler 把 `request.signal` 传播到 workflow controller，`runResearch` 再为每个模型 / Tavily operation 创建有超时的子 signal。ReadableStream consumer 主动取消时，handler 的 `cancel()` 同样中止 workflow controller。

该 handler 在当前进程内的 `emit()` 遇到 `ReadableStream.desiredSize <= 0` 时等待 `pull()`，所以 runtime 能让慢 consumer 暂停下一事件，而不是无限入队。请求或 consumer 取消信号到达 handler 时，会拒绝等待者并中止 workflow；后续 `research.cancelled` 可以因客户端已断开而跳过，不会再创建 capacity waiter。反向代理、平台缓冲和 serverless 生命周期可能改变实际 streaming、断开传播与执行时限；目标部署必须单独验证 streaming、disconnect propagation 和 `maxDuration`。

当前 Demo 没有网关鉴权、用户级 rate limit、并发限制或付费 quota。对公网暴露模型与 Tavily 付费 API 前，必须先在可信网关补齐这些生产控制。本地 2026-07-16 Kimi + Tavily quick 路径已经实测真实草稿增长、最终 `report.completed`、原位正式替换和引用抽屉；DeepSeek、部署 runtime 保证与其他环境仍未验证。

终态只能是 `report.completed`、`research.partial`、`research.cancelled` 或 `research.failed` 之一。`createResearchRoute()` handler 记录首次终态并拒绝后续 emit；若依赖意外结束却没发终态，`ensureTerminal()` 尝试补一个安全的 `research.failed`。客户端同样拒绝终态后的记录和没有终态就结束的流。薄包装 `app/api/research/route.ts` 不复制这些规则。

## 高价值注释说明

代码只在不容易从语法看出的不变量旁保留注释：

- `research-agent.ts` 解释为何不用 `ToolLoopAgent`，以及为何中间阶段要为报告修复预留调用；这是产品 / 教学取舍，不是循环语法说明。
- `research-state.ts` 把 reducer 称为 audit ledger，强调所有层共享同一合法迁移边界。
- `research-events.ts` 说明事件只公开可观察决定，不承载私有思维链。
- `research-model.ts` 说明 schema 的双重边界以及只有结构化输出错误才能修复，避免未来把认证 / 网络失败误重试成模型调用。
- `tavily.ts` 说明模型与 HTTP 的权限边界。
- `use-research-stream.ts` 提醒网络字节 chunk 不是消息边界，并解释清理错误不能覆盖已经确定的公开结果。

这些注释记录“为什么”和安全不变量；函数名、参数或逐行行为能直接读懂的部分不重复注释。

## 从显式工作流扩展到自主循环

保留当前实现适合需要固定阶段、严格审计、稳定 UI 事件和可预测预算的研究产品。若任务转向开放式探索，可新增一个自主 runner，而不是直接删除现有边界：

1. 让 `ResearchModel` 或新的 `ResearchRunner` interface 支持显式与 autonomous 两种实现。
2. 用 AI SDK `ToolLoopAgent` 注册受 schema、超时、预算和 allowlist 约束的 search / extract tools。
3. 将 tool call / result 映射成现有公开事件，继续隐藏私有 reasoning，并由应用发唯一终态。
4. 保留 Tavily adapter、引用校验、取消、背压和公开错误映射；自主不意味着绕过权限边界。
5. 对 DeepSeek thinking loop，在 provider adapter 内正确回放 `reasoning_content`，但不让该字段进入事件或持久化审计日志。
6. 用相同问题对比两种 runner 的来源质量、步数、延迟、失败恢复和可解释 UI，再决定默认模式。

这样自主性是可替换的编排策略，而不是对网络、安全和引用边界的一次性重写。
