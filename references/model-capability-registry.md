# ModelCapabilityRegistryV1（M6）

`contracts/model-capabilities.v1.json` 是随产品分发的离线 baseline。首版故意为空：真实模型事实须在需要映射时查官方/第一手资料并完成来源核验，不能由模型名称猜 Tier。合同版本 `version: 1` 与 `registry_version` 独立于 Conductor 核心版本。M6 测试只用 `synthetic.*` 条目。

## 三层事实与最小合同

- **Provider/Primary Evidence**：快照 entry 的稳定 `id`、`provider_family`、`host_family` 及 `provider_facts`。后者记录 Tier（含 `unknown`）、reasoning semantic support（`supported/unsupported/unknown`）、能力标签、来源引用、`verified_at`、`valid_until`、定性 confidence。已知能力必须有来源引用；未知事实可用空引用和 null 时间。来源真实性由导入者核对，validator 只管结构。
- **Conductor Eval Evidence**：每个 entry 的 `eval_evidence[]` 记录独立 ref、适用 scope、观测的 Tier/reasoning/capabilities、观测及失效时间、confidence。它是未来 M7/Shadow Eval 的证据槽，不覆盖 provider 声明。M6 不产生真实 Eval 结论。
- **Runtime Overlay**：`ModelRuntimeOverlayV1` 只在调用时传入，绑定 `host_session`。每项须有当前来源、观测与失效时间；可报告 `available`、`selectable`、`reasoning_control`、`switching_support`，以及可读 quota。四项支持 `true/false/unknown`。quota 不可读时 `readable` 为 false/unknown，`remaining` 与 `unit` 必须为 null；不能把它写入静态快照。selected/actually_used 需另有宿主执行证据，overlay 不接受这两个字段。

所有对象拒绝未知键，因此 provider/eval 不能塞 runtime、授权、side effects 或治理状态，overlay 不能塞 provider/eval。Eval 证据可提示冲突或降低信心，但不能假扮官方声明。Registry 是能力映射附件，不是 Packet/project-state 的字段。

## 读取、时效与解析

只有显式传入且精确匹配 `eval_scope` 的 Eval 证据参与解析；其他 scope 的评测仍可保留在快照中，但不能影响本次候选判断。

`loadRegistry({baseline, local, selected, expected_local_digest})` 校验 bundled baseline 和显式提供的完整 local snapshot；选择 local 时必须核对 SHA-256 摘要。local 是**整版替换**，没有按字段混合或自动回退；选定版本损坏即报错。结果保存 baseline、local、所选快照的 ID、独立版本和 digest，可在后续 checkpoint 重用；宿主应在快照变化时更新 M3 `basis.registry_evidence_digest`。新增 Registry 不要求旧 schema-2 Packet 或推荐补字段。

实际文件读取、可信来源核验及用户显式导入由宿主负责。候选持久位置为安装包内的 bundled 文件和安装目录外的 `user_data_root/model-capabilities.v1.json`；用户数据不写安装目录、分发内部状态或 project-state。宿主须按现有路径安全边界读取，选中损坏文件时报告错误，不默默用 baseline。M6 提供纯对象读取/校验/摘要边界，没有导入 CLI、更新事务、网络下载或文件 watcher。

`resolveRoutingCandidates` 将 M3 的抽象 tier/reasoning 与已加载快照、调用时的 runtime overlay、显式 `now` 映射到候选；不改推荐、Packet、授权或状态。时间与会话不匹配、缺少来源/到期时间或过期的 runtime 一律视为 unknown。静态证据过期保留原条目并返回 `refresh_needed` 和原因；宿主未来可按需 Research-on-Demand，M6 不自动刷新。低信心、无匹配、unknown Tier、已知冲突返回 unresolved；不会制造 FRONTIER 候选。当前可选要求 runtime 确认为 available 且 selectable；需要高于 LOW 的 reasoning 时还要求实际 reasoning control。resolved 只是当前候选观察，不证明已选择或使用。

M4 的实际 availability、reasoning、switching 和独立批准门禁优先于静态 Registry。M4 `ResourceDecisionV1` 仍由可信宿主 runtime 输入决定是否允许动作；Registry 解析不能授予 `auto_route_authorized` 或 FRONTIER 批准，FRONTIER approved 也不推出 available/selected/actually_used。M5 的 `REGISTRY_STALE`、`REGISTRY_UNKNOWN` 和 `MODEL_UNAVAILABLE` 信号不形成 CAPABILITY_LIMIT；前两者保留未知，后一者属环境/运行能力问题。

全部核心函数本地确定性运行，无网络、额外模型调用、后台刷新或每任务更新要求。可选未来 provider boundary 仅为宿主提供 baseline/local snapshot、runtime observation、按需 refresh request；当前 Skill 路径无需 MCP/server/backend/API client。
