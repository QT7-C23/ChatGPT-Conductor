# FailureAttributionV1（M5）

M6 的 `REGISTRY_STALE` / `REGISTRY_UNKNOWN` 保留 UNKNOWN，`MODEL_UNAVAILABLE` 归 TOOL_OR_ENVIRONMENT；这些证据都不产生 CAPABILITY_LIMIT 或自动升级。Registry 过期和运行不可用应按 [Registry 边界](model-capability-registry.md) 处理。

`scripts/failure-attribution.mjs` 从宿主或 Chat Review 已整理的失败事实生成轻结构附件。输入 `evidence: {ref, signal}[]`；`ref` 是真实 Result check、Review 缺陷、日志、preflight 或获批 Spec 的可定位引用，宿主负责核验。`result_status`（succeeded / partial / blocked）和 `review_verdict`（ACCEPT / REVISE / ESCALATE）仅供关联，不会凭状态或 REVISE 推断能力失败。模块不解析任意日志文本、不额外调用模型或网络；没有足够证据时返回 UNKNOWN。

结果包含 `contract=FailureAttributionV1`、`version=1`、`category`、所用 `evidence` 与 `evidence_refs`、标签式 `confidence`、`recommended_action`、`routing_reassessment_required`、`alternative_explanations`。confidence 是定性标签，不是概率或自动归因准确率承诺。证据冲突时为 UNKNOWN，保留引用与可能类别供诊断。`validateFailureAttribution` 仅检查轻结构、自洽性与升级消费门槛，不能证明证据真实。

| category | 输入信号 / 推荐动作 | Failure checkpoint |
|---|---|---|
| CAPABILITY_LIMIT | `REPEATED_CONSTRAINT_FAILURE` 加 `SPEC_CLEAR` 和 `ENVIRONMENT_HEALTHY` 三项可核查证据；`REASSESS_REASONING_FIRST` | 是，唯一可直接把失败用作能力证据 |
| SPEC_AMBIGUITY | `SPEC_UNCLEAR`；`RETURN_WORKSHOP_PLAN` | 否 |
| MISSING_CONTEXT | `CONTEXT_MISSING`；`SUPPLY_CONTEXT` | 否 |
| TOOL_OR_ENVIRONMENT | `TOOL_FAILURE` / `ENVIRONMENT_FAILURE` / `PERMISSION_DENIED`；`RECOVER_ENVIRONMENT_PREFLIGHT` | 否 |
| TEST_OR_SPEC_CONFLICT | `TEST_SPEC_CONFLICT`；`RETURN_PLAN_CHALLENGE` | 否 |
| UNKNOWN | 无足够事实或信号冲突；`DIAGNOSE` | 否 |

如 npm launcher/path、网络 443 和权限拒绝，有宿主核实的工具或环境失败引用时归环境；缺少任务要求提供的文件或上下文，且没有环境错误证据时归 MISSING_CONTEXT。测试与已批准 Spec 矛盾归 TEST_OR_SPEC_CONFLICT；产品目标尚未定义归 SPEC_AMBIGUITY。仅模型反复违反明确复杂约束、同时证实 Spec 清晰且环境正常，才可成为 CAPABILITY_LIMIT 候选。信号标签不替代原始证据，后续 Review 可以修正归因。

`failureReassessmentHint` 只在 `routing_reassessment_required=true` 时返回 M3 的 `failure_reassessment` checkpoint、证据引用和 `nextCapabilityStep` 的 reasoning-first 候选。宿主随后用已核实的新 profile/basis 获取 M3 推荐，并把推荐送入 M4 `decideResourceRouting`。候选不改变 policy：`auto_escalate_reasoning` / `auto_escalate_model`、runtime capability、独立自动路由授权和 FRONTIER 显式批准继续生效。即使是 CAPABILITY_LIMIT，也不会自动切换或直接推动 FRONTIER；UNKNOWN 先诊断。

附件通常随现有失败 Result 的 `limitations` / `checks` / evidence 引用保存，或在包外与该 Result 关联；不增加 schema 2 的必填字段，也不修改 Result 的 succeeded / partial / blocked、Result 摘要、Review、REVISE、Challenge、LOCKED DECISIONS、Packet 授权或七阶段。需要改变 Spec/范围/锁定决定时仍按 [工作流](workflow.md) 回 PLAN 和既有 Challenge/批准规则。没有失败的旧项目不需要附件。
