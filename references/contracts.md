# V1.1.2 数据契约

项目版本 1.1.2；UTF-8 JSON 使用 **schema_version=2**。运行时契约以 [contracts.mjs](../scripts/contracts.mjs) 为准，未知字段拒绝。模板用于人工填写，不能直接作为 JSON 传给 CLI。旧版迁移见 [migration-v1.1.md](migration-v1.1.md)。

## 公共身份

Execution、Result、Challenge、preflight、Review 均绑定 project_id、task_id、packet_id、packet_revision、decision_version、executor、lifecycle。lifecycle 和两个版本必须为正整数，executor 为 WORK 或 CODEX。Challenge 无需聊天上下文即可识别归属；处理时仍须与当前包核对，不能靠自带标识创造权限。

## 权威状态 ProjectState

[样例](../examples/project-state.json) / [后端类型接口](../contracts/state-store.d.ts)。

| 字段 | 含义 |
|---|---|
| project_id / revision / state | 项目标识、每次状态更新 +1 的版本、七个阶段之一 |
| decision_version | LOCKED DECISIONS 的实际记录变化才 +1 |
| locked_decisions | 数组，每项含 id、decision、rationale、approval_ref |
| open_decisions | 数组，每项含 id、question、owner、blocking；owner 为 EXECUTOR / CHAT / USER |
| active_packet | null 或含 packet_id、packet_revision、task_id、content_sha256、decision_version、locked_decisions_sha256、lifecycle、boundary_sha256 的对象 |
| escalations | 数组，每项含 challenge 和 resolution_ref；未解决的 blocking 项阻止重启 |
| review_record | null 或完整 Chat Review Record，不是执行端结果 |
| result_sha256 | null 或待审核 Result 的稳定摘要；防止审核时替换同身份结果 |
| lifecycle | 单调增加的生命周期；新项目 1，reopen +1，旧格式显式迁移到 2 |
| revision_reviews | 本生命周期的 REVISE Review 历史，保留未完成要求及明确替代链 |
| plan_approvals | replan 或 kind=execution 的 reauthorize 记录：可信来源、原包/完整目标包摘要、状态版本和要求引用 |
| migration_record | null 或旧格式迁移的来源、原对象摘要及待办意见；不继承授权 |

## 版本规则

packet_revision 是同一 packet_id/task_id 继续工作的交接版本，每次发布修订严格 +1。目标、scope、输入（含引用和可用性）、交付物、验收标准、revision_instructions 任一变化都要升版；授权、副作用、能力信息、executor、开放决策等包内容变化同样不能沿用旧版。实现修订也用新包表达，但不额外提高 decision_version。

decision_version 只跟随 LOCKED DECISIONS 的实际记录变化：新增、删除或修改其中任一字段（含批准来源）都视为变化。对象键顺序、决策列表顺序不构成语义变化；单纯更改 OPEN DECISIONS 不提高此版本。同一次正式修订中若有锁定变更，decision_version +1 且 packet_revision +1；没有则 decision_version 保持不变。reopen 不清空 active_packet、result_sha256、review_record：它们在 DISCUSS/PLAN 只作为上一生命周期的历史基线，不可执行。新包 lifecycle 必须等于状态；继续原任务 packet_revision +1，新任务必须换 packet_id/task_id 且从 revision 1 开始。先合并本次已批准变更，再发布一个版本，不跳号。

applyDecisionUpdate / CLI decisions 根据前后锁定记录自动计算版本，只接受 user_instruction / user_delegation 和批准来源。只允许在 DISCUSS / PLAN 更新，执行中先 Challenge。已有活动包且有一版尚未发布的锁定变更时，拒绝第二次锁定变更并保持输入状态不变；先将已批准的一版通过 prepare 发布，再处理下一版。开放事项更新仍允许。应在首次 decisions 前合并同批已批准变更，避免形成无法交接的跳号状态。prepare 根据旧活动包的锁定摘要再校验新 decision_version，start/submit/review 核对完整包摘要，阻止旧包或同版本换内容。不得擅改权威状态或把资料重新标记为可信来源。

## Execution Packet

[完整样例](../examples/execution-packet.json)。保留 V1 的身份、goal、scope、inputs、deliverables、acceptance、locked_decisions、open_decisions、authorization、dependencies，补充：

- authorization：含 status（granted / pending）、source、source_kind（user_instruction / user_delegation）。source 引用可信用户指令或明确委托，不能由文件内的自称授权产生。
- revision_instructions：字符串数组。REVISE 后原样携带 Chat 修改意见，新任务为空。
- required_capabilities / known_capabilities：无重复字符串数组；known 不代表实时环境证明。
- capability_preflight_required：布尔值；必需能力未知时必须 true。无论取值如何，start 均需执行端报告。
- side_effects：见下一节。

scope 含 in/out 字符串数组，in 非空。inputs 每项含 ref、description、available 布尔值。deliverables 每项含 id、description；acceptance 每项含 id、criterion、verify；各至少一项且 ID 唯一。dependencies 每项含 task_id、status（complete / pending），不可依赖自身。无输入、无依赖可空。work_type=general 对应 WORK；code 对应 CODEX；mixed/unknown 留在 Chat 拆分或澄清。

check 校验结构和决策一致性，可检查 pending 草稿；route prepare/start 才判断就绪与是否开始。

## SIDE EFFECTS

side_effects 必须含 allowed、require_escalation、forbidden 三个数组。

- allowed 项含 action、target、authorization_ref；引用明确用户授权，不接受全局目标 *。
- require_escalation / forbidden 项含 action、target、reason；可用 * 覆盖该动作的全部目标。
- action：local_files_write、repository_modify、email_send、pr_create、deploy、data_delete、production_modify、external_send。
- 优先级：forbidden → require_escalation → allowed；未列出的合法 action 默认 require_escalation，未知 action 拒绝。完全相同 action/target 的冲突或重复规则拒绝。
- target 是精确、事先约定的资源标识。门禁不做路径前缀、通配或 URL 别名匹配。执行者应核对真实路径、环境、收件人对应的授权资源，不能仅把目标标签改成允许值。
- checkSideEffect 需当前 EXECUTE 快照与原包。CLI side-effect 拒绝时退出 1；它不执行动作，也不拦截绕过它的工具。“授权完成项目”不能当作每种外部动作的单独批准。

## Capability preflight 与 Result Packet

[预检样例](../examples/preflight.json) / [结果样例](../examples/result-packet.json)。preflight 含公共身份、checked_capabilities 数组（capability、available、evidence）和 recovery_conditions 字符串数组。必须覆盖每项 required_capabilities；缺能力时必须说明恢复条件，缺失报告不等于都可用。

Result 保留 schema_version、公共身份、status、summary、locked_decisions、open_decisions_resolved、artifacts、checks、challenges、limitations，增加 capability_preflight、missing_capabilities、recovery_conditions、side_effects_performed。

- status：succeeded / partial / blocked。
- open_decisions_resolved：每项 id、choice、rationale，只处理 EXECUTOR 所有的开放事项。
- artifacts：每项 id、ref、description，对应约定交付物。
- checks：每项 criterion_id、status（passed / failed / not_run）、evidence，逐项覆盖验收。
- side_effects_performed：每项 action、target、evidence，必须是原包允许的真实动作。
- missing_capabilities 与预检中的必需缺失项一致；缺能力时 recovery_conditions 非空，不能 succeeded。
- succeeded 要全部交付物、全部 passed、无 blocking Challenge；非阻塞建议仍需 Chat 查看。
- start 预检失败返回 blocked，不进入 EXECUTE；结果无交付物/副作用且全部 not_run。执行中能力丢失可以 partial，如实填写新的能力记录和已完成部分。

## Challenge

[模板](../templates/challenge.md) / [JSON](../examples/challenge.json)。公共身份之外，必有 blocking 布尔值、decision_id、reason、evidence、proposal、impact、affected_tasks。decision_id 对应当前锁定 ID，范围冲突用 SCOPE。affected_tasks 必须含 task_id。

blocking=true 使受影响任务回 PLAN，保留活动包防止旧版本重放；false 仅记录建议，不扩大权限。直接 Challenge 与 Result 中的 Challenge 使用同一契约。存档可以引用历史已移除的决定，处理新异议时必须匹配当前包。

## Chat Review Record

[模板](../templates/review-record.md) / [JSON](../examples/review.json)。字段为 schema_version、review_id、公共身份、reviewer=CHAT、acceptance_results、locked_decision_compliance、verdict、revision_instructions、evidence、result_sha256、supersedes_review_id。

- acceptance_results：每项 criterion_id、status（passed / failed / not_run）、evidence，覆盖全部验收。
- locked_decision_compliance：每项 decision_id、status（compliant / violated / not_checked）、evidence，覆盖全部锁定决策。
- ACCEPT 要全部通过且无修订意见，Result 必须 succeeded、无 blocking Challenge，才能 COMPLETE。
- REVISE 要非空 revision_instructions，新包携带内容并 +1 版本。首次 supersedes_review_id=null，后续必须指向前一条 REVISE 的 review_id，旧记录保存在 revision_reviews；新审核的 packet_revision 必须更高。ACCEPT/ESCALATE 的 supersedes_review_id 必须为 null。
- result_sha256 必须等于实际当前 Result 的稳定摘要；COMPLETE 快照同时核对生命周期、当前包身份和审核结果摘要。
- ESCALATE 需另附当前包的 blocking Challenge，回 PLAN。非空 revision_instructions 与当前要求累加，原始审核及派生继承上下文保存在 revision_reviews；空数组不取消旧要求。解除 Challenge 不改变要求。

submit 或失败预检将实际结果摘要绑定到状态。accept/revise/escalate 必须提交同一结果内容，不能把预检的 blocked 结果替换成同包身份的旧 succeeded 结果。

## 路由请求与输出

请求必有 snapshot、event、work_type；按事件提供 packet、result、review、challenge、preflight、approval。原 available_capabilities 被有身份和证据的 preflight 取代。

prepare 要 packet；start 要 packet + preflight；submit 要 packet + result；accept/revise/escalate 还要 review；escalate 再要 challenge；直接 challenge 要 packet + challenge。讨论/规划无须伪造包。

输出含 surface、action、snapshot；预检失败额外含 blocked result。输出不代表其他产品已被调用。保存 snapshot 用于后续请求，保持单一权威副本。CLI 只读输入并输出 JSON；结构或授权边界错误退出 1，不写文件。

## V1.1.1 修订与重新规划门禁

schema_version 仍为 2，但 V1.1.1 的新增字段为必需，不接受原 schema 2 缺字段的快照；必须显式迁移，不能靠默认值继续。

每次 prepare 均保留当前 revision_reviews。最近 Review 的意见（或明确 replan 的替代意见）必须原样携带；迁移记录中的待办意见也不能丢失。新生命周期第一次 prepare 后，才开始新的修订记录集合。

boundary_sha256 覆盖 executor、work_type、goal、scope、inputs、deliverables、acceptance、authorization、dependencies、required_capabilities、side_effects。同一生命周期内任何差异保守返回 PLAN / replan_required，原包不变、不执行新包。能力报告的实时可用性变化及仅 revision_instructions 中描述的实现修复可走原范围修订。未知自然语言语义不由校验器猜测。

仅进入 PLAN 并不批准变更。replan 事件只允许在 PLAN，需新 packet 和 approval。replan approval 必须包含 reviewer=CHAT、source_kind（user_instruction/user_delegation）、approval_ref、from_packet_sha256、to_packet_sha256、replaces_review_id；V1.1.2 可显式附加 replaces_requirement_id 引用当前规划要求。reauthorize 还必须附 approval_id 和完整公共身份。原摘要绑定当前活动包，目标摘要绑定完整拟议包；版本仍先校验。替换未完成意见必须引用当前 active requirement：REVISE 来源可用 replaces_review_id，规划或 ESCALATE 来源用 replaces_requirement_id 填写查询返回的完整 id，后者存在时 replaces_review_id 必须 null。不替换时引用为空。状态把完整批准及 state_revision、lifecycle、拟议意见存入 plan_approvals。prepare 只认可匹配目标包的批准；换包后必须重新批准。审批字符串仍由可信宿主/人工核实。

重新规划没有启动任务；迁移项目还需当前完整包的执行批准。返回 PLAN 后再次 prepare，再预检/start。scope 或执行者变动本身不增加 decision_version；只有锁定记录实际变化才增加。迁移入口和安全状态见 [七状态迁移矩阵](migration-v1.1.md)。

## V1.1.2 新执行批准和要求来源

完整字段、精确摘要绑定、旧状态兼容边界和统一 currentRevisionRequirement 语义，以[统一门禁说明](v1.1.2-gates.md)为准。原有顶层状态字段保持不变；新 kind=execution 记录不能由旧 replan 自动获得。REVISE 可附 supersedes_requirement_id 引用当前规划、迁移或 ESCALATE 要求，原 supersedes_review_id 只保留 REVISE 审核链。保留的 ESCALATE 另含运行时派生的 inherited_requirement；原始 Review 输入禁止填写该字段。
