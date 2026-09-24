# Challenge / ESCALATION

执行者只能提出异议，不能自行采纳变更。机器字段均必须填写：

```json
{
  "project_id": "demo",
  "task_id": "T1",
  "packet_id": "EP-T1",
  "packet_revision": 1,
  "decision_version": 1,
  "executor": "WORK",
  "lifecycle": 1,
  "blocking": true,
  "decision_id": "D1",
  "reason": "原决策在哪个现实条件下不能成立",
  "evidence": "可核查的文件位置、日志、来源或复现步骤",
  "proposal": "建议变更及可选方案；尚未实施",
  "impact": "对范围、时间、兼容性及验收的实际影响",
  "affected_tasks": ["T1"]
}
```

范围冲突而非某条锁定决策时，decision_id 使用 `SCOPE`。
身份字段原样取自当前包；executor 表示所属执行任务的平台。blocking=true 暂停受影响动作；false 仅记录建议，不授权变更。affected_tasks 必须包含 task_id。旧包 Challenge 不能阻塞其他版本任务。
同时说明已完成内容、停止位置、可独立继续的已授权任务（如有）。
提交给 Chat 讨论；用户或既有授权的负责人决定后，由 Chat 更新记录与任务包。
