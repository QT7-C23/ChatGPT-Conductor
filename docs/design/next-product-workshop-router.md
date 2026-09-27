# ChatGPT Conductor 下一功能版架构 Spec

- Artifact：Architecture Proposal v0.1；本文件为 M0 固化稿，待主 Chat 核验固化忠实度。
- 架构结论：ACCEPT；不等于功能已实现、Release 已发布或实现已获授权。
- 实现基线：`2f0e608a448dd17d0631e823f06e63f889c7b0a9`。
- 基线身份：V1.2.0 candidate / REVIEW，非 stable Release。
- M0 开发分支：`next/product-workshop-router`；从已重新 fetch 核对的 main 创建。
- 核心契约：`schema_version = 2`；下一产品版本号 OPEN。
- 本轮授权：Baseline / Branch / Spec 固化、必要导航、统一 verify；不含功能实现、commit、push、tag、Release 或 M8。

## 1. 来源、效力与状态用语

设计依据为主 Chat「恢复项目基线」（conversation ID `6ab8f3c6-f9d4-83ec-b86f-0506ee8d1e60`）中已接受的 Architecture Proposal，以及本次 M0 明确要求。此次可读取原文包括 Part 4D、ENG-1~5 补充确认和 Part 4E Final Architecture Review（§204–227）；引用接口未返回 Part 1–4C 的独立原文，且无更早分页游标。本文件依最终 ACCEPT 汇总固化，不能声称逐字复制未取得的早期章节。未给出的字段、阈值、算法和存储方案不予补造。

- **CONFIRMED**：架构原则或行为边界已确认，应作为后续实施约束；并不表示已通过实现验证。
- **OPEN**：尚需决定；不能由实现者默认为已批准，也不自动成为本轮 blocker。
- **VALIDATION REQUIRED**：候选方案需真实实验或宿主能力证据，不能宣称最优或已可用。
- 本文件是下一功能版的正式设计入口；既有运行行为及治理合法性仍以当前 contracts、工作流和校验器为准。本文不创建新授权、不修改权威任务状态，也不替代 Execution Packet。

## 2. 产品结构与治理不变量 — CONFIRMED

两个并列核心模块：

| 模块 | 回答的问题 | 职责与输出 |
|---|---|---|
| Product Workshop | 我们究竟应该做什么？ | 模糊需求 → Discovery → 必要调研 → 推荐方案 → Product Brief → 必要时 PRD → PLAN |
| Adaptive Model Router | 当前这一步需要什么能力？ | Task Profile → Capability Tier → Reasoning → Resource Policy → Recommendation → 必要时 Escalation |
| 既有 Conductor | 谁执行、有什么权限、需要什么证据、如何审核和恢复？ | 保留执行者分流、状态机、批准、Challenge、Review、版本与生命周期门禁 |

Adaptive Model Router 的能力路由不替代现有 Chat / Work / Codex 执行者路由。Workshop、Router、Registry、Eval 不取得治理授权权力。

保持唯一七阶段：`DISCUSS`、`PLAN`、`READY_TO_EXECUTE`、`EXECUTE`、`REVIEW`、`REVISE`、`COMPLETE`。

- 主路径：`DISCUSS → PLAN → READY_TO_EXECUTE → EXECUTE → REVIEW → COMPLETE`。
- 修订路径：`REVIEW → REVISE → READY_TO_EXECUTE → EXECUTE → REVIEW`。
- 既有 blocking Challenge → PLAN、reopen、lifecycle、版本与批准绑定规则不变。
- 不增加 WORKSHOP、ROUTING、EVAL 生命周期状态。
- 保持 `schema_version = 2`。新增能力使用独立版本化 Extension Contracts；只有新功能改变治理合法性时才触发 schema 3 review，不能以 extension 偷渡此类变化。
- Recommendation ≠ Decision ≠ Authorization；达到 readiness、推荐模型或完成 Spec 都不意味着允许执行。

规范入口：[状态与事件](../../contracts/routing.json)、[工作流](../../references/workflow.md)、[现行契约](../../references/contracts.md)。

## 3. Product Workshop — CONFIRMED

### 3.1 触发与交互

- AUTO：按任务是否需要发现、澄清决定是否进入 Workshop；清晰的小任务不能被强制变成重型探索流程。
- FORCE：用户可以显式要求 Workshop；BYPASS：用户可以显式跳过 Workshop。跳过发现不跳过现有治理与授权门禁。
- `/workshop` 的显式入口意图已确认，但最终公开命令拼写、子命令和完整 surface 仍由 M1 Command Surface Review 收敛。
- 默认一轮一个关键问题，优先处理会阻止当前决策的未知项。
- Decision Readiness 区分 Blocking Unknown 与 Non-blocking Unknown。影响当前决策的缺口必须显式解决或交回决策；非阻塞未知项随产物保留，不要求无限澄清。
- 达到 readiness 后主动形成初稿，而不是持续提问或等待用户再次要求生成。

### 3.2 Discovery、调研与交付物

- Discovery Ledger 记录发现、尚未解决的问题与决策依据；不能把假设写成已确认事实。
- Research-on-Demand：只有决策需要证据时才调研，不默认对每个小任务进行全面研究。
- Evidence classification 必须区分证据、推断、假设与待确认信息；具体标签与字段在 M1 确定，本文不新增枚举合同。
- 默认交付 Product Brief；复杂度或交接需要时才升级为 PRD，不强迫所有任务产生 PRD。
- Brief/PRD 支撑 PLAN；推荐方案、用户决定、执行授权须保持可区分。
- Decision Readiness 的具体判定规则、Brief/PRD 与 Ledger 的最终字段和持久化强度：OPEN，M1 验证。

## 4. Adaptive Model Router — CONFIRMED

### 4.1 能力、风险与 reasoning

- 能力层级：FAST / BALANCED / STRONG / FRONTIER。Tier 表示能力需求，不绑定永久不变的模型品牌或版本。
- Capability Need 与 Execution Risk 分离：高风险要求相应治理和审核，不足以单独证明需要高能力 Tier。
- reasoning 是独立选择维度；reasoning-first escalation 优先考虑当前模型的 reasoning 调整，再考虑模型升级。它受真实可用能力与授权限制，不代表所有宿主都支持调整。
- Fast Path 让简单、明确的任务以低开销完成路由；Router 本身不能将其变重。
- Routing Checkpoints 在有必要重评的边界作判断；inheritance 复用仍适用的推荐与上下文，避免每步重新分类。具体 checkpoint 清单、继承与失效规则由后续行为验证收敛，不在 M0 凭空设定。
- Progressive Disclosure：先提供足以行动的建议，需要时再解释证据、原因、资源限制和替代方案。
- quota 不可得时标为 unknown；不能凭模型名称或任务重要性猜测额度。

### 4.2 FRONTIER 与执行事实

FRONTIER 不是“重要任务模式”。必须具备能力证据，经 recommend → explain → explicit approval；用户未显式批准时不能切换或消耗 FRONTIER。

必须区分以下事实，任何一项都不能推导后面的项已经发生：

`recommended → approved → available → selected → actually_used`

推荐不能伪装成已切换；批准不能证明可用；选择不能证明实际执行。宿主无切换能力时仍可建议并如实说明能力边界。runtime model switching、reasoning mapping 与 actually_used 的可验证来源均为 VALIDATION REQUIRED。

### 4.3 Failure Attribution

| 类别 | 含义与处置边界 |
|---|---|
| CAPABILITY_LIMIT | 能力限制；唯一直接支持能力升级的失败归因 |
| SPEC_AMBIGUITY | 需求/Spec 不明确；回到必要澄清与规划 |
| MISSING_CONTEXT | 上下文缺失；补足真实输入 |
| TOOL_OR_ENVIRONMENT | 工具、权限或环境问题；通过 preflight 与环境证据定位 |
| TEST_OR_SPEC_CONFLICT | 测试与 Spec 冲突；核对依据并交回决策 |
| UNKNOWN | 尚不能归因；不得假装已有能力不足证据 |

归因与既有 REVISE / PLAN / Workshop / preflight 集成，不新增状态。即便为 CAPABILITY_LIMIT，升级仍须经过资源策略、可用性与批准门禁；工具失败不能推动 FRONTIER 升级。

## 5. Resource Policy — 架构 CONFIRMED，精确默认值 VALIDATION REQUIRED

Resource Modes：`economy`、`balanced`、`quality_first`。解析层次：`User Default → Project Override`，项目覆盖用户默认；两层均不替代当前任务授权。

高级策略包括 `reserve_frontier`、`auto_escalate_reasoning`、`auto_escalate_model`。候选默认值如下，仅供 Routing Eval 验证，不是已验证最优策略，也不是本轮写入的运行配置：

```yaml
resource_mode: balanced
reserve_frontier: true
auto_escalate_reasoning: true
auto_escalate_model: false
```

最终默认值、Mode 对推荐的具体影响、覆盖的字段规则与 ResourcePolicy 存储位置仍需验证/决策。quality_first 或自动升级策略不取消 FRONTIER 显式批准门禁。

## 6. Model Capability Registry — CONFIRMED

独立、版本化、可更新的 Registry，分开记录：

- Provider facts：提供方声明，不能充当本项目评测结论。
- Eval evidence：实际评测证据，保留其适用范围。
- Runtime facts：当前宿主观察到的可用性与能力，不能用静态条目假装实时已验证。

允许 unknown、stale、unavailable；不为填表制造虚假事实。Registry 不按任务刷新。

M6 先建立静态/本地版本化 baseline，支持 evidence、freshness、unknown 与 runtime overlay。`bundled baseline + local update mechanism` 是候选落地方式；精确文件位置、更新机制、freshness/overlay 规则及存储边界为 OPEN，不能在 M0 固化为实现事实。不以实时 MCP refresh 作为前提。

## 7. Routing Eval、DC-1 与 usage UX — CONFIRMED

### 7.1 评测路线

规划采用约 12–20 个历史真实问题，加少量 synthetic boundary cases；具体 eval task set 尚未选定，数量是代表性规划目标，不是机械配额。

- Progressive Eval：逐步验证高价值路由判断，依据已有结果决定后续评测。
- Passive Shadow Eval：利用实际工作中的已有路由与结果证据；默认不为每步增加旁路模型调用。
- FRONTIER sparse sampling：稀疏采样而非全面消耗，仍受能力证据和显式批准约束。
- 禁止默认执行 `tasks × tiers × reasoning × repetitions` 的全矩阵暴力评测。
- synthetic boundary cases 可用于测试；synthetic usage 不可用于冒充实际资源消耗。
- 具体任务、评分方法、采样预算、通过阈值与默认策略效果：OPEN / VALIDATION REQUIRED，M7 收敛。

### 7.2 DC-1 — Orchestration must earn its overhead

优先级：

`existing evidence > deterministic rule > cached recommendation > piggyback reasoning > dedicated model call`

Router/Eval 自身消耗接近或超过它节省的资源时，即使分类正确也算产品目标失败。评测必须考虑编排开销，不能只报告路由准确性；缺乏真实消耗数据时如实保留 unknown，不虚构节省数字。

### 7.3 资源显示

Token / usage 默认隐藏，用户可按需查询或主动开启；真实数据可得时，内部 Eval 可以记录。

禁止猜精确 token、猜 quota、合成 usage、每轮默认展示成本或制造 token 焦虑。无数据不能填 0 冒充实测；候选估计不能冒充 actually_used。

## 8. CR-1 输出完整性 — CONFIRMED

| 要求 | 必须体现的行为 | 验收关注 |
|---|---|---|
| CR-1A Proactive Chunking | 长产物主动分块交付，保留清晰边界 | 避免等截断后才发现未完成 |
| CR-1B Completion Detection | 识别产物是否完整，长产物使用 completion marker | 没有 marker 不能当作完整交付；marker 也不替代内容核验 |
| CR-1C Resume From Last Confirmed Boundary | 从最后确认的边界恢复 | 不凭推测跳过未交付章节，不重做已确认副作用 |
| CR-1D Approval Scope Safety | 批准仅适用于实际交付并确认的范围 | 部分内容的批准不自动覆盖缺失章节、后续内容或扩大执行范围 |

这些要求来自真实截断事件，需独立验收。DeliveryManifestV1 是候选合同；是否持久化及 marker/边界字段细节由 M1 确定，不要求每个短回答创建 manifest 文件。

## 9. 命令与使用体验 — 原则 CONFIRMED，命令表 OPEN

- 自然语言必须能完成主要操作；命令用于显式控制，用户不应背命令。
- 命令 surface 最小化，提供统一 discoverability/help；高级内部功能不必都有公开命令。
- `/workshop`、`/router`、`/router explain`、`/conductor help` 是待 Review 的候选 surface，不是当前已实现的调用说明。
- M1 必须审查最终命令表、统一 help、自然语言等价操作；本文件不新增 CLI 或别名。
- M10 必须提供真正的使用说明与例子：Workshop 何时出现、如何强制/跳过，Tier、Resource Mode、FRONTIER、Router explain、usage 为什么默认隐藏，以及发现入口。

## 10. Skill-first, MCP-ready, not MCP-dependent — CONFIRMED

Skill 继续承担 Workshop、Router policy、governance、Review 与 contracts。没有 MCP 时，新功能仍须能够工作；不能宣称拥有宿主未提供的能力。

未来可选 MCP/Backend 承接实时 availability、quota、Registry refresh、shared state、controlled model switching。概念 adapter boundaries 包括 QuotaProvider、ModelAvailabilityProvider、RegistryProvider、RoutingExecutionAdapter、StateProvider；这些名称不构成现在必须实现的五个模块。

M11 验证核心 Router 无 MCP 依赖，收敛真实需要的可替换边界。未来操作如获取可用模型、quota、Registry update、请求切换，在缺能力时可以是 optional / unsupported。具体接口、运行时 mapping 与自动切换能力均待验证；下一版不以 MCP server 为必交付目标。

## 11. ENG-1~5 工程约束 — CONFIRMED

| ID | 约束 | 实施与验收方向 |
|---|---|---|
| ENG-1 | No Accidental Monoliths | Workshop、Router、Registry、Eval、命令解析、持久化不得挤进一个巨型文件或 Prompt；也不以目录数量证明质量 |
| ENG-2 | Small Stable Interfaces | 通过小而稳定的合同交互，优先组合，不互读其他模块内部状态 |
| ENG-3 | No Premature Abstraction | 不为未来 MCP、多 Provider 或更多 Tier 预建巨大框架；只保留有真实用途的替换边界 |
| ENG-4 | Test by Behavior | 测试行为、合同与拒绝路径，不锁死内部实现；真实边界违规须能被检查指出 |
| ENG-5 | Complexity Budget | 新抽象、合同、命令、持久文件都须说明解决的真实问题；没有收益不增加 |

既有统一入口 `node scripts/verify.mjs` 继续作为验证门禁；后续新增行为测试接入同一入口。真实耦合决定拆分，既避免 everything monolith，也避免几十个无意义的小抽象。具体模块文件布局和复杂度计量不在 M0 锁定。

## 12. Extension Contracts 与 persistence 原则

**CONFIRMED：**采用独立版本化 extension，不因新增产品能力扩写核心治理 schema。以下是接受进入 M1 的候选集合，字段和验证强度尚未定稿：

| 候选合同 | 责任边界 | M1 要解决的问题 |
|---|---|---|
| ProductBriefV1 | Workshop 的产品交接摘要 | 最小字段、与现有 brief 的关系、何时需要文件/校验 |
| DiscoveryLedgerV1 | 发现与未知项的依据 | 哪些记录须跨会话恢复，哪些只需上下文 |
| RoutingRecommendationV1 | 能力/资源推荐 | 与批准及运行事实分离；是否需要机器校验 |
| FailureAttributionV1 | 失败类型与证据 | 升级证据如何约束，何时形成持久记录 |
| ResourcePolicyV1 | Mode、默认与项目覆盖 | 存储位置、覆盖规则、验证强度 |
| ModelCapabilityRegistryV1 | 模型能力事实与证据 | baseline/overlay 存储、更新及 freshness |
| RoutingEvalRecordV1 | 评测结果与编排开销证据 | 真实数据可得性、最小记录、保存范围 |
| DeliveryManifestV1 | 分块、确认边界与完整性 | marker、恢复、批准范围及持久化需求 |

**Contract ≠ mandatory file ≠ mandatory validator ≠ mandatory CLI。**

持久化须由真实交接、恢复、复用或核验证据需求说明收益；不能因为定义了合同就创建文件、validator 与命令全套。哪些 extension 必须机器校验、哪些需要 CLI/persistent files、具体保存路径与读取责任：OPEN，M1 必须明确。不得借新增 extension 改写现有授权、版本、lifecycle 或 Review 规则。

## 13. Acceptance Criteria

### 13.1 M0 验收

| ID | 验收标准 | 核验方法 |
|---|---|---|
| M0-AC1 | 工作根目录严格为 D:\Project\ChatGPT-Conductor；记录 origin、branch、状态、版本 | capability preflight 与真实工具输出 |
| M0-AC2 | 重新 fetch 后 main、origin/main、HEAD 与预期基线一致；变更前工作树干净 | Git 引用与 status；不一致时停止覆盖动作 |
| M0-AC3 | 创建描述性独立开发分支，main 不变，不假定下一版本号 | branch、HEAD 和 main 引用核对 |
| M0-AC4 | 本 Spec 忠实固化 CONFIRMED，并显式保留 OPEN / VALIDATION REQUIRED | 对照最终 ACCEPT 汇总与本次要求逐项审阅 |
| M0-AC5 | 统一 verify 通过，记录总数/通过/失败/退出码和文档对计数的影响 | 执行 node scripts/verify.mjs；历史 391 不能替代当次结果 |
| M0-AC6 | diff 仅为本 Spec 与必要最小导航，无功能、版本、配置变更 | 包括未跟踪文件的 diff/status 检查 |
| M0-AC7 | 无 commit、push、tag、Release、M8；不安装/修改系统工具 | 实际动作记录与 HEAD；结果交主 Chat Review |

### 13.2 下一功能版行为验收（后续里程碑，当前未实施）

| ID | 必须验证的行为 | 归属 |
|---|---|---|
| AC-W | AUTO/FORCE/BYPASS、blocking/non-blocking unknown、readiness 后成稿、Brief 默认/PRD 按需；小任务不过载 | M2 |
| AC-R | Tier 与 risk 分离、reasoning-first、Fast Path、checkpoint/inheritance；推荐与实际执行不混淆 | M3 |
| AC-P | 三种 Mode 与两层覆盖有效；无 FRONTIER 显式批准不得使用；quota unknown 如实保留 | M4 |
| AC-F | 六类失败正确处置；环境/上下文/Spec 失败不直接触发能力升级 | M5 |
| AC-G | Registry 分开 provider/eval/runtime 事实，支持 unknown/stale/unavailable，不按任务刷新 | M6 |
| AC-E | 代表任务、Progressive/Passive Shadow/Sparse Sampling；资源默认值经证据验证，DC-1 不只看准确性 | M7 |
| AC-I | 原有 391 项基线不回归；新能力不绕过 schema 2、七阶段、批准、Challenge、Review、恢复门禁 | M8 |
| AC-C | 长产物中断可检测、从确认边界续传，未完成不冒充交付，批准不越界 | M9 |
| AC-U | 自然语言可完成主要操作、统一 help 可发现；usage 默认隐藏且无 synthetic usage | M4 / M10 |
| AC-M | 缺 MCP 仍可工作；缺真实切换能力时不声称切换成功 | M11 |
| AC-ENG | 稳定小接口、行为及拒绝路径测试、复杂度有理由且无无用抽象 | 各里程碑 |

上述为后续验收目标，不表示已实现或已通过；具体用例与量化阈值待相应里程碑审查。

## 14. M0–M11 implementation decomposition — CONFIRMED planning baseline

| 阶段 | 范围与交付 | verify: 独立验收 |
|---|---|---|
| M0 Baseline / Branch / Release Strategy | 核对 candidate baseline、隔离下一版分支、固化 Spec 与发布开放项 | 本轮 M0-AC1~7；不把发布策略待定伪装为已发布 |
| M1 Contract & UX Spike | 重点检验 ProductBriefV1、RoutingRecommendationV1、ResourcePolicyV1、DeliveryManifestV1；收敛全部候选合同、help/命令、持久化强度 | 每个新增 validator/CLI/file 都有真实必要性；明确剩余开放项 |
| M2 Product Workshop | AUTO/FORCE/BYPASS、readiness、Ledger、按需研究、Brief/PRD | AC-W；小任务不变重 |
| M3 Router Core | Profile、能力/风险、四 Tier、reasoning-first、Fast Path、继承与 checkpoint | AC-R；不依赖 MCP |
| M4 Resource Policy / FRONTIER | 三种 Mode、两层覆盖、高级策略、显式批准、安静的资源 UX | AC-P / AC-U；默认值待 M7 验证 |
| M5 Failure Attribution | 六类归因与现有修订、规划、发现、preflight 集成 | AC-F；只有能力限制直接支持升级 |
| M6 Registry | 静态/本地版本化 baseline、证据、freshness、unknown、runtime overlay | AC-G；不做实时 MCP refresh 前置依赖 |
| M7 Routing Eval | 代表任务与边界用例、渐进评测、被动采集、overhead、FRONTIER 稀疏采样 | AC-E / DC-1；结论限于真实证据 |
| M8 Integration Regression | 接入 DISCUSS、PLAN、Execution Packet、capability preflight、REVIEW、REVISE、COMPLETE | AC-I；原基线不回归 |
| M9 Output Completeness | CR-1A~D、必要 manifest、marker、断点恢复、批准范围 | AC-C；可提前实施，但独立验收 |
| M10 Documentation | 使用说明、例子、自然语言操作和统一发现入口 | AC-U；不能只提供合同文本 |
| M11 MCP Readiness | 检查核心不依赖 MCP，明确必要 adapter boundaries | AC-M；无需默认实现 MCP server |

实际顺序可按真实依赖合并，但不跳过独立验收。M0 Review 后进入 M1；M1 收敛合同与 UX 后再为功能代码形成明确 Execution Packet。本轮完成不自动授权 M1 或 M2–M11。

**M8 消歧：**此表的“下一功能版 M8 Integration Regression”与 V1.2.0 candidate 尚待完成的“发布/分发 M8 live integration”是不同上下文，编号相同不代表同一验收；本轮二者均不执行。统一 verify 的既有本地测试不等于运行发布 M8。

## 15. Risks、Open Decisions 与当前 blockers

| ID | 状态 / 责任阶段 | 待定事项与风险 |
|---|---|---|
| OD-1 | OPEN / M1 + 主 Chat | 最终命令表、拼写与统一 help；避免 command creep |
| OD-2 | OPEN / M1 + 主 Chat | 哪些 extension 需要 validator / CLI / persistent file；避免 contract creep；功能实施前 blocker |
| OD-3 | OPEN / M1、M4、M6 | Registry / ResourcePolicy 存储位置、更新/覆盖边界与责任；不能假设用户目录或项目路径 |
| OD-4 | VALIDATION REQUIRED / M3、M11 | runtime switching、reasoning mapping、实际执行证据；宿主未知能力不当作已具备 |
| OD-5 | OPEN / M7 | 具体 eval task set、评分、采样预算与通过阈值；避免样本偏差与过拟合 |
| OD-6 | VALIDATION REQUIRED / M7 | ResourcePolicy 精确默认值；候选 balanced 等组合未证明最优 |
| OD-7 | OPEN / 主 Chat 与所有者 | 下一版本号；描述性分支不代表版本决定，不改 package.json/CHANGELOG |
| OD-8 | OPEN / 主 Chat 与所有者 | V1.2.0 release lineage：何时完成原发布 M8、是否先发布 candidate、未来整合/发布次序；分支隔离不替代这些决定 |
| OD-9 | OPEN / M1、M9 | DeliveryManifest 与 completion marker 的具体字段及 persistence；避免短输出被过度包装 |

当前无已知产品设计 blocker；原 BLOCKER A 的“独立分支隔离”由本轮 M0 处理，release lineage 仍显式保留 OPEN，不阻止本轮文档固化，也不授予发布权。原 BLOCKER B（Contract Strength）必须在 M1 收敛后才能据此开展相应功能实现。

其他风险：Router/Eval 开销吞噬收益（DC-1）、高风险误判为高能力需求、未知额度被伪造、stale Registry 被当作 runtime facts、部分产物批准扩大为完整授权、MCP 基础设施抢占核心功能工作、过度拆分或巨型模块。通过相应行为验收解决，不在 M0 加入预防性框架。

历史 npm launcher path 异常归类 TOOL_OR_ENVIRONMENT；本轮须重新 preflight，不能由历史通过数推定工具正常，也不能将环境问题用作升级模型的证据。不得擅自安装/修复系统工具。

既有发布门禁与实际远端验证边界参见 [release-process.md](release-process.md)。本 Spec 不认证远端保护、Release 或 attestation 当前状态。

## 16. 非目标与交付边界

- M0 不实现 Workshop、Adaptive Router、Registry、Eval、MCP server、任何新命令、validator 或持久化机制。
- 不修改既有 main、版本号、schema、状态机、功能代码、依赖、锁文件、分发清单、CHANGELOG 或发布配置。
- 不执行 M8、live Release 流程、tag、push；本轮不 commit。仓库规则若要求提交，须先在未提交状态回报并请求授权。
- 下一功能版不要求全矩阵评测、每轮 quota/Registry 查询、usage 常驻 UI 或 MCP-first 平台化。
- 本文件为正式设计入口；源码导航与设计文档保留在 docs/design，不宣称新 Spec 已加入当前 V1.2.0 固定分发包。
- M0 执行结果回主 Chat REVIEW；执行端 succeeded 不等于治理状态 COMPLETE。

## 17. 完整性标记

本文覆盖最终 Review 的已确认设计、明确开放项、验收标准、M0–M11 分解、blockers 与非目标。早期独立原文的可见性限制见 §1；不把未读取章节声称为已逐字复核。

**ARTIFACT COMPLETE — M0 Spec 固化稿；待主 Chat Review。**
