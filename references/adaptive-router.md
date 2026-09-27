# Adaptive Model Router Core（M3）

`scripts/adaptive-router.mjs` 的 `recommendRouting` 接收宿主已整理的 `binding`、`basis`、`profile`、`checkpoint`，返回 `contract=RoutingRecommendationV1, version=1` 的 Packet 外附件。机器消费或缓存前用 `validateRoutingRecommendation` 并传入预期 binding/basis；继承记录还需提供前一条推荐。校验器检查结构和适用依据，宿主须核对证据真实性。推荐不改 `schema_version=2` 的 Packet、`packet_revision`、required_capabilities、授权或 ProjectState。

## 输入与推荐合同

- `binding`：包前为 `draft` + project_id + input_digest；有包时为 `packet` + 完整公共身份 + `packet_sha256`（现有 `packetIdentity(packet).content_sha256`）。包前建议不能直接沿用到包后。
- `basis`：scope/task 的 SHA-256 摘要必填；runtime capability、registry evidence、policy 摘要可为 null，表示未提供。它们是调用者提供的相关事实版本，不触发 Registry 刷新或 quota 查询。
- Task Capability Profile 七字段为 `reasoning_complexity`、`context_load`、`ambiguity`、`failure_cost`、`verifiability`、`change_surface`、`prior_evidence`，各取 LOW/MEDIUM/HIGH；宿主负责根据真实任务作语义判断。高 failure_cost 单独提高 execution_risk，不自动提高 Tier。
- 记录含 recommendation_id/revision、checkpoint、profile、capability_need 摘要、execution_risk、tier（FAST/BALANCED/STRONG/FRONTIER）、reasoning（LOW/MEDIUM/HIGH）、confidence、简洁 rationale、evidence_refs、reconsider_when、inherited/previous_recommendation_id、routing_path（FAST_PATH/RULES/INHERITED）及 overhead。`extra_model_call=false`、`dedicated_analysis=false` 是本核心的真实操作边界，不表示正常回答没有时间或 token 开销。`compactRecommendation` 仅显示 tier/reasoning/confidence/rationale。

## 适用性与治理

完全相同的绑定、basis、profile、证据引用可继承并记录前一 ID；scope/task/profile、Packet 身份、runtime capability、policy、registry evidence 变化使继承失效。普通措辞和时钟变化不应写入依据摘要。前一记录缺失时重新生成，不猜测批准。`nextCapabilityStep` 只给 reasoning-first 的候选步骤，不触发切换或失败归因。

FRONTIER 只在复杂信号并有宿主提供的能力证据引用时可能成为建议；引用真实性须由宿主核实。记录不含 approved/available/selected/actually_used、实际模型名、隐藏思维链、quota、usage 或合成 token 值。后续由 [ResourcePolicyV1](resource-policy.md) 在 Packet 外作策略决策与 FRONTIER 批准校验。checkpoint 只是判断时机，不增加七阶段的状态或事件。现有授权、Challenge、副作用、迁移与恢复规则继续按 [治理合同](contracts.md) 和 [工作流](workflow.md) 执行。
