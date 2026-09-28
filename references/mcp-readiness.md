# MCP Readiness（M11，可选宿主合同）

Skill-first, MCP-ready, not MCP-dependent。本文规范最小 adapter boundary；不是 MCP 协议、生产 adapter 或 server 实现。核心只接收普通对象和可核对证据，不导入 MCP、不访问 provider、不自动切换。不增加 schema 2 字段、生命周期、公开命令、依赖或 Provider 类。

## 能力与证据

宿主可按操作声明 supported / unsupported / unknown。supported 只说明提供该操作的能力，不能推出本次目标可用、quota 可读或用户授权；没有 adapter 等同缺可用操作，不使核心失效。不要通过试调用其他操作来补造能力表。

每个事实必须来自当前 host_session 中真实可读的观察，保留 evidence_ref/source_ref、observed_at、valid_until 和准确目标/查询 scope。已知事实必须能核对原始证据；字符串自称“runtime”不认证来源。提供方静态声明只进入 provider_facts，不能升格为 runtime truth。会话不匹配拒绝消费；过期或没有明确有效期/来源的观察不当作当前事实，不猜 freshness。

操作结果概念为 `{status, value, evidence_ref, observed_at}`，不是新增通用机器 schema。status 为 known / unknown / unsupported / error；known 要有真实来源和观测时间，value 按下表限定，并随操作携带 scope/会话/有效期。unknown 或 unsupported 的 value 为 null；可以携带真实的能力缺失证据，不填 0 或 false 冒充数值观测。error 要有可诊断失败引用，不能伪装成 unknown 或成功。部分操作已知、其他未知时逐项保留，不能用一个成功结果覆盖整张表。消费核心时使用下述既有合同/validator，而不是把这个概念 envelope 传入核心。

## 最小操作与现有消费点

以下是语义操作名，未新增可执行函数或命令。只有明确需要该事实时才由宿主提供已有观察或发起获授权的按需请求，无每任务查询、polling、watcher 或后台刷新。

| 可选操作 | 输入与输出语义 | 现有合同 / 无能力时 |
|---|---|---|
| model_availability / selectable_options | 明确宿主、会话、候选范围；返回该 scope 下实际可见的稳定候选 ID、available/selectable 观察，不能把部分列表说成完整模型清单 | [ModelRuntimeOverlayV1](model-capability-registry.md) 的 observations；未知项用 unknown，缺操作用 null overlay；不从模型名猜 Tier |
| reasoning_control | 精确候选与当前会话；分别报告是否支持调整以及宿主原生可选值和语义映射证据。原生值到 LOW/MEDIUM/HIGH 的映射尚未核实时 unknown | overlay.reasoning_control → 已核实的 M4 reasoning_adjustable；仅知道“支持”不能证明某 reasoning 值可选 |
| quota_state | 明确账户/宿主/候选等查询 scope；真实可读才返回 remaining、unit、时间与来源。不同 scope、单位或窗口不得互换 | overlay.quota；不可读为 readable=false/unknown，remaining/unit=null，不填零，不查询 quota API |
| registry_source / refresh_request | 用户明确选定的 baseline/local 来源；返回完整快照、独立版本/digest/来源。refresh_request 只描述需要补什么证据、目标来源与理由，不发请求 | 现有 loadRegistry / validateRegistrySnapshot；离线 bundled 继续可用，选定 local 损坏要报错；refresh_needed 不触发下载 |
| controlled_switch_request | 本次 recommendation_id/绑定、精确目标候选及 reasoning 意图、有效授权引用与资源范围；仅描述请求，由未来独立实施审核决定执行 | M4 ResourceDecisionV1 + 独立授权；无能力继续 recommendation-only，selected/actually_used=unknown。本轮不执行请求、不提供成功 switch 回执 |
| optional persistence | 仅在真实跨会话交接、恢复或显式保存需要时，由宿主核对用户选定的绝对数据根、权限与来源后保存 | 权威状态复用 [ProjectStateStore](state-backend.md)；其他附件按既有交接路径保存，不新增 StateProvider、共享数据库或自动写入器 |

## 接入与 degraded 行为

- Router：M3 recommendRouting 不要求 adapter/Registry/MCP。只有实际需要候选映射时才用已加载 Registry 与现有 resolveRoutingCandidates；缺 runtime overlay 返回 unresolved，runtime 字段为 unknown，可继续抽象能力建议。无已验证映射时不制造模型名。
- Policy：当前 Tier/reasoning 有独立可信依据时，宿主可传入它们和未知 availability/support，auto_route_authorized 默认为未授权 false。当前 Tier/reasoning 也未知时，**暂不计算 M4 动作许可**，保留 M3 建议和缺失事实；M4 现有严格枚举不接受 unknown，不填造 FAST/LOW 来通过校验。M4 不接 quota 数字；quota 不能从偏好或静态模型事实推导。
- Registry：复用 validateRuntimeOverlay；严格拒绝把 provider/eval/authorization/selected/actually_used 塞入 overlay。当前 available=false 或 selectable=false 优先于静态能力匹配；静态 Tier 不因此改写。只有 fresh 且会话匹配的事实可用于当前判断。
- Workshop：按自然语言及已知产品事实做 AUTO/FORCE/BYPASS、Brief/PRD；不等待 adapter。外部事实确实影响决策但无法获取时标 unknown，必要缺口按现有 readiness 处理，不伪造研究结果。
- Eval：只摘取已有证据，缺实际模型、usage、quota 或时间就 unknown/null；没有 MCP 仍能形成离线记录。无 Eval 数据不影响 REVIEW/COMPLETE。
- Delivery：本地章节分块、摘要、marker、恢复仍有效。缺宿主回执时 UI visibility=unknown，不能将本地 emission 转成确认或批准；真实 transport 与并发保存仍待验证。
- Governance：旧 schema-2 Packet/ProjectState 没有任何 adapter 字段仍可验证、预检、执行并审核。真实必需工具未知时沿用 preflight available=false 和恢复条件；可选模型信息未知不凭空变成必需工具。

以上不承诺每个任务都可继续执行：只继续不依赖缺失事实的计算/Skill 工作，必要治理及输入缺口仍会阻塞相应动作。error 与损坏选定配置明确诊断，保留状态，不静默吞错或降格。

## 能力不产生授权

switch_supported=true 不生成 auto_route_authorized；配置 auto_escalate_model=true 也不是用户授权。受控切换请求必须核对本次适用推荐、M4 policy、实际候选可用/可选、真实 reasoning 映射、独立自动路由授权或明确手动选择批准。M4 的 AUTO_ROUTE_ALLOWED / AUTO_ADJUST_ALLOWED 只是允许动作提示，不是已执行证据，未来宿主仍需核对有效用户授权；不能把 reasoning 调整支持当批准。

FRONTIER 始终经过能力证据 → recommend/explain → 显式批准，批准绑定本次推荐、select_model 操作和资源范围。自动路由授权或 quality_first 不替代该批准；本轮 M4 对 FRONTIER 保持 RECOMMEND_ONLY。任何资源/模型批准都不授予任务执行或 Packet side effects。

recommended、approved、available、selected、actually_used 分开核实。未来成功 switch 的实际宿主证据最多证明 selected，不证明 actually_used；后者需要独立执行证据。外部 provider 返回的“已批准”不能创建可信用户授权。

## 为什么只有 reference + tests

M6 已有 runtime/registry validator，M4 已有严格 policy/批准边界，M3/M2/M7/M9 均为本地 helper，权威状态已有独立 StateStore 接口。当前不存在新自动消费点；再加通用 adapter result validator 或转换模块会重复合同，不能增加事实真实性。本轮因此零新增生产代码；只用此 reference 收敛来源/降级/授权语义，并在 [M10/M11 回归](../tests/docs-readiness.test.mjs) 验证现有公开消费点。

新增测试证明本地合同与无 adapter 路径，不证明自然语言模型解释永远正确、真实 MCP interoperability 或宿主能力可用；概念 envelope 尚无机器消费实现。

## 未来真实 MCP 阶段

仅在有具体需求时提案：实时 availability/quota、受控自动切换、多设备共享状态或外部 Registry provider。每项需说明 Skill/现有本地路径不能满足什么，并经过独立 Product/Architecture Review，核实真实宿主 API、身份/授权、最小权限、来源/时效、失败与恢复、资源开销和验收；不因 MCP-ready 自动升级。

仍 OPEN / VALIDATION REQUIRED：真实模型映射、宿主 reasoning 枚举/语义映射、switching/可读 quota/原始使用证据、source retrieval、安全路径与并发持久化、真实 UI transport、Live Calibration/实际节省及默认策略效果。下一版本号和 V1.2.0 release lineage 由主 Chat/所有者另行决定。

本轮没有 MCP JSON-RPC/transport/server/network client/auth backend/shared database/quota polling/watcher/automatic switching，没有模型调用或 synthetic usage；相关核心及测试保持本地确定性。
