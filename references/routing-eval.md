# RoutingEvalRecordV1（M7，离线基础设施）

`scripts/routing-eval.mjs` 是纯本地计算模块。宿主负责核验来源、选择是否采集、运行实际任务、保存必要记录，以及任何后续 Registry 导入；模块不请求模型、网络、quota，不定时运行，不修改项目状态。`tests/fixtures/routing-eval-tasks.json` 是 16 个代表性任务描述（12 个可由当前 Git 对象恢复的问题类型、4 个明确标记的合成边界），没有正确 Tier 答案。它不是模型评测成绩单。

## 记录边界

`passiveShadowRecord` 仅从已有 `RoutingRecommendationV1`、schema-2 Result/Review、可选 `FailureAttributionV1` 和宿主提供的实际执行证据生成紧凑 `RoutingEvalRecordV1`。记录有任务类别和 ID、建议/结果/Review/归因引用、推荐 Tier/reasoning、实际 Tier/reasoning（缺失为 `unknown`）、首轮成功、检查、Review 结论和缺陷、返工/升级次数、执行时间、FRONTIER 实际使用、路由分类及编排开销。没有 hidden chain-of-thought 或用户原始输入。宿主应先按各自现行合同校验 Result/Review，并提供真实、可定位的执行证据；Eval 只核对任务绑定，不重新定义审核合法性。

缺 Result、Review、实际使用或时长时保留 `unknown`/`null`。`first_pass_success=true` 需要 succeeded Result、ACCEPT Review、至少一项通过的检查、零返工；它只证明当前候选能完成当前任务。缺 Eval 数据不会影响 `COMPLETE` 或 schema 2。默认不持续落盘；只有显式 Eval 或已开启的被动采集才由宿主保存所需记录。长期 retention 仍 OPEN。

开销分类为 `no_extra_model_call`、`piggyback`、`dedicated_analysis`、`unknown`。前两类 dedicated calls 为 0；第三类必须由调用者明确给出正数；未知为 null。`usage` 默认 null，仅真实案例且宿主有可定位的 `host_observed` 来源才可记 token 或其他资源数值。合成案例不能记录真实执行时间、FRONTIER 使用或精确 usage。正常用户界面不展示 usage；按需展示时也只能使用宿主实测数据。

## 渐进流程与分类

`progressiveEvalStep` 每次只返回一个候选或 STOP，不运行候选。从调用者选定的最低合理候选开始；已有检查和 Review 足以确认首轮成功时停止。失败先要已有 `FailureAttributionV1`；非 `CAPABILITY_LIMIT` 停止。仅有该归因时，复用 M3 的 reasoning-first 下一步。到 STRONG/HIGH 后默认停止；只有同时给出显式 sparse 批准引用和能力证据引用，才返回 FRONTIER fixture 候选。它仍不是模型切换、资源策略批准或实际使用证据。已稳定的简单类别没有周期性高 Tier 复测机制。

`classifyRoutingOutcome` 只在实际执行与推荐 Tier/reasoning 一致、归因引用匹配，且有能力失败及返工、Review 缺陷或首轮失败时给 `underroute`。`overroute` 要求推荐与实际 Tier 一致，并有同一任务/scope 下至少两份不同结果/Review 引用的、低 Tier 已验收运行；单次低 Tier 成功仍是 `insufficient_evidence`。单次失败也不会写 Registry。样本可比性和来源真实性由后续显式 Eval Review 核验，不能仅由对象结构证明。

`scopedRegistryEvalCandidate` 只为已验收且有实际 Tier 引用的一份结果生成 LOW-confidence、明确 task_class/scope/version/样本引用的候选证据；不修改 Registry、provider facts 或永久 Tier。宿主必须显式审核并导入完整 local snapshot。M6 只在调用时 `eval_scope` 精确匹配时消费 `registry_evidence`，不匹配则不影响解析。合成候选标记 `fixture_only=true`，只用于离线测试，不能冒充真实 calibration。

## 当前限制

这轮只用确定性 fixture 与已有仓库结构证明流程边界；没有真实跨 Tier 对比、FRONTIER 消耗、真实模型映射、成本节省或 Resource Policy 默认值最优性结论。具体预算、采样阈值、可比任务分组、长期 retention 和 live calibration 均待后续显式决定。现有七阶段、schema 2、批准与 Review 门禁不变；没有 `/eval` 用户命令。
