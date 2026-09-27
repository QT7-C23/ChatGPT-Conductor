# 路由、决策与恢复

具体模型候选按 [ModelCapabilityRegistryV1](model-capability-registry.md) 解析离线证据与本次宿主 runtime overlay；unknown/stale/unavailable 只要求按需补证据或恢复环境，不能推成能力不足或自动升级。候选仍在 Packet 外，不改授权或 revision，也不声称已切换。

显式 Eval 或已开启的被动采集可按 [RoutingEvalRecordV1](routing-eval.md) 在结果形成后离线摘取已有证据。缺 Eval 记录不阻塞 REVIEW/COMPLETE；Eval 不能改变七阶段、批准、模型选择或 Registry 事实。

## 任务分类

对目标、用户、范围或关键取舍尚不明确的产品请求，先用 [Product Workshop](workshop.md) 在 DISCUSS/PLAN 完成发现；明确小任务直接分类和路由。ready Product Brief 可供 PLAN 使用，但不替代本文件的 prepare、授权、版本或恢复规则。

能力推荐可在 workshop、research escalation、pre-execution、failure reassessment、review 或 significant replan 时按需重新判断；这些是 checkpoint，不是新阶段或状态事件。只在当前步骤确实需要能力决策时调用：Workshop 尚在澄清产品范围时不提前运行 Router；ready Brief 进入 PLAN 后，通常在拟议 Packet 的 pre-execution checkpoint 判断一次，不在 Workshop 和 PLAN 对同一事实重复判断。若 Workshop 中已为明确的独立步骤形成建议，包前 draft 记录不能直接用于正式 Packet；包身份确定后按当前绑定校验并形成适用记录。先核对上次推荐的任务绑定、profile、scope/task 摘要以及 runtime capability、policy、registry evidence 摘要；仍适用时继承，无实质变化不再次分析。简单明确任务走本地 Fast Path，复杂或信号冲突任务走本地保守规则并如实降低 confidence；两者均不发额外模型请求。运行中若已有独立证据需要提升能力，先建议提高 reasoning，再建议提高 Tier；本模块不判断失败归因或实际宿主支持。资源偏好按 [ResourcePolicyV1](resource-policy.md) 在推荐后独立决策，不替代现有执行授权。

完整链路为：请求按需进入 Workshop → DISCUSS/PLAN 确定产品范围与可信授权 → 包外 Recommendation 与 Resource Policy → schema-2 Execution Packet → 当前宿主的 capability preflight → Result → Chat Review/必要时 REVISE 或 PLAN → 可选的被动 Eval。Recommendation 的 ID/解释、具体模型候选、Registry runtime 和 usage 都留在 Packet 外；仅它们变化不重发 Packet。required_capabilities、inputs、scope、authorization 或其他包内容实际变化仍按下文升版及 replan。preflight 逐项报告 Packet 的必需能力；模型的 availability、reasoning control、switching support 与 quota readability 由宿主在独立 runtime 观察中如实提供，静态 Registry 不替代当前预检。无法确认必需能力时在 preflight 记 `available=false`、证据和恢复条件；未知 quota 保留 unknown/null。FRONTIER 的策略允许动作和专用批准都不授予 Packet 副作用或证明 selected/actually_used。

失败后的能力 checkpoint 仅由 [FailureAttributionV1](failure-attribution.md) 的 `routing_reassessment_required` 触发。只有经实际失败证据支持的 CAPABILITY_LIMIT 才能把失败用于 reasoning-first / Tier 重评；REVISE、工具故障、缺上下文、规格含糊、测试与规格冲突和 UNKNOWN 均不自动推高能力。归因建议仍受 Resource Policy、runtime 与批准门禁约束。

先判断用户要讨论还是要交付，再判断交付物。`work_type` 由当前模型依据这些规则归一化；校验器不做自然语言理解。

| 用户意图 / 交付物 | 下一站 | 例子 |
|---|---|---|
| 讨论、比较、需求澄清、可行性判断 | Chat / DISCUSS | “这个 API 设计是否合理？”即使涉及代码，也先讨论 |
| 范围、架构取舍、计划、验收标准 | Chat / PLAN | “拆成三个里程碑，先不要实现” |
| 已明确要求的资料搜集、文档、表格、幻灯片、文件整理、浏览器操作 | Work / general | “按确认材料生成报告”；依赖必要文件和工具可用 |
| 代码、仓库变更、测试、调试、依赖或构建配置、可维护脚本 | Codex / code | “修复登录并添加回归测试” |
| 回传结果的项目验收 | Chat / REVIEW | 核对目标、交付物、决策和证据；必要时另发 Codex 技术检查子任务 |
| 同时要研究报告和落地代码 | Chat / mixed | 拆为 Work 研究 → Chat 确认设计 → Codex 实现 → Chat 审核 |
| 不能确定交付物或范围 | Chat / unknown | 明确列出候选解释，澄清后再生成执行包 |

为生成文档而临时写的辅助脚本可留在 Work；需要交付、维护或并入仓库的代码属于 Codex。文件后缀不能单独决定平台。平台不可用时记录阻塞，由用户确定替代平台；不静默回落到另一个平台。

## 状态转换

主路径：`DISCUSS → PLAN → READY_TO_EXECUTE → EXECUTE → REVIEW → COMPLETE`。
修订路径：`REVIEW → REVISE → READY_TO_EXECUTE → EXECUTE → REVIEW`。
分歧路径：绑定当前包的 blocking Challenge 返回 PLAN；非阻塞 Challenge 保持当前阶段。Chat 审核使用 escalate 事件加 ESCALATE Review Record 与 blocking Challenge。完成后通过 reopen 返回 DISCUSS，lifecycle +1，保留旧包、结果摘要与审核作历史基线，旧身份不可再次用于执行。

[routing.json](../contracts/routing.json) 给出所有事件、合法来源和目标。
事件 `prepare` 完成交接准备，`start` 表示执行者实际接收并开始。准备好并不表示已经调用 Work/Codex。路由命令只返回建议和新快照，绝不触发执行。

`prepare` 检查单一执行者、目标与范围、交付物和验收项、决策快照、授权、输入、依赖及未解决阻塞。required_capabilities 未全部出现在 known_capabilities 时，必须设置 capability_preflight_required=true，仍可进入 READY_TO_EXECUTE。

`start` 总是要求绑定当前包的 preflight。逐项报告能力是否 available 和 evidence。缺少报告或身份不符则拒绝；能力不足时直接返回 REVIEW / CHAT 和 blocked Result Packet，所有验收 not_run、无交付物、无已执行副作用，列出 missing_capabilities 与 recovery_conditions。执行中失败可如实回传 partial。不得猜测工具可用或伪造调用。

不满足就绪条件时保持原阶段，输出具体缺口并交 Chat 补齐；不要强填字段。明确要求“开始做”的用户请求可作为其范围内授权来源；“方案不错”不能自动扩张为实施、发送或发布授权。已有授权来源可引用而不重新询问；迁移项目仍需 Chat 对当前完整包签发新执行批准，不能沿用旧批准对象。

`submit` 接受 succeeded、partial、blocked，均带逐项 checks、能力记录和副作用实录。有 blocking Challenge 时返回 PLAN；非阻塞建议随结果交 Chat。accept / revise / escalate 必须分别匹配 Chat Review 的 ACCEPT / REVISE / ESCALATE。审核逐项覆盖验收和锁定决策。REVISE 要求 revision_instructions，新包原样携带；revision_reviews 在多次 prepare 中持续保留。后续审核要替代前一条修订意见，必须填写 supersedes_review_id 并保留旧记录。Work/Codex 的 succeeded 不等于 COMPLETE。

ESCALATE 的非空 revision_instructions 与当前有效意见累加，进入同一 revision_reviews 历史；原始审核不改写。解决 Challenge 只解除阻塞，后续包仍须保留全部有效要求。需要处置要求时引用 currentRevisionRequirement 的当前 id：规划批准用 replaces_requirement_id，后续 REVISE 用 supersedes_requirement_id；supersedes_review_id 始终指向上一条 REVISE。详见[统一门禁说明](v1.1.2-gates.md)。

同一生命周期内 prepare 比较完整任务边界摘要；变化则返回 PLAN / replan_required。仅进入 PLAN 不构成批准；Chat 必须通过 replan 记录可信来源及原包/拟议包摘要，随后 prepare 才能接受该变化。实现修复只调整原范围内的产物和 revision_instructions；边界字段的任何文字调整都保守要求重新规划。

V1 一个项目快照同一时刻只管理一个活动任务。多任务按依赖顺序交接，不把一个 COMPLETE 当作整个大项目全部完成。下个任务从 reopen/plan 开始。未来真正需要并行时再扩展状态模型。

## 决策变更与 ESCALATION

权威基线由用户与 Chat 维护，执行者接收只读副本。每次交接明确哪一份文件及 revision 是当前版本；不能凭文件名相同或最后聊天时间猜测最新版。

1. 执行者发现锁定决策有技术问题、现实前提不成立或执行范围冲突，发 Challenge，保留原决策，暂停受影响动作。
2. Chat 核查证据，提出维持或修改方案；决策归用户或其事先明确授权的负责人。Chat 不是自动拥有最终决定权。
3. 在 [决策变更记录](../templates/decision-change.md) 中记录批准者、授权来源、原值、新值、影响任务和处理结论。
4. Chat 填写 escalations.resolution_ref，指向真实处理记录；执行者不得自行清除阻塞。仅 LOCKED DECISIONS 实际变化使 decision_version 加一；开放事项或实现修订不提升它。状态更新 revision 加一。目标、scope、输入、交付物、验收、revision_instructions、权限或能力声明变化均使 packet_revision 加一。维持原决策的阻塞 Challenge 处理后也发新版包。详细比较规则见 [契约说明](contracts.md)。
5. 执行者重新校验后继续，不通过“先改了再汇报”来绕过规则。

JSON 校验把 prepare 时完整任务包的稳定 SHA-256 摘要绑定到活动状态，start/submit/accept/revise 均核对，防止沿用同一版本号换执行者、目标或验收条件。摘要只保证与所给基线一致；它检测不到文件实际内容偷偷偏离而回传包仍抄原值，Chat 必须审核实际产物。V1 不提供加密签名、身份认证或不可篡改审计。

## 断点与跨会话恢复

带上最新 project-state、Execution Packet、最近 Result Packet、决策变更记录和真实附件。执行者先核对版本，不重复已完成的外部动作。没有完整上下文时只补缺口，不凭记忆推翻决策。引用的历史聊天只提供背景，最新明确用户指令拥有优先权。

## V1.1.2 恢复与修订补充

迁移恢复为 PLAN → reauthorize → prepare → start。缺批准的 prepare 返回 PLAN / reauthorization_required；普通 replan 不发放迁移执行资格。当前修订要求同时来自 REVISE、replan/reauthorize 和迁移证据，任何来源都不能因重复 prepare 消失。取消/替换须引用当前要求并批准完整新包，ACCEPT 是完成要求的明确事件；参见 [门禁契约](v1.1.2-gates.md)。
