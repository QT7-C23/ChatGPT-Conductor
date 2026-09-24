# Result Packet

用于 Work / Codex 回传。自动检查字段见 examples/result-packet.json；示例证据必须换成真实记录。

## 关联

- schema_version：2（V1.1）
- project_id / task_id / packet_id / packet_revision / decision_version / lifecycle：与收到的任务包一致
- executor：WORK 或 CODEX
- status：succeeded / partial / blocked
- 完成情况摘要：

## 实际交付物

| 交付物 ID | 可访问的文件 / 链接 | 内容说明 |
|---|---|---|
| A1 | 填写实际引用 | 填写说明 |

## 验收证据

每个验收 ID 均列一行；没有运行就写 not_run 和原因，不能当作 passed。

| criterion_id | passed / failed / not_run | 检查记录、可定位证据或未运行原因 |
|---|---|---|
| AC1 | 填写真实状态 | 填写证据 |

## 决策遵守情况

- LOCKED DECISIONS：原样回传快照；描述实际成果如何遵守，不能通过抄原值掩盖实际偏离。
- OPEN DECISIONS 已解决项：id、choice、rationale；仅可包含 owner=EXECUTOR 的事项。
- challenges：按 Challenge 模板记录；没有时明确为空数组。
- limitations：尚未完成内容、失败原因、恢复所需条件、真实执行的外部动作。

## 能力与副作用

- capability_preflight：绑定当前包身份，checked_capabilities 每项包含 capability、available、evidence；附 recovery_conditions。
- missing_capabilities：与预检中必需能力的缺失项一致，正常时为空。
- recovery_conditions：失败或受阻时恢复需要什么；能力不足时必须填写。
- side_effects_performed：`{action, target, evidence}[]`，记录真实副作用；没有则为空，不把计划动作写成已完成。

开始前预检失败应为 blocked，交付物与副作用均为空，所有验收 not_run。执行中发现能力不足可以 partial，但必须准确报告已完成成果和恢复条件。

## 回 Chat 的审核请求

请打开交付物，逐项对照验收标准和锁定决策，生成 [Chat Review Record](review-record.md)。只有 ACCEPT 后才 COMPLETE；succeeded 仅表示执行端声明完成。
