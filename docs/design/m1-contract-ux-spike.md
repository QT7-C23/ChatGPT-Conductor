# M1 — Contract & UX Spike

- 状态：执行端设计结论，供主 Chat REVIEW；不是 ACCEPT、功能实现或发布声明。
- 依据：已 ACCEPT 的 [M0 Spec](next-product-workshop-router.md)，以及当前 contracts / Skill / distribution 实现。
- 基线：分支 `next/product-workshop-router`；HEAD / 远端 `abbc7e974f7621bf9247b378afa7239e73f67f1e`；main / origin/main `2f0e608a448dd17d0631e823f06e63f889c7b0a9`。M1 开始时 fetch 和 ls-remote 已核对、工作树干净。
- 范围：收敛合同、存储、集成、命令和复杂度；两个隔离纯函数原型及合同行为实验。没有生产入口、持久写入器、Router scoring、模型调用、服务或新依赖。
- 不变：schema_version=2、七阶段、Recommendation ≠ Decision ≠ Authorization、资源默认隐藏、FRONTIER 显式批准。下一版本号及 V1.2.0 stable lineage 不作决定。

## 1. 当前实现依据与主要结论

| 依据 | 观察 | M1 决策 |
|---|---|---|
| `scripts/contracts.mjs`: validateExecution / packetIdentity / boundaryDigest | Packet 严格拒绝额外字段；完整 Packet 被摘要绑定，inputs / required_capabilities 属于任务边界 | 推荐默认放包外；不得新增 packet.routing 或忽略摘要中的字段来消除修订 |
| `scripts/router.mjs`: transition | request 也拒绝额外字段；prepare / start / preflight 已有版本、授权及能力门禁 | Skill 分别传递治理请求与建议；不把 extension 直接塞入 transition |
| `references/contracts.md`, `references/workflow.md`, `SKILL.md` | 已有决策、修订、失败结果与审核流程 | 新模块不得独立更新治理状态；blocking 冲突回 PLAN |
| `examples/brief.md` | 这是现有合成输入材料，不是 ProductBrief schema | 不重命名、不迁移；新增 Brief 是可选交接产物 |
| `scripts/distribution/product-files.json`, `scripts/package-release.mjs` | 产品包是精确白名单；不是任意目录同步 | 用户配置/本地 Registry/交付记录放在安装目录外；本次不改白名单 |
| `docs/design/distribution.md`, `scripts/distribution/recovery.mjs` | 恢复受精确 inventory、journal、批准及治理冲突约束 | 输出恢复和分发恢复分开；不导入分发 journal 作为 Delivery 状态机 |
| `references/state-backend.md` | 已有未来 StateStore 边界，V1 无后端 | 不再建第二套 StateProvider 或 MCP 框架 |

四个合同需要在未来机器消费入口做正式校验：ResourcePolicy、Registry、RoutingRecommendation、用于自动续传的 DeliveryManifest。其余四个先用轻结构/Markdown；合同不是八个文件、八个 CLI 或八个 validator。

这里“正式”指进入产品时的边界要求，不声称 M1 已提供生产校验器。原型只验证最不确定的覆盖/断点语义，不能接入产品作为完整实现。

## 2. 八个 Extension Contracts：强度、最小内容与持久化

所有 extension 独立标记合同名及版本 1，不改变核心 schema。Markdown 用文首标记；机器对象用 `contract` 与 `version: 1`。建议以接收者需要的字段为限，未知值显式表示；不创建通用 extension registry。

| Extension | 建议强度 / 最小内容 | 持久化触发与载体 | 不加 validator / 持久化会坏什么 |
|---|---|---|---|
| ProductBriefV1 | 轻结构 Markdown：问题/用户、期望结果、范围内外、约束、推荐及理由、未知项及证据、下一步/验收；决定与授权另列真实引用 | 有交接或需要恢复时保存一份 Brief；简单讨论留聊天。复杂产品才扩为 PRD | 不做正式 validator 不会损坏机器边界；机械检查标题不能证明 readiness。跨会话不保存会丢失范围/依据，届时保存即可 |
| DiscoveryLedgerV1 | 轻结构条目：id、statement、classification、source、decision_impact、owner、blocking、resolution。标签 `evidence / inference / assumption / unknown`；inference 指向依据，evidence 不等于已证实 | 默认是 Brief 内一节；只有长调研才独立 Ledger。保留改变决策的条目，不保存逐轮思考 | 无机器 validator 可由人工核对；不保留影响决策的证据和未决项会把假设误当事实。无需每轮日志/单独数据库 |
| RoutingRecommendationV1 | 机器消费/缓存前正式校验；推荐只含绑定、适用依据、tier、reasoning 意图、理由/证据与失效原因；见 §4 | 默认运行时；跨会话继承或 explain/audit 时才在既有交接附件保存不可变版本 | 不校验会误用其他任务/旧版本推荐或把推荐当事实；每步落盘无收益。跨会话没有记录时重建建议，不猜测已批准 |
| FailureAttributionV1 | 轻结构、通常嵌 Result limitations/evidence：失败引用、六类 category、依据、替代解释、建议恢复动作。只能 CAPABILITY_LIMIT 直接支持升级 | 与产生它的失败结果一起保存；没有失败不建文件 | 独立 validator 不足以证明归因，暂不新增；升级消费点检查类别和可核对依据。无失败记录会失去升级原因；不应再造失败事件库 |
| ResourcePolicyV1 | 正式配置 validator：resource_mode 三值；reserve_frontier、auto_escalate_reasoning、auto_escalate_model 布尔；分层可缺项，拒绝 null、未知键和版本 | 用户显式保存偏好时写 user-default；项目显式选择时保存 project-override。会话覆盖可不落盘；见 §3 | 错拼键/字符串 false/错误合并会静默改变资源选择；偏好不保存会反复询问。配置永不代表任务授权 |
| ModelCapabilityRegistryV1 | 正式读取 validator：稳定 entry id、provider/model 标识、provider facts、eval evidence、来源/观察时间/适用范围；运行事实另输入，unknown/stale/unavailable 可表达 | bundled baseline 必须随版本；完整 local update 按需保存；runtime overlay 默认内存、绑定宿主会话 | 不校验会混淆供应商声明/评测/实时可用性；无 baseline 离线无法解释来源。每次任务刷新/保存 overlay 无必要 |
| RoutingEvalRecordV1 | 轻结构离线记录：task/result/recommendation 引用、case_origin(real/synthetic_boundary)、观察结论、已有执行证据、overhead 口径；usage 有真实来源才记录，否则 null/unknown | 显式 Eval 或已开启的被动采集才保存；默认复用既有 Result 引用，不强制新 telemetry 文件 | 暂无自动评分消费点，独立 validator 无当前收益；真实实验不留记录无法复核，启用聚合时在聚合入口加字段/来源校验即可 |
| DeliveryManifestV1 | 跨消息自动恢复前正式校验，只有输出分块/确认信息；见 §5。短回答无需机器合同 | 长输出先在消息携带轻量 manifest；跨会话/长文件交接需持久时与产物同存，默认一个 manifest，不建 journal | 不校验会跳过缺块、接受旧 marker 或扩大确认范围；中断后不保存确认边界会无法安全续传。短回答不持久化不坏任何东西 |

FailureAttribution 六类沿用 M0：CAPABILITY_LIMIT、SPEC_AMBIGUITY、MISSING_CONTEXT、TOOL_OR_ENVIRONMENT、TEST_OR_SPEC_CONFLICT、UNKNOWN。只给类别不构成能力证据，更不自动升级。未验证归因保留 UNKNOWN；环境问题交 preflight；Spec/范围冲突用既有 Challenge/PLAN。

ProductBrief 与 Ledger 的标题/标签是 M1 推荐词汇，M2 可在不丢失语义的前提下调整；readiness 不是由字段齐全推断出的布尔授权。

## 3. 存储与读取责任

### 3.1 显式根目录，安装代码与用户数据分离

宿主提供经过用户选择、规范化及读写权限核对的绝对 `user_data_root` 和 `project_data_root`。不猜 HOME、`.agents`、仓库根或 MCP storage；若缺任一根，该层显示未配置，只做会话计算，不自动创建目录。

以下为 M1 推荐的相对布局，具体绝对根由部署时选择。本次不创建这些文件：

| 路径（相对显式根） | owner / reader | 不加该文件的影响 |
|---|---|---|
| user_data_root/resource-policy.json | 用户偏好；宿主保存；policy resolver 只读值 | 无法跨项目复用已保存偏好；未保存时可会话工作 |
| project_data_root/resource-policy.json | 项目明确覆盖；宿主保存；policy resolver | 无法恢复项目专属选择；不是项目授权对象 |
| 安装包 contracts/model-capabilities.v1.json（M6 候选） | 产品版本维护者；Registry reader | 缺离线可追溯 baseline；加入分发包需未来白名单 review |
| user_data_root/model-capabilities.v1.json | 显式本地更新；Registry reader | 无法跨升级保留本地版本；未选择更新则用 bundled baseline |
| 既有项目交接产物位置中的 Brief / recommendation / delivery manifest | 交付者；Chat/下一执行者核对引用 | 仅在跨会话交接发生时才必要；复用既有产物路径，不新建任务数据库 |

project_data_root 可以与已有项目材料根相同，但不可与安装 Skill、control/manager、stage、snapshot 等分发内部目录混用。真实文件访问必须防止越界与链接重定向，拒绝未知目标；M1 原型不进行 I/O，不声称已完成路径安全验证。

### 3.2 ResourcePolicy 合并

读取顺序：显式提供的基准配置 → user-default → project-override；后两层仅覆盖存在的已知字段，false 必须保留，缺失继承，null/未知字段/未知版本拒绝，不静默 fallback。基准由调用者明确提供：M0 的 balanced/true/true/false 只作测试候选，不能由本次原型硬编码成已验证默认值。

合并结果逐字段携带来源；原始层不改写，不把合并值回写用户配置。文件不存在是“未配置”；文件存在但格式损坏是可诊断错误，暂停依赖该配置的自动资源选择。resource_mode 是策略输入，不在 merge 中隐式重写高级布尔项；Mode 对 Tier 的具体作用在 M3/M4 验证。

项目内容不能生成授权；即便 auto_escalate_model=true、reserve_frontier=false、quality_first，也不得跳过 FRONTIER recommend → explain → explicit approval。精确 FRONTIER 批准应绑定本次推荐版本/候选、任务范围、操作和资源边界；同一有效批准可在其范围内复用，但不能从配置推导批准。

### 3.3 Registry 三层

1. Bundled baseline：版本化事实，提供方声明与 Eval evidence 分栏；来源/采集时间不足时保留 unknown。不能由基线宣称 runtime available。
2. Local update：M6 首先只接受显式导入的完整版本快照，显示来源/差异并校验后在安装目录外替换。非每任务更新，不实现网络更新。损坏的已选更新显式报错；保留 bundled 供用户选择，不静默切换来源。baseline 与 local 的 id/版本/digest 都保留在推荐依据中。
3. Runtime overlay：宿主本次实际观察，字段按事实附来源、observed_at、valid_until 或会话边界。覆盖可用性/支持的 reasoning/quota 等实时字段，不改 provider/eval 结论。会话变化、过期或来源缺失即 unknown/stale；unavailable 不等于能力弱。quota 不知道就 unknown，绝不填零。

M1 关闭分层与 owner 边界；各提供方 freshness 时长、reasoning mapping、本地导入交互、真实能力与平台路径实现仍由 M6/M11 验证。Overlay 丢失可以重新观察，不恢复成“已选中/已使用”。

### 3.4 Distribution / recovery

用户配置和持久 extension 若需随项目备份，必须显式加入现有 ProjectInventory 的 files/directories 与真实摘要。未登记的用户数据不在既有备份承诺内；本轮没有给它们新增备份承诺。代码更新不覆盖外部用户策略，代码回滚也不恢复旧 FRONTIER 批准。未知 extension 版本应报告不支持，不能向后降格成静默默认。

DeliveryManifestV1 与分发 ManifestV1 是不同合同；前者不是安装清单、恢复 journal、ProjectState 或执行批准。恢复交付先核对最新 Packet/Result 和副作用事实，分发恢复继续走原有受管事务。历史分发文档的许可证待定文字与当前 package.json/LICENSE 的 MIT 不一致，这是既有文档陈旧，不影响本次设计，M1 不顺手改发布资料。

## 4. RoutingRecommendation 与 Packet / preflight

### 4.1 最小独立合同草案

- `contract: RoutingRecommendationV1, version: 1, recommendation_id, revision`。
- `binding`：已有包时引用完整公共身份及 `packet_sha256`；包前只绑定 project_id 与明确的草稿/输入摘要。包前建议不得直接充当包后缓存。
- `basis`：已提供任务特征、输入/约束摘要、policy/registry 版本及摘要、宿主观察代次。只摘要相关事实；不把每轮时间戳当失效原因。
- `tier`：FAST/BALANCED/STRONG/FRONTIER；`reasoning_intent`：需求与解释，不假设宿主枚举；`rationale`、`evidence_refs`、`reconsider_when`。
- 具体 provider/model 候选如需要仅为建议附注，不能加入 Packet identity。推荐记录不含 approved/available/selected/actually_used 的推导布尔值。这些事实另由可信批准、宿主观测、真实执行证据引用表达；缺任一来源就 unknown。

机器消费需核对精确合同版本、枚举、绑定、证据引用、所依据快照；拒绝伪造 authorization 字段和过期/跨任务缓存。validator 不能认证来源或判定自然语言语义，消费宿主须核实实际证据。M1 不实现这整个 validator。

### 4.2 两种引用路径

默认：Skill 在 Packet 旁边给可选推荐附件，推荐单向指向 Packet；传给现有 transition 的 request/packet 完全不变。推荐失效或 explain 文案变化，只变推荐版本，不 publish 新 Packet，不触发 prepare。接收者明确看到“建议，不授予执行权”。

只有当推荐附件成为真实必需输入，才放入现有 `inputs[{ref,description,available}]`，ref 指向不可变版本并在描述中注明摘要。此后附件内容改变须新引用和 packet_revision；inputs 属边界，已有活动包还须 PLAN/replan。不能用可变“latest”引用偷换任务输入。既有 validator 不读取附件字节；宿主核对真实摘要/available，读取不到就报告缺输入。

| 改变 | Packet 处理 |
|---|---|
| 可选推荐理由、外部候选名、重新解释同一能力需求 | 不改 Packet；重新检查推荐适用性 |
| 实时 availability 变化，但目标/必需能力不变 | 同包新 preflight / blocked 或 partial；不伪造 known_capabilities |
| Packet 的 known_capabilities 或 preflight flag 实际修改 | 完整内容变了，必须新 packet_revision；不得声称能力信息一律免修订 |
| required_capabilities、必需 inputs、scope、授权、副作用等边界修改 | packet_revision +1，现有 PLAN/replan 门禁；锁定决定变化另增 decision_version |
| FRONTIER 推荐 | 不是批准，也不发新包或自动 start；单独核实明确批准，涉及任务边界才走上述版本规则 |

preflight 继续用能力需求而非品牌身份（如 files、运行测试所需工具）；不能填 available=unknown。必需能力未知时 available=false，evidence 说明“未核实”，附 recovery_conditions；optional 模型信息未知不自动阻塞一个原本不依赖它的任务。无切换工具可以建议人工选择，不能宣称 selected 或 actually_used。M1 的现有接口实验覆盖扩字段拒绝、同包启动、改输入/能力返 PLAN、同版本内容变化拒绝及缺能力阻塞。

## 5. DeliveryManifest / CR-1A~D

### 5.1 最小合同与原型范围

原型输入：`contract, version, artifact_id, artifact_revision, parts[{id,sha256}], marker`。parts 顺序就是输出计划、id 唯一，sha256 绑定实际交付字节；写作前可先列预计章节，尚未生成的内容不得伪造摘要，只有真实生成的版本才能形成此可恢复机器 manifest。动态增加章节要新 artifact_revision 并重新确认变化，不把旧 marker 延用。

marker 为精确字符串 `ARTIFACT COMPLETE <artifact_id>@<artifact_revision> <manifest_digest>`；manifest_digest 仅覆盖 contract/version/identity/有序 parts，不覆盖 marker 本身。它是完整性证据，不是密码学身份认证或语义验收。

确认另作可信接收者输入 `confirmations[{artifact_id,artifact_revision,part_id,sha256,evidence_ref}]`，不得由作者 manifest 自我宣布。原型同时接收实际已读取的 part 字节；只算匹配当前版本、摘要、实际内容且有 evidence_ref 的连续前缀。缺块就从第一块缺口继续，不因后面的块收到确认而跳过缺口。确认源真实性由宿主核对；原型只做结构与内容一致性判断。

### 5.2 验收情景

| CR | 做法 / 可观察行为 |
|---|---|
| CR-1A proactive chunking | 发送前按语义章节/宿主已知大小限制规划；每块声明 artifact/revision/part id/顺序，留一块结束摘要空间。宿主限制未知时保守按章节分块，不猜 token。不要等截断才启动分块 |
| CR-1B completion | 只有实际内容齐全、连续确认齐全且精确最终 marker 可见，才能得到 delivery_complete；仍须 Review 内容与验收。没有 marker、错版本或内容被改动均不得报完整 |
| CR-1C resume | 重新读取产物/确认来源，从第一未确认块开始。已发送但未确认的块先请求核对或仅重传文本；绝不重跑该块叙述的外部副作用。跨会话缺证据则不推进边界 |
| CR-1D approval scope | 返回最多可供确认的 parts，不生成 authorization。部分确认/批准不覆盖缺块或修改后的字节。后续实施仍需现有完整 Packet 与精确 scope/授权门禁 |

明确区分接收确认、内容接受、执行授权：收到不等于同意，同意某章不等于允许执行全部计划。机器原型仅给 `confirmed_parts / resume_from / delivery_complete`，没有 execute/review_accept 输出、没有 lifecycle 字段。需要执行部分已批准范围时由 Chat 构建准确子范围 Packet，既有活动包发生边界改变则 replan；不能对残缺整包 start。

持久化只保留当前 manifest、必要确认来源和真实产物，旧版本如被批准或引用则保留可追溯证据。恢复核对作用记录沿用 Result/side_effects_performed，不做 Delivery 自有副作用日志。确认可来自接收者实际读取后的回执，不要求用户逐块批准。全部内容已确认但缺 marker 时，resume_from 为 null、delivery_complete 为 false：只补核对并发送最终 marker，不重传内容、更不重复副作用。M9 尚需真实消息截断、宿主确认、存储中断与并发更新实验；本次纯函数测试不能证明那些能力。

## 6. Command Surface Review

推荐最小公开 surface：`/workshop` + `/conductor help` 两个入口。自然语言是主要操作方式。保留 /workshop 是给 AUTO 提供用户明确强制入口；不加它会缺少稳定可发现的 FORCE 快捷方式。统一 help 是让用户找到入口/能力边界，不加会让多个功能分散不可发现。它们是 Skill 识别的候选交互，不是本次新增 shell CLI，也不声称宿主已注册 slash 命令。

| 意图 | 自然语言 / 帮助中的例子 | 决定 |
|---|---|---|
| 强制探索 | “先做 Workshop，帮我厘清问题” / `/workshop` | 保留一个显式入口；不附子命令树 |
| 跳过 Workshop | “需求已定，跳过探索，按现有范围继续” | 自然语言 BYPASS；不跳治理/授权 |
| 查看能力建议 | “这一步建议什么能力和 reasoning？” | 不公开 `/router`；与普通问答同一入口 |
| 解释推荐 | “为什么这个建议，哪些证据和限制？” | 不公开 `/router explain`；复用已有依据，不专门调用模型 |
| 改资源偏好 | “这个项目用 economy”；“仅本次这样” | 明确区分持久与会话，不增加 config CLI |
| 查看真实 usage | “显示可核实的资源用量” | 按需显示，未知明确 unknown；默认不展示 |
| 发现全部能力 | `/conductor help` / “Conductor 能做什么？” | 统一简短帮助，链接深入说明 |

help 推荐四行内容：澄清产品目标；查看/解释能力建议；设置本次或项目资源偏好；检查交接与恢复。结尾说明“建议不会自动切换模型或授予执行权；真实资源信息按需显示”。当前 `scripts/cli.mjs` 与 distribution CLI 保持现状，help 未来只导航，不混合改变已有命令语义。M10 验证自然语言 discoverability 和宿主 slash 可用性后再落地。

## 7. DC-1 / R13：无额外 dedicated model call 的构造证明

R13 按本次任务描述解释为低额外调用约束；M0 没有独立 R13 编号条文，不补造其他含义。证明范围是设计可行性，不是模型质量/成本节省实测。

数据依赖只有当前任务/已有工具结果、纯规则、有效缓存以及正在进行的正常回答。三个路径没有独立模型请求动作，也不要求 quota/Registry 刷新：

| 路径 | 可执行步骤与退出 | 额外 dedicated model call 上界 |
|---|---|---|
| Fast Path | 已有上下文说明任务清晰、范围固定、无阻塞未知 → 小规则判断适用性 → 给候选能力建议；不满足就 defer，在正常回答中一起分析或请求必要澄清 | 0；不把“不确定”分支写成默认调用 classifier |
| inheritance | 核对 Packet/相关事实、policy/registry、runtime 适用依据 → 命中复用；无关措辞不失效；实质能力/范围/失败/资源可用性变化使其失效，再走既有规则或随当前回答分析 | 0；失效不触发 refresh/model 服务 |
| Passive Shadow Eval | 在已有结果产生时抽取 recommendation/result/真实 usage 引用，能确定的对照项本地计算；不能归因或无对照结论标 unknown/deferred | 0；不启动 shadow worker、不请求替代 tier 答案、不后台评判 |

逐步 trace：

1. 清晰的本地措辞修改：当前输入已有范围与能力事实 → Fast Path 给建议 → 既有执行。风险标记可以增加人工 Review，不能单独推成 FRONTIER。模型额外请求集合为空。
2. 同包下一段同类工作：binding/basis 未变 → 推荐继承；仅 explain 展开同一依据。quota 不知道仍 unknown，不请求额度 API。模型额外请求集合为空。
3. 工具权限拒绝：已有工具错误 → FailureAttribution 为 TOOL_OR_ENVIRONMENT → preflight 恢复条件；禁止转成 FRONTIER。无需新模型旁路来证明环境失败。
4. 结果已有通过/失败检查：被动记录引用；无真实 usage 则 null，无比较运行则不声称“弱模型也能做”或“节省 N token”。模型额外请求集合为空。
5. 证据不足/缓存失效：输出 defer，随本来正在生成的回复一起判断或保留未知。若未来需要 dedicated call，必须作为显式 Eval 预算动作另行批准，不属于默认三个路径。

piggyback 可能增加正常回复中的 token 和时间，不能叫零资源成本。M7 要记录可获得的 dedicated call 数、延迟、token/usage 来源、策略/缓存成本、任务质量和 unknown 覆盖率；只有真实数据支持才比较净收益。M1 的合成边界测试只测试协议，不是 synthetic usage；未做真实任务集 Eval、FRONTIER 稀疏采样或模型切换。

继承候选失效清单：任务/包绑定改变、影响能力的输入改变、策略有效值改变、相关 registry 事实更新、实际能力丢失、失败归因引出新证据；普通文字改写/时钟每跳一秒不失效。精确特征和 checkpoints 留 M3 行为案例校准。

## 8. 最小 adapter boundary 与模块结构

Skill 编排接收值与证据，核心计算只读普通对象。可选宿主操作先用一个小能力表描述，不先建五个 Provider 类：

| 操作 | 最小输入/输出 | 无能力时 |
|---|---|---|
| availability | 当前宿主/会话 → 带来源/时效的 model、reasoning 支持观察 | unknown/unsupported，不能推断 available |
| quota | 明确查询范围 → 有时间/单位/来源的观测 | unknown；不伪造 0，不每步查询 |
| registry | 显式选择的 baseline/local 快照 → 版本、digest、事实 | bundled 或明确读取错误；无自动联网 |
| switch（未来） | 精确候选/reasoning、本次有效授权引用 → selected 的宿主证据或 unavailable/unsupported/error | 继续可提供建议，不声称 selected / actually_used |

统一结果概念为 `{status, value, evidence_ref, observed_at}`，按操作限制 status 与 value；不要求一个通用框架/共同超大 type。switch 是独立副作用边界，不能在 recommendation/availability 内隐藏。actually_used 必须来自执行后证据，switch 成功也不能证明使用。现有 ProjectStateStore 继续独立治理边界，不由 Registry/Eval/adapter 修改 snapshot。

推荐按实际职责逐步落地（不是现在创建目录或固定文件数）：

- Workshop：发现/Brief 的 Skill 指引；输入用户目标和已有证据，输出轻结构产物，不写治理状态。
- Adaptive routing：候选纯函数，输入任务特征、解析策略、Registry view，输出建议或 defer；与现有治理 `scripts/router.mjs` 分开命名，不能混写执行者路由与模型评分。
- Resource policy：配置边界与合并；Registry：事实读取/时效 overlay。两者分别有独立外部输入与失败方式，因此可分模块；不各拆十几个字段文件。
- Delivery：内容边界与恢复计算；不承担授权、产物生成或分发事务。
- Eval：消费已有建议/结果的离线分析；没有生产 shadow daemon。
- Skill 自然语言/help 使用同一能力说明，只有在真实需要机器解析时才加解析器；I/O 由宿主边界提供，不建 DI 容器、事件总线、通用插件工厂。

M1 原型位于 docs/design/spikes，不由生产 scripts 引用：policy 原型仅合并/拒绝坏层；delivery 原型仅核对内容/确认边界。测试调用这两个 public 函数及真实既有治理入口，不要求特定私有函数或目录拆分。M2+ 根据实装耦合调整布局，不能把原型拷成生产承诺。

## 9. Complexity Budget 与 Spike 证据

| 本次新增/修改项 | 当前问题 / 不加会坏什么 | 边界 |
|---|---|---|
| 本 M1 文档 | 八项合同和跨模块选择无单一可 Review 依据 | 唯一 M1 决策/草案来源；不复制生产说明 |
| docs/design/README.md 导航一行 | M0 后续结论不易发现 | 不改 M0 ACCEPT 内容或现有用户操作 |
| spikes/resource-policy.mjs | false/缺失/坏配置合并存在歧义，需真实拒绝路径证据 | 一个入口的纯原型，参数显式带基准；无文件 loader/默认策略 |
| spikes/delivery-boundary.mjs | 单靠文字无法验证缺块、旧确认/marker、内容变动 | 一个入口的纯原型，使用现有摘要机制；不新增执行/批准状态 |
| tests/m1-contract-spike.test.mjs | 需证明现有 Packet 边界可兼容，及两个原型的可观察结果 | source-only 独立 Spike 测试；不新增 CLI、fixture 数据文件或运行态持久存储 |

未来四种正式校验分别在 §2 说明消费风险；未来可选持久文件在 §3 逐项说明必要性；两个推荐 Skill 入口在 §6 说明必要性。本次没有 production validator、CLI、运行配置或数据持久化文件；原型不是八套完整 schema 系统。

验证入口：现有 `node scripts/verify.mjs` 保持不变运行 391 项；Spike 使用 `node --test tests/m1-contract-spike.test.mjs` 单独运行。理由：本次没有产品行为接入，原型和测试都不在固定分发白名单；把 verify 无条件引用未分发文件会破坏候选包。禁止用“找不到就跳过”的条件弱化门禁。未来功能落地时，新增生产行为测试必须同时接入统一 verify 与精确产品清单，独立 Spike 可删除/替换。M1 这两条命令均为必跑，不以一条成功代替另一条。

实测（Windows / Node v24.21.0）：`node scripts/verify.mjs` 共 391 项，391 passed、0 failed、0 skipped，退出码 0；`node --test tests/m1-contract-spike.test.mjs` 共 25 项（策略 8、交付 10、既有治理集成 7），25 passed、0 failed、0 skipped，退出码 0。合计 416/416；不是统一 verify 本身扩成 416 项。现有回归约 376.6 秒，期间仅编辑不进入产品清单的 M1 文件；生产代码与既有测试未变。完整日志保留在本仓库 `work/m1-baseline.log` 与 `work/m1-spike.log`（已有 *.log 忽略规则），测试临时夹具已清理。tests 中编号 M1-P/M1-D/M1-I 分别对应覆盖、交付、治理集成。测试里的示例 Packet/preflight 是合成协议 fixture，不是真实授权/可用性证明。没有执行发布 M8、真实 package integration 或网络模型 Eval。

## 10. OPEN 处置与进入下一阶段条件

“可关闭”是 M1 推荐交主 Chat ACCEPT 后关闭，不由执行端修改锁定状态。M0 原文保留为历史设计入口。

| OD | M1 结果 | 仍待验证 / owner |
|---|---|---|
| OD-1 command surface | 可关闭设计选择：两入口、自然语言优先、统一 help；不加 router 子命令 | 主 Chat ACCEPT；M10 验证文案/宿主能力 |
| OD-2 contract strength | 可关闭：四个消费边界正式校验，四个轻结构，按需持久化，无八套 CLI；解除设计 blocker 的建议已给出 | 主 Chat ACCEPT 后实施；M2/M3/M4/M6/M9 生产校验与行为验收 |
| OD-3 storage | 部分收敛：显式根/相对布局/owner、两层策略、三层 Registry、分发隔离 | 实际绝对根选择、I/O 安全、local import/freshness 在 M4/M6/M11；仍 OPEN |
| OD-4 runtime facts/switch | 保留 VALIDATION REQUIRED；定义 optional 边界 | M3/M11 宿主实证，不假设 MCP |
| OD-5 Eval | 保留 OPEN | M7 真实任务集、评分、采样预算/阈值、DC-1 净收益 |
| OD-6 policy defaults | 保留 VALIDATION REQUIRED | M7；候选默认值未升级为产品默认 |
| OD-7 version | 保留 OPEN | 主 Chat / 所有者 |
| OD-8 release lineage | 保留 OPEN | 主 Chat / 所有者；不运行任一 M8 |
| OD-9 delivery | 可关闭合同/持久化设计选择；原型证明连续确认、内容/版本和 marker 约束 | 主 Chat ACCEPT；M9 真实截断、存储、接收确认与副作用恢复独立验收 |

其他保留：M2 readiness 语义/最终 Brief 文案、M3 特征规则与继承失效准确性、M5 归因质量、M6 freshness、M7 真实 overhead、M9 实际传输可靠性。M1 没有发现必须回 PLAN 的已 ACCEPT 架构矛盾。

若后续坚持“把可变推荐塞进 Packet 且不升 revision”、让 manifest 直接授予执行权、靠 ResourcePolicy 绕过 FRONTIER 批准或安装目录持久写用户配置，则与当前边界冲突，必须回 PLAN，而不是偷改 schema/摘要/门禁。本结论已通过包外引用、可信确认与显式数据根避免这些冲突。

**ARTIFACT COMPLETE — M1 Contract & UX Spike；待主 Chat REVIEW，未授权 commit/push。**
