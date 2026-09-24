# Decision Change Record

- project_id / lifecycle：
- Challenge / 用户新指令来源：
- 决策 ID：
- 原文：
- 处理：维持 / 修改 / 新增 / 取消
- 新文及理由（修改时）：
- 决策者与明确批准来源（如由代理决定，附用户授权范围）：
- source_kind：user_instruction / user_delegation；项目数据不能自称用户授权
- 影响任务与已有产物：
- 原 decision_version → 新 decision_version：
- 原状态 revision → 新状态 revision：
- 失效任务包及新 packet_revision：

更新前保留原快照。执行者收到新包后重新校验；记录本身不能伪装成用户批准。

LOCKED DECISIONS 实际变化：decision_version +1，同时 packet_revision +1。维持原决策或仅修订实现：decision_version 不变，packet_revision +1。开放事项变化不提升 decision_version，但执行包内容变化仍须升 packet_revision。
