# M9 — Output Completeness & Truncation Recovery

状态：实现完成后交主 Chat REVIEW；本记录不构成 ACCEPT 或功能 checkpoint。工作目录仅 D:\Project\ChatGPT-Conductor。开始前 fetch 与实时 ls-remote 均成功：HEAD/upstream/origin 开发分支为 90c3d59c3b1bfcba0cddf0f82a6050ad48567ffa；main/origin/main/实时 main 为 2f0e608a448dd17d0631e823f06e63f889c7b0a9；工作树干净、分叉计数 0/0。

## 实现与范围

- [生产模块](../../scripts/delivery-manifest.mjs)：一个清晰的本地模块，正式 DeliveryManifestV1 validator、按章节主动分块、事件校验/完整性判断、缺段恢复、内容批准及失效检查。复用现有 canonical resultDigest，无新依赖，不调用 M1 spike。
- [唯一运行规则引用](../../references/output-completeness.md)：合同、heuristic budget、事件来源/宿主边界、自然语言恢复、批准范围、按需 persistence 与失败隔离。Skill/workflow/contracts 只引用并简述边界，不复制第二套规则。
- Workshop 的 createProductBrief 接入当前正文绑定：长输出不能靠 deliveryComplete=true 转 ready；缺失/残缺/无独立确认则 draft、decision_ready=false。既有已独立批准的历史决定可引用；不能从此 draft 推导新决定或执行权。短 Brief 保留原有路径。
- Router 的 compactRecommendation 不进入 delivery planning；新的包外 prepareRoutingExplanation 仅在显式 extended 且实际达到阈值时规划长解释，不重评/重签 Recommendation 或 Packet。
- 统一 verify 接入正式测试；精确产品文件清单及 .gitattributes 字节保留规则同步纳入模块、reference、测试与 fixture，避免打包后缺 import 或 Git 改写摘要绑定字节。未运行候选 Release/M8 工作流。

## 关键语义与复杂度

普通短输出返回 null manifest，零 hash/marker/persistence。默认长阈值为 12,000 个规范化字符或 24 章节；每 Part 最多 12 章节、6,000 字符 heuristic budget（计入真实段 marker，另留 512 framing/final-marker 字符）。这些不是 token 保证或实测宿主限额。过大单章节标 oversize，不破坏语义；需作者形成更小语义章节和新计划。

manifest 只存 identity/digests/边界/预算，不复制正文。每 section 一个稳定 Segment，Part 汇总有序 Segment，计划摘要绑定全部内容 identity 和 revision。只规范化 CRLF→LF；内容、顺序、边界、修订变化使旧批准 scope 失效。来源真实性与事件先后仍由可信宿主核实。

planned、delivered、confirmed 独立。完整性必须有全部段的匹配内容与精确段 marker，加交付之后的精确 artifact marker。缺 part 为 incomplete；全正文缺 marker 为 unknown/complete=false。仅本地实际 emission+marker 可建立 local complete，但 UI visibility 仍 unknown；内容批准要求 host/user 独立 receipt，不产生 Packet、side-effect 或 Review authorization。

截断报告使受影响 Part 的当前/后续 Segment incomplete，清除旧 artifact marker；旧 receipt 的精确重放不能撤销报告。恢复只返回缺失 Segment，保留已确认/已收到正文及后续可靠 Part。全部正文已齐但缺 marker 时仅补标记。显式请求 Part 不能跳过更早缺口。已批准 Part1/2 不覆盖 Part3/4；没有精确可见 referent 的“可以”返回 ambiguous_scope。

持久化由宿主按真实长交付/跨会话需要在既有显式交接路径保存；模块没有文件写入器、数据库、journal 或 telemetry。JSON snapshot可跨会话核验；源正文缺失就 recovery unavailable，不猜。损坏/缺失只影响 delivery recovery，不将 schema-2 project-state 判 corrupted，不改 migration/recovery、生命周期、版本或执行门禁。

## 事故抽象 fixture

[fixture](../../tests/fixtures/delivery-incident.json) 标明 abstracted_real_incident；不是原始 Spec 全文，不声称重现平台 UI。构造四 Part Architecture Spec，160 sections、40/Part：

1. §1–60 已 confirmed，Part2 在 §61 中断：resume_from=Part2 / segment-section-61 / section-61；pending=100；不包含 Part1。
2. 后续 Parts 已可靠收到再报告 Part2 在 §61 截断：只补 §61–80（20 Segments），保留 Part1/3/4；必须重新观察 final marker。
3. 仅 Part1/2 已确认/内容批准，Part3 尚未交付：批准 Part4 被拒；后续含糊“可以”被拒为 ambiguous_scope，现有 scope 仍仅 Part1/2。

## 验证

执行前统一基线：473/473，退出码 0。

正式 [M9 测试](../../tests/delivery-manifest.test.mjs) 27 项，覆盖 A–M、内容/marker/来源不匹配、旧证据重放、阈值、预算含 marker、host receipt ≠ approval、JSON round trip。

聚焦 M9 + Workshop + Adaptive Router + Integration：66/66；M9 + Package + M1 Spike：63/63（含 M1 Spike 25）。最终统一 node scripts/verify.mjs：500/500，0 failed / skipped / cancelled，退出码 0，耗时 421,516 ms。M1 Spike 25/25 通过；git diff --check 通过。首次全量为 499/500，检出了四个新增产品文件尚未同步字节保留规则的遗漏；同步 .gitattributes 后既有门禁不变，修复后的聚焦门禁 63/63 与末次全量 500/500 均通过。日志保存在忽略的 work/m9-verify.log、work/m9-focused-final.log、work/m9-verify-final.log。

## Host limitation、未实现与 OPEN

没有真实 UI 截断检测接口；不能从“回复结束”推断可见性。没有平台精确 token 预算、真实消息运输/显示验证、宿主并发/原子保存实现、自动执行或自然语言 parser 服务。自然语言由 Skill/已有宿主解释后接入公开纯 helper。

无模型/网络/watcher/synthetic usage 调用；没有 Live Calibration、MCP server、Release/M8、schema3、新 lifecycle、新依赖或版本号决定。M10/M11 与 M9 是否合并 checkpoint 仍由主 Chat 决定，宿主能力/真实 UI 行为的验证仍 OPEN；本轮无设计 blocker，无需回 PLAN。

未 commit/push/tag/PR，无暂存改动；最终工作树为 12 个已跟踪文件修改 + 5 个新增文件（17 路径），均属 M9。HEAD/upstream 仍为 90c3d59c3b1bfcba0cddf0f82a6050ad48567ffa，main/origin/main 仍为 2f0e608a448dd17d0631e823f06e63f889c7b0a9，工作树留供主 Chat REVIEW。最终 diff 已逐项复核，含新增文件。

补充行为对照：同一长 Brief + deliveryComplete=true 输入在基线 HEAD 的 createProductBrief 返回 ready；M9 返回 draft。该对照读取真实 Git 基线模块，不修改历史源码。
