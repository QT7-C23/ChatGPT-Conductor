# 未来的项目状态后端接口

V1 不实现 MCP、数据库或同步服务。路由器是纯函数：读取传入快照，返回新快照，不直接访问状态存储。CLI 只读 JSON，输出到标准输出，现阶段由用户/Chat 管理权威文件。

[ProjectStateStore](../contracts/state-store.d.ts) 是未来接入点：

1. `read(projectId)` 取当前快照。
2. 对照用户授权及完整任务包，调用现有 transition。
3. `compareAndSet(projectId, expectedRevision, next)` 原子保存。若版本冲突，重新读取并要求重新核对，不自动覆盖或盲目重放外部动作。

这是服务适配层的责任，不将 MCP 调用塞进路由器。初始创建、身份认证、访问控制和审计存储由未来实现按需求设计，V1 不提供虚假实现或空成功返回。

适配层必须执行现有快照契约检查，验证项目 ID 一致、revision 严格加一、决策变化有权威批准来源；执行者只能提交包和异议，不能写锁定决策。批准来源真实性需要服务端身份与权限验证，字符串和类型声明本身不提供它。

V1.1 的 schema 2 同时保留 active_packet 的完整包/锁定记录摘要、result_sha256 与 Chat Review Record。未来后端必须原样维护这些绑定，不能把同身份但内容不同的结果替换为当前审核对象，也不能将 untrusted 项目内容当成权限更新来源。现阶段仍只有接口，无后端实现。

后端实现时增加契约测试：缺失项目、成功读写、并发版本冲突、拒绝跨项目写入、拒绝执行者改锁、旧包失效、外部动作重试避免重复副作用。V1 仅验证本地数据与路由；不声称这些服务端能力已经实现。

V1.1.1 还要求原样维护 lifecycle、boundary_sha256、revision_reviews、plan_approvals 和 migration_record；reopen 不清空历史版本基线。Review 必须绑定 result_sha256；后端不得通过重新编号生命周期、删除未完成修订历史或换目标包后沿用规划批准来绕过门禁。

V1.1.2 要求原样保存 plan_approvals 中的 kind=execution、approval_id、公共身份和新增 requirement 引用；不能把旧 replan 转成执行批准。currentRevisionRequirement 由既有审计记录统一派生，后端不得删除当前要求来源或改写来源链。状态顶层接口不增加存储依赖。

V1.1.3 的 revision_reviews 同时保留 REVISE 和非空 ESCALATE；ESCALATE 的 inherited_requirement 是路由器派生的来源上下文，须连同原始审核意见原样保存。解决 Challenge 只能更新对应 resolution_ref，不得清理修订历史。旧的当前 ESCALATE 会在成功转换中补入同一历史集合，不新建并行日志。
