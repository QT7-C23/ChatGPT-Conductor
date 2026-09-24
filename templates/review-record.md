# Chat Review Record / V1.1

由 Chat 在打开真实交付物、核对验收与决策后生成。执行者的 succeeded 不构成此记录。JSON 范例见 [review.json](../examples/review.json)。

- schema_version：2
- review_id：独立且可引用的审核标识
- project_id / task_id / packet_id / packet_revision / decision_version / executor / lifecycle：与当前执行包完全一致
- reviewer：CHAT
- result_sha256：实际本次 Result 的稳定 SHA-256，不能沿用别的结果
- supersedes_review_id：首次 REVISE 为 null；替代前一条 REVISE 时填写其 review_id；ACCEPT / ESCALATE 必须 null
- supersedes_requirement_id：当前约束来自规划批准或迁移时，REVISE 必须显式填写 currentRevisionRequirement 返回的 id；ACCEPT / ESCALATE 不提供此字段。它不替代 supersedes_review_id 对原审核链的记录。
- verdict：ACCEPT / REVISE / ESCALATE
- evidence：本次审核实际查看了哪些成果与记录；不能只写“通过”

## acceptance_results

| criterion_id | status: passed / failed / not_run | evidence |
|---|---|---|
| AC1 | 实际状态 | 文件位置、检查记录或未检查原因 |

覆盖全部验收 ID，不得靠删除失败项取得通过。

## locked_decision_compliance

| decision_id | status: compliant / violated / not_checked | evidence |
|---|---|---|
| D1 | 实际状态 | 实际产物如何遵守或违反决策 |

覆盖全部锁定决策；没有锁定决策才可用空数组。

## revision_instructions

列出可执行的修改意见（字符串数组）。REVISE 必填，ACCEPT 必须为空。ESCALATE 可以为空；非空时新增意见与当前有效要求累加，不能默认替换旧意见。新任务包及重复 prepare 携带完整当前要求，packet_revision 加一；仅实现修订时 decision_version 不变。

原始 Review 不填写 inherited_requirement；路由器在保留的 ESCALATE 历史中派生该上下文，原始意见不改写。supersedes_review_id 继续指向上一条 REVISE；若当前要求来自 ESCALATE，后续 REVISE 另用 supersedes_requirement_id 填写 currentRevisionRequirement 返回的完整 id（review-esc:<原始审核稳定摘要>），不要从 review_id 手工拼接。Challenge resolution_ref 仅处理阻塞，不处置修订要求。

## 结论处理

- ACCEPT：全部验收 passed、决策 compliant、执行结果 succeeded 且无 blocking Challenge，才能 COMPLETE。
- 当前 ACCEPT 同时明确完成本生命周期的修订要求，保留原要求来源用于审计；迁移项目还必须有对应完整包的有效执行批准。
- REVISE：回原执行者，生成新包后重新预检、执行、回传及审核。
- ESCALATE：附绑定当前任务的 blocking Challenge，返回 PLAN，不自行改变锁定决策。
