# ResourcePolicyV1（M4）

`scripts/resource-policy.mjs` 提供纯本地的 `resolveResourcePolicy`、`reasonableCapabilityRange`、`decideResourceRouting`。宿主传入已解析的配置、M3 `RoutingRecommendationV1`、已核实的 runtime facts；模块不读写配置文件、不查询额度、不调用模型、不切换模型、不修改 Packet 或 ProjectState。

## 配置与优先级

`ResourcePolicyV1` 有 `contract=ResourcePolicyV1`、`version=1` 和四个策略字段：`resource_mode`（`economy | balanced | quality_first`）、`reserve_frontier`、`auto_escalate_reasoning`、`auto_escalate_model`（后三者均为布尔）。基准必须包含全部字段；user-default、project-override、task-instruction 只覆盖显式出现的字段，`false` 不丢失。缺失层用 `null`；存在但版本错误、未知字段、`null` 值或类型错误则拒绝，不降级成默认值。结果逐字段保留来源，原层不改写。宿主负责验证 task-instruction 确实来自当前任务用户指令，项目配置不能伪装成任务指令。

默认参数是**候选默认，VALIDATION REQUIRED**：`balanced`、`reserve_frontier=true`、`auto_escalate_reasoning=true`、`auto_escalate_model=false`。M7 Eval 可调整，不宣称已验证最优；宿主可显式传入另一完整基准。配置不是任务执行授权。消费优先级为 Safety/Governance > 已核实的 runtime capability > 当前任务显式用户指令 > project-override > user-default > candidate default；前两项是门禁，不会被后面的偏好覆盖。

## 推荐与动作边界

M3 推荐的 Tier 是可靠性下限。FAST 的合理区间为 FAST–BALANCED，BALANCED 为 BALANCED–STRONG，STRONG 与 FRONTIER 仅为自身。`economy` 和 `balanced` 取下限，`quality_first` 取上限；Mode 不直接等于 Tier，也不能降低 STRONG 或凭偏好制造 FRONTIER。具体区间仍需 M7 行为评测。

`decideResourceRouting` 接受准确的 M3 推荐、已解析策略、宿主本次 runtime facts（当前 Tier/reasoning、每个 Tier 的 `available | unavailable | unknown`、切换支持、reasoning 调整支持、自动路由授权）。`unknown` 不等于可用。`AUTO_ROUTE_ALLOWED` 仅表示在非 FRONTIER、向上跨 Tier、策略开启、宿主已证实可用且切换受支持，并且自动路由已授权时，可由未来 adapter 考虑执行；M4 本身从不执行。`auto_escalate_model=false` 的跨 Tier 结果为 `RECOMMEND_ONLY`。Reasoning 只在策略开启且宿主确认可调整时返回 `AUTO_ADJUST_ALLOWED`，仍不声称已调整。宿主不可把这些动作提示当作独立授权或实际执行记录。

## FRONTIER 状态与治理

`frontier.recommended` 来自 M3 经证据引用校验的推荐；`approved` 仅来自宿主核实的显式批准记录，记录须绑定本次 `recommendation_id`、FRONTIER、`select_model` 操作、资源边界与可信批准引用。引用的真实性由宿主验证。`available` 仅来自宿主实时事实；`selected` 与 `actually_used` 在 M4 始终为 `unknown`，直到未来 adapter 有独立执行证据。每一项都不能推出下一项。FRONTIER 默认需要显式批准；`auto_escalate_model=true` 或 `reserve_frontier=false` 也不使其自动路由。`reserve_frontier` 是是否保留稀缺资源的策略标记，不是批准开关。批准不授予 Packet side effects，不修改 authorization、required_capabilities、七阶段或 `schema_version=2`。

正常紧凑输出沿用 M3 `compactRecommendation`；M4 decision 不包含 token、usage、quota 或精确费用。按需询问真实用量时，宿主只能展示有来源的数据；不可读取即 `unknown`，不能合成数字。此模块不实现 quota API、Registry、模型映射、Failure Attribution、Eval 或新 CLI。策略变动应更新 M3 `basis.policy_digest` 后重新判断继承适用性。
