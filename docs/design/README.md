# 设计文档导航

本目录收录仓库设计资料；下一功能版 Spec 不代表当前已实现或已发布。

- [下一功能版：Product Workshop + Adaptive Model Router](next-product-workshop-router.md)：M0 固化的已接受架构、开放项、验收标准与实施分解。
- [M1 Contract & UX Spike](m1-contract-ux-spike.md)：已由主 Chat ACCEPT 的合同强度、存储和交付边界、最小命令与隔离原型。
- [M2 Product Workshop 运行规则](../../references/workshop.md)：触发、发现、按需调研、Brief 和交接边界。
- [M3–M5 Router Core](../../references/adaptive-router.md)、[Resource Policy](../../references/resource-policy.md)、[Failure Attribution](../../references/failure-attribution.md)：能力、风险、reasoning-first、批准与失败边界。
- [M6 Registry](../../references/model-capability-registry.md)、[M7 Eval](../../references/routing-eval.md)、[M8 Integration 回归](../../tests/integration-regression.test.mjs)：离线事实与既有治理的集成。
- [M10 用户入口](../../README.md#先用起来)：自然语言帮助、能力说明与五个例子；[M10/M11 回归](../../tests/docs-readiness.test.mjs)。
- [M11 MCP Readiness](../../references/mcp-readiness.md)：最小可选 adapter 合同，复用已有 validator，无生产 adapter/server/backend。
- [M9 Output Completeness](m9-output-completeness.md)：正式交付合同、事故 fixture、批准范围及宿主限制；主 Chat 已 ACCEPT，未 checkpoint，原执行记录保留。
- [分发、批准与恢复](distribution.md)：现有分发接口设计；历史状态以最新审核证据为准。
- [Release workflow](release-process.md)：既有发布流程与尚需真实验证的门禁。

M0 Spec 与 M1 Spike 保留当时的候选/OPEN 和验证记录；当前使用与命令说明以 README/SKILL 及运行 references 为准，不把历史候选当已实现命令。运行 reference 与正式回归随精确候选清单分发；设计资料不等于 release，发布与版本决定仍由主 Chat/所有者处理。
