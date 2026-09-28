# V1.3.0 候选变更

2026-09-28：将新增分发与单维护者发布能力的当前候选标为 1.3.0；同步 package/Skill 元数据、候选 ZIP、发布校验、管理器身份和相关测试。README 新增英文介绍、使用与安装说明，并明确候选版本与精确 tag 保护的区别。数据 schema 2、`po-1.1.3` profile、依赖版本和 V1.1.3 历史夹具保持不变。

发布接入改为专用 GitHub App：只为 prepare/publish 签发 Contents:write 短期 token，其余发布任务显式请求只读权限；内置 GITHUB_TOKEN 均只读。预检准确读取 main ruleset、四个 GitHub Actions 检查和零审批 PR 规则，拒绝管理员绕过审批环境；新增只读配置预检报告，缺失 bypass 信息保持 UNKNOWN。创建 tag 和发布前复核当前 main HEAD 及完整 CI。

修复配置预检的仓库根 API 地址，避免结尾斜杠导致 404；新增不含敏感信息的读取失败与缺失 bypass 诊断，UNKNOWN 仍不能通过发布门禁。

本次版本调整不构成发布。现有 `v1.2.0` tag 保护继续保留，已新增仅保护 `v1.3.0` 的创建及不可变规则，并启用仓库 Release 不可变保护。publisher 认证及证据公开许可已确认，完整 Preflight 和两阶段 owner approval 仍须完成。

## 保留的 V1.2.0 候选记录

ChatGPT Conductor 增加独立分发 CLI、精确 Release 身份与批准绑定、安装/更新/回滚/显式旧数据迁移和离线恢复。V1.1.3 公共合同与旧 CLI 字节保持不变；普通软件升级不重写项目数据。运行器留在 Skill 目录之外。

本地候选包不是已发布 GitHub Release。项目采用 MIT；发布导出补充 LICENSE、第三方许可说明和实际载荷许可回归检查。跨平台与真实发布验收留待 M8。

V1.2.0 发布前 P1 修订：recover 不再凭 journal 终态释放锁。重新校验批准、事务、snapshot、认证代码清单、登记、manager 与项目数据；可证明时完成或恢复，否则保留恢复证据及锁。无锁历史事务仅校验、不补偿；后续项目写入使原终态无法证明时返回 recovery_required，不回退新数据。本地状态仍为 REVIEW，未执行 M8。
