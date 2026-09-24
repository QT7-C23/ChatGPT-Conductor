# schema 1 / 原 schema 2 → V1.1.1 加固契约

V1.1.1 使用 schema_version=2 的加固字段集。新增 lifecycle、修订历史和明确批准记录是必需字段，旧 V1.1 的 schema 2 不能直接使用，也不自动补默认值。本工具仅接受没有 lifecycle 的 schema 1 / 原 schema 2；已带 lifecycle 的状态不得再次导入以重置版本。

迁移不执行工作、不派发、不发放权限，也不制造 ACCEPT。必须先保留原 ZIP、状态、packet、result、review、产物与副作用清单。所有无法确认的内容都应阻塞，不靠猜测补齐。

## 七种原状态的处理

“可直接”仅指字段与可信来源齐全后可做数据转换，不代表直接执行。

| 原状态 | 可直接转换？ | 安全目标 | 必需材料 / 确认 | 原 packet / result / review 的处理 |
|---|---|---|---|---|
| DISCUSS | 无活动包时可以 | DISCUSS | 原状态、批准来源、证据位置、已核对的待办修订数组 | 没有活动对象时不得偷偷附加旧任务产物 |
| PLAN | 无活动包时可以；有活动包则先核对停机和副作用 | PLAN | 同上；有活动包时还需原包及其摘要匹配 | 保留活动包版本基线，不继承执行授权 |
| READY_TO_EXECUTE | 先撤销旧交接资格 | PLAN | 原包、已停止接收/执行的确认、副作用核对、修订要求 | 旧包及预检失效，重新批准新包并预检 |
| EXECUTE | 不允许直接继续执行 | PLAN | 明确停止执行者，核对已经发生/结果未知的动作，原包与已有 result（如有） | 原包及预检失效；已产生文件只读保留；未知是否完成的外部动作未核清前阻塞 |
| REVIEW | 不允许继承待审核对象的有效性 | PLAN | 原包、真实 result、副作用核对、批准与证据位置 | result 保留为历史证据；必须另发核验/剩余工作新包并生成当前 result 和 Review |
| REVISE | 不允许无条件清空修订意见 | PLAN | 原包、result、旧 review、非空且明确核对的 pending_revision_instructions | 保留待办意见，原 result/review 失效为历史；新包和重复 prepare 仍必须携带这些意见 |
| COMPLETE | 不允许保留新契约下的 COMPLETE 资格 | PLAN | 原包、result、旧批准记录、已发生动作核对 | 保留旧完成事实及审核摘要；不转换为新 ACCEPT；如需新契约认可，应只核验已有成果，不重做已完成副作用 |

有未完成或无法映射的旧 escalations 时工具返回 blocked，先由 Chat 处理、归档、核对权威状态，不自动删除异议。缺原包、摘要不匹配、项目/任务/版本不一致、执行者未停妥、副作用未核清、待办意见未知、REVIEW/REVISE/COMPLETE 缺 result、REVISE/COMPLETE 缺 review，都停止迁移且不返回新快照。

## 可执行的迁移入口

`node scripts/cli.mjs migrate migration-request.json` 只读输入、输出 JSON。成功返回 `status=migrated` 与安全快照；失败返回 `status=blocked` 和 reasons，退出码 1，不返回可执行快照。没有自动写盘或重跑业务动作。

请求包含且仅包含：

- snapshot：原权威状态，不预先手改 schema 或版本。
- packet：原活动包；没有活动包则 null。
- result：原结果；尚无结果才可 null。REVIEW/REVISE/COMPLETE 必填。
- review：历史审核；REVISE/COMPLETE 必填，其余有则保留。
- confirmation：source_kind、approval_ref、executor_stopped、effects_reconciled、evidence_ref、pending_revision_instructions。

confirmation.source_kind 只能是 user_instruction / user_delegation；两个确认字段为布尔值。pending_revision_instructions 是经过 Chat 核对的字符串数组，没有待办才明确填 []；不能因旧格式没有字段就猜为空。REVISE 必须非空；有原审核意见时严格一致，原 schema 2 活动包已有意见也不得丢失。evidence_ref 指向保留的旧文件与动作核对记录。工具只能核对声明和一致性，不能认证来源或替执行者查明远程动作。

参见 [完整请求样例](../examples/migration-request.json)。示例是合成数据，不能代替真实迁移批准。

## 新快照和新对象

1. schema_version=2；原 project_id、锁定/开放决策和 decision_version 保持不变；revision +1。
2. 将没有生命周期字段的旧基线显式归为 lifecycle=1，新生命周期固定为 2。只接受旧格式首次迁移；禁止把已有生命周期重新编号。原活动包 identity、packet_revision 和原内容摘要保留在 active_packet 作为不可执行的历史基线。
3. 当前 review_record / result_sha256 为 null；旧 result/review 的 SHA-256 进入 migration_record，原文件不修改。revision_reviews、plan_approvals 初始化为空；migration_record 保存原状态、来源、目标生命周期和明确核对的待办修订要求。
4. 当前 schema 2 的 packet、result、preflight、Challenge、Review 都必须含 lifecycle。相同 packet_id/task_id 继续工作时，新 packet_revision=旧值+1；新任务使用新 packet_id/task_id 且 packet_revision=1。目标和范围由 Chat 明确确定，不能直接复制旧授权当作新授权。
5. 新 Execution Packet 必须重新填写 authorization.source_kind、完整授权、side_effects、required/known capabilities、capability_preflight_required、revision_instructions。未知权限不放 allowed，未知能力要求预检；全新的 preflight 绑定新生命周期与新版本。
6. 保留已完成成果作为 inputs。对原 REVIEW/COMPLETE，优先发布“只核验已有产物”的新任务，side_effects.allowed 可为空；不要把 prepare/start 解释为重跑原部署、邮件或删除。新的 result 记录真实核验，新 Review.result_sha256 绑定它。
7. 迁移带来的待办意见在新包和后续 prepare 中保持有效。若需要撤销/替换这些意见，先完成当前核验并由 Chat 出具当前生命周期的新 REVISE Review；此后才按明确的 supersedes / replan 规则变更，禁止仅通过迁移清空。

迁移本身不使 decision_version 增加。LOCKED DECISIONS 真正变化时，在迁移后的 PLAN 走现有 decisions 入口并签发相应新包；不要把锁定变更夹进格式转换。完整行为测试见 [migration.test.mjs](../tests/migration.test.mjs)。

## V1.1.2 必须重新批准执行

迁移仍只生成安全状态，但 authorization_inherited=false 已有实际后续门禁。不能只复制旧 authorization/side_effects 并修改版本恢复执行。迁移项目每个拟议包必须在 PLAN 通过 reauthorize 获取 kind=execution 批准，绑定 approval_id、可信来源、公共身份和完整包摘要；prepare/start/submit/accept/checkSideEffect 都限制旧授权路径。完整步骤和 V1.1.1 已有生命周期状态的处理见 [V1.1.2 门禁](v1.1.2-gates.md)。
