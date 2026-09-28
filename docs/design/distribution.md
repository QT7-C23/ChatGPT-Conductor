# ChatGPT Conductor 分发、批准与恢复

本页是 V1.2.0 分发接口。原 `scripts/cli.mjs` 与项目工作流规则保持原样，参见 [README](../../README.md)。分发批准从不授予任务执行权；ExecutionApproval、Chat Review 和生命周期门禁继续独立生效。

## 当前交付边界

本地 candidate ZIP 不是可安装的 GitHub Release。生产入口仅接受 `github.com/QT7-C23/ChatGPT-Conductor`，仓库 ID `1382745738`；要求精确 Release ID、不可变、非 draft、tag 解引用 commit、发布与每个资产的 GitHub attestation 和原始字节 SHA-256 均通过。不使用 main、latest、自动源码压缩包或任意本地 ZIP。无静默升级，无自动清理。

本地验收平台是 Windows x64 / Node 24；Node 22 与 Linux x64 是声明的运行目标，真实跨平台、实际 GitHub 发布及 M8 验收仍待完成。项目许可证为 MIT；发布证据公开范围及远端发布保护仍须所有者明确配置并预检。

需要 Node 22 或 24，以及真正支持 `gh release verify` / `gh release verify-asset` 的 GitHub CLI。只比较 gh 版本号不足以证明能力。默认解析绝对 host PATH 中的 gh，排除空/相对项和当前目录，按绝对路径从其安装目录运行；不接受 `--gh-bin`、环境测试开关或 manifest 中的命令。发布凭据不会传入候选 verify 子进程。

## V1.2.0 单维护者发布授权

长期发布模型是一位维护者负责审批。无须独立第二 GitHub reviewer；main 的保护目标是禁止 force push/删除、要求 Linux/Windows × Node 22/24 四矩阵 CI，并让日常开发走 feature branch/PR。实际 branch protection 仍是 UNKNOWN，后续需只读预检或人工核对。

发布前 Release Preflight 对每个门禁输出 READY、BLOCKED 或 UNKNOWN。任何已失败的检查为 BLOCKED；branch protection、immutable release 计划/API、attestation verifier 支持等读取不到或尚未证实为 UNKNOWN；只有完整正面证据才是 READY。这里检查的是 attestation 验证能力，不检查尚未发布、尚未生成的 release attestation。UNKNOWN 与 BLOCKED 都停止 Publish。

两次 owner approval 使用一个 `release-approval` 环境：批准候选包后只允许创建 Draft；核验精确 Draft Release ID、tag→commit、manifest、四项资产字节和所有哈希后，再由同一 owner 单独批准 Publish。approval artifact 必须来自受保护 GitHub workflow，并按 run ID、artifact ID 与 archive SHA-256 取回。第一次绑定完整 build evidence、source commit、candidate inventory 和 payload/changelog；第二次另绑定精确 draft ID、candidate evidence、四项资产 SHA-256，以及不同的 ACCEPT 和 Publish 引用。仓库里的文字或普通 JSON 字段无法产生 artifact。tag 只能创建一次；发布步骤还要求目标仍是该精确 Draft，因此不同版本或已发布资产不能通过重放审批。

发布授权只许可该 Release 生命周期动作，不授予任何项目任务的 ExecutionApproval 或 side effect 权限。Chat Review 可作为工程审核证据，但不能代替 GitHub actor 身份。旧 V1.2.0 approval packet 仍使用 schema 1；迁移时重新生成两次 owner approval。helper 仍要求当前 allowlist 恰好只有一个 owner，旧 artifact 只有在当前 owner 身份、远端环境和全部精确身份/摘要验证均通过时才可用，不会被自动升级为新的授权。

发布后状态只有在精确 release identity、全部资产字节及 release/asset attestation 均验证通过时才是 `VERIFIED`。已确认发布但任一检查失败或无法验证时为 `PUBLISHED_UNVERIFIED`，且 `installable=false`；已知摘要/身份不匹配对应 verification=`BLOCKED`，读取或验证服务不可用对应 verification=`UNKNOWN`。无法确认是否已发布时为 `PUBLICATION_UNKNOWN`，仍不可安装；仍是 Draft 时为 `NOT_PUBLISHED`。Release 可能已经公开且不可变，失败时只报告并阻止使用，不自动覆盖或替换资产；修复暂时性验证故障后可重跑 verify。

`PUBLISHED_UNVERIFIED` 禁止 install、update 和 rollback 把该 Release 当作目标。分发源即使在列表中发现它，也必须先通过 `authenticateRelease` 的精确 Release、资产及 attestation 验证才能形成 authenticated bundle；失败不产生可安装 bundle。即使发布 workflow 的验证结果丢失，客户端仍执行这道认证门禁。

## 首次安全引导

首次下载不能先执行包内代码再信任它。使用已受信任的本机 gh；Windows 示例明确选安装位置，不能在下载目录调用裸 `gh`。先检查此路径确属已安装的 GitHub CLI。

```powershell
$gh = 'C:\Program Files\GitHub CLI\gh.exe'
& $gh api repos/QT7-C23/ChatGPT-Conductor
& $gh api repos/QT7-C23/ChatGPT-Conductor/releases/实际数字ID
& $gh release verify v1.2.0 --repo github.com/QT7-C23/ChatGPT-Conductor --format json
& $gh release download v1.2.0 --repo github.com/QT7-C23/ChatGPT-Conductor --pattern release-manifest.json --pattern CHANGELOG.md --pattern chatgpt-conductor-1.2.0.zip --pattern SHA256SUMS --dir C:\ConductorBootstrap\exact-release
& $gh release verify-asset v1.2.0 C:\ConductorBootstrap\exact-release\release-manifest.json --repo github.com/QT7-C23/ChatGPT-Conductor --format json
& $gh release verify-asset v1.2.0 C:\ConductorBootstrap\exact-release\CHANGELOG.md --repo github.com/QT7-C23/ChatGPT-Conductor --format json
& $gh release verify-asset v1.2.0 C:\ConductorBootstrap\exact-release\chatgpt-conductor-1.2.0.zip --repo github.com/QT7-C23/ChatGPT-Conductor --format json
```

这些命令中的 ID/tag 必须来自该次精确发布。继续前人工/可信宿主核对仓库 ID、Release ID、`immutable=true`、`draft=false`、tag 和解引用 commit；把 manifest 的 release/source_commit/版本与 API 对照。核对 ZIP 和 changelog 原始字节长度与 SHA-256；SHA256SUMS 是便利索引，不能代替受认证 manifest。任何命令失败就停止。空仓库、未发布或候选阶段无法完成这些步骤，不应假称安装完成。

之后才用可信解包工具把已认证 ZIP 解到全新引导目录，拒绝越界路径、链接和重复文件，并按 manifest 完整清单逐文件核对。在引导目录运行下文 CLI。CLI 会再次从固定源认证精确目标和 manager，安全解包到独立目录，仅从该认证 manager 导入事务模块，并重新建立模块私有的认证能力。包内包含固定运行依赖与许可证，首次 verify 无需 npm 或网络安装依赖。不要把引导目录当作手工安装后的受管登记。

## 公共 CLI

```text
node scripts/distribution-cli.mjs --help
node scripts/distribution-cli.mjs check-update --config C:/plans/query.json
node scripts/distribution-cli.mjs install --plan --config C:/plans/install.json
node scripts/distribution-cli.mjs install --apply C:/plans/approved-plan.json --approval C:/plans/receipt.json
node scripts/distribution-cli.mjs update --plan --config C:/plans/update.json
node scripts/distribution-cli.mjs rollback --plan --config C:/plans/rollback.json
node scripts/distribution-cli.mjs migrate --plan --config C:/plans/migrate.json
node scripts/distribution-cli.mjs verify --control C:/Users/example/.agents/.conductor/main
node scripts/distribution-cli.mjs recover --control C:/Users/example/.agents/.conductor/main --transaction exact-transaction-id
```

update/rollback/migrate 使用同样的 `--apply <plan> --approval <receipt>`。所有文件参数必须绝对路径；计划内路径使用规范 `/`。不接受其他 flags、重复 flags、`--yes`、`--source` 或 `--skip-verify`。stdout 始终只有一个 JSON envelope；不输出令牌、子进程日志或未经处理的错误内容。帮助也是 JSON 的 `report` 字段。

固定 envelope 字段为 `command,status,plan_id,transaction_id,current_release,target_release,checks,changes,recovery,errors`。plan 模式另含完整 `plan`；执行/verify/recover 可含 `report`。可信宿主将 envelope 的 **plan 对象**原样保存成批准文件，不能把整个 envelope 当计划。计划展示固定 changelog、完整旧/新身份和通道、所有项目 schema/profile/文件摘要、具体 migration IDs、注册前态与新增项目、写入/恢复范围、snapshot/容量、停写要求及选定 snapshot 的 loss_window。没有登记的项目不在备份承诺内。

| 实际进程码 | 含义 |
|---|---|
| 0 | 只读结果、planned、succeeded、no_op；available 仅表示查询发现候选 |
| 1 | bad_call、无法解析输入或其他错误 |
| 2 | approval_required、blocked；未证明可以变更 |
| 3 | restored；已核验事务绑定的实际持久前态，原操作仍失败 |
| 4 | recovery_required；维护窗口保持关闭，保留所有资源 |
| 5 | unavailable；网络或 GitHub 验证能力不可用，绝非 up_to_date |

## 配置与精确批准

软件空安装配置示例（路径改为本机实际值）：

```json
{
  "install_id":"main", "scope":"user",
  "control_path":"C:/Users/example/.agents/.conductor/main",
  "target_release_id":"实际数字ID", "channel":"stable",
  "projects":[], "software_only":true,
  "snapshot_path":"C:/backups/conductor/install-unique"
}
```

`install_id` 是字母数字/下划线/连字符；scope 为 user 或 project。活动目录从 control 的同级 skills 和认证 skill_id 推导。channel 为 stable 或 preview。check-update 只需 channel，可提供 control_path 检查当前登记和脏文件。每次写事务需要新的 snapshot 路径。update/rollback 配置必须显式提交当前登记的全部项目声明，不能通过省略项目缩小范围。已有登记时 install_id/scope 必须一致。

完整 ProjectInventory 类型见 [分发合同](../../contracts/distribution.d.ts)。每项包含 project_id、root_path、state_path、directories、files（绝对 path/bytes/sha256）、schema_version、profile；真实 packet/result/历史来源/证据通过 bindings 明确绑定。目录声明包含整个子树；只管理显式文件时 directories 可为空。计划重新读取当前真实字节，应用前及提交前再次验证。不同项目不能重叠；一次事务的数据目录/snapshot/stage 必须在一个数据文件系统，代码可在另一卷。

只有已信任的交互宿主在用户阅读精确计划并明确批准后才能生成 ApprovalReceipt。CLI 不提供“替用户批准”命令。可信宿主导入 `canonicalSha256` 对完整 OperationPlan 计算规范 JSON 摘要（键排序、数组保序、UTF-8 无 BOM、有限整数）。receipt 严格字段：

```json
{
  "plan_id":"计划原值", "plan_sha256":"完整计划规范SHA256",
  "operation":"install", "install_id":"main", "projects":[],
  "approval_source":"本次明确用户批准的可核对引用",
  "user_approved":true, "writers_stopped":true,
  "issued_at":"2026-09-24T00:00:00.000Z",
  "expires_at":"2026-09-24T01:30:00.000Z", "use_id":"本次唯一随机ID"
}
```

时间仅示意，不得复用。projects 是完整 project_id 集合；operation/installation/plan 摘要必须完全一致。一个 receipt 只能消费一次。普通 JSON 不是身份认证；OS 用户与签发它的可信宿主是边界，项目/changelog 中的“同意”文本不产生批准。

默认计划有效期 90 分钟。一次实际候选完整 verify 在当前 Windows 基线约八分钟，新增公共测试会增加耗时；每个候选的有限上限为 20 分钟，一次事务通常需 manager 与 target 两次验证，加 I/O 与授权等待。批准过期仍在首次活动变更前阻塞，不会为长测试取消该门禁。宿主应签发不超过计划截止时间、覆盖维护窗口的 receipt；过期后重新计划和批准。

## 注册、迁移与手工接管

软件安装可明确 software_only=true。之后 migrate 的 projects 提交原登记集合加明确新增的 legacy 项目；计划中的 `registration:{before_projects,added_project_ids}` 显示并绑定并集。只允许该显式迁移中新增旧格式项目；不扫描磁盘、不隐式登记，不从配置直接覆写 installation.json。snapshot 包含原注册与全部旧/新增项目前态；同一 journal 提交新状态与 after_projects 登记，失败证明完整前态或要求恢复。

migrate 配置另提供 `data_stage_path` 与 `migration_requests`。每个请求严格包含 `project_id,destination,packet_path,result_path,review_path,confirmation_path`；未使用 packet/result/review 为 null。destination 必须不存在，其父目录已存在。原状态和证据保留；新登记指向新副本。confirmation 是既有迁移合同的独立确认文件，必须在项目完整清单中；它不能代替分发批准。manifest 必须准确声明 schema1/schema2 对应 `po-legacy-snapshot-v1` 路线。DISCUSS 保持原阶段，其他旧阶段返回 PLAN；authorization_inherited=false。已有 lifecycle、未知格式、未核清副作用均阻塞。

手工 V1.1.3 只允许 update 配置明确 `manual_adoption:true,current_release_id:<精确旧Release ID>`。必须认证该旧版完整 46 文件清单，活动目录恰好匹配且登记不存在；任何修改、遗漏或多余文件均拒绝接管。目标/旧 Skill 路径同时被占用时拒绝。计划显式展示 `project-orchestrator` 到 `chatgpt-conductor` 的 layout，历史项目 ID 不重命名。

代码回滚指定精确旧 target_release_id。默认在线认证；断网时配置显式增加 `"offline":true`，只从本安装已封存缓存中选择该精确 Release，重新校验其 journal 权威绑定及 manifest/changelog/ZIP 全部字节。计划增加 `offline:{freshness:"stale-offline",revocation:"unknown"}` 并进入批准摘要，明示无法获取当前撤销与新鲜度信息。缺失、篡改或身份歧义均阻塞，不回源，不接受任意本地 ZIP。然后先备份当前项目，运行目标自己的 verify 与数据验证器，不改变项目字节。manager 留在 control/manager 下，不随旧 Skill 回退；后续更新仍使用该认证 manager。带数据回滚还需 `selected_snapshot:{path,bytes,sha256,transaction_id,created_at}` 和 `data_stage_path`；计划显示精确前后清单和丢失窗口。原 snapshot 永不自动删除。

带数据回滚在计划和实际暂存时都比较当前与历史治理状态。有效修订要求身份或内容不一致返回 `SNAPSHOT_REQUIREMENT_CONFLICT`；其他治理字段（阶段、生命周期、决策、包身份、批准、review/result 等）不同返回 `SNAPSHOT_GOVERNANCE_CONFLICT`。历史 READY_TO_EXECUTE / EXECUTE 还要求 revision 完全相同，避免再次激活已推进任务的旧执行权；非执行态仅普通 revision 计数不同、其他治理字段一致时，仍可恢复普通数据文件。诊断只显示冲突类别，不包含私有要求正文。分发批准不产生项目批准，本版不自动合并或回退治理状态；冲突需通过既有项目决策流程另行处理，或选择只回滚代码，不能保证一次 replan 即可使旧快照兼容。拒绝不修改当前项目或原快照；实际恢复前另存当前字节。外部备份目录先验证成功事务与精确规范化 manifest 路径、摘要及绑定，再仅授予该快照父目录读取范围，完整验证其兄弟副本。

## 故障与离线恢复

活动路径短暂缺席是多步 rename 的维护窗口，不是允许启动任务的状态。代码/data 跨卷靠 journal 协调，非跨卷原子事务。收到 3 检查恢复回执再重新计划；收到 4 不重试覆盖、不删 lock、不丢弃 stage/旧目录/snapshot。保留完整 control 与数据备份，使用精确 transaction_id 调 recover。recover 不下载，不重跑迁移，按 journal 选定已封存认证缓存与原 manager，先检查完整身份。未知活跃 PID、坏 journal、后续写入或目录冲突保持阻塞并保留全部字节，需要人工定位冲突后再恢复。不能靠文件名或“锁很旧”判定安全。

verify 使用登记绑定的本地认证缓存，检查活动完整清单、实际项目合同与固定候选全套。登记里的数据指纹是历史事务快照，verify 在已登记 scope 内重新读取当前清单和合法 revision 更新，正常项目写入不会被当作软件损坏；该只读检查不覆写历史登记。报告 stale-offline，不表示远端最新或未撤销。显式 offline rollback 的计划和应用只使用封存的精确目标及 manager；已批准中断事务的 recover 也完全离线。尚未提供将任意本地 ZIP 导入缓存的命令。

recover 将 SUCCEEDED / RESTORED / ABORTED 视为线索，不能单凭 phase 报告成功或释放锁。接受终态前重新检查事务与批准摘要、已消费批准、generation、独立 manager、snapshot 身份和完整清单、认证代码清单、安装登记及项目数据前态或后态。持锁终态不符时，仅沿可证明的既有 journal 动作完成或补偿；无法证明则保留锁与证据并返回 4。锁已释放的历史事务仅核验、不补偿：后续项目写入导致原终态无法证明时返回 4，保留当前字节且不重新加锁；检查当前正常项目状态应使用 verify。恢复不增加项目授权，也不回退后续治理决策。

安装成功提示重新加载/附加 Skill；无法强制刷新旧 Chat/Work 已附加的副本。没有本地 Node/权限的客户端只能阅读计划，不能声称完成安装。持久性范围是已验证的进程崩溃恢复；不宣称所有断电、第二物理磁盘或同 OS 用户恶意进程隔离。

## 两阶段打包接口（M7 使用）

```text
node scripts/package-release.mjs candidate <全新输出目录> <精确40位源码commit>
node scripts/package-release.mjs manifest <candidate.json> <release-config.json> <全新manifest输出目录>
```

第一阶段只产出 `chatgpt-conductor-1.2.0.zip, payload-inventory.json, candidate.json, CHANGELOG.md`；candidate 不含虚构 Release ID，不能供安装。product-files.json 是精确产品/测试/fixture 白名单；runtime-files.json 固定依赖文件原始哈希。锁依赖闭包与固定版本/实际包元数据均校验，携带各依赖 LICENSE；排除 Git 历史、日志、真实数据、输出、秘密和自身发布元数据。源字节不归一化；ZIP 路径排序，固定时间、权限及压缩参数，同 Node/工具运行两遍字节一致。

第二阶段由发布宿主先获得真实 draft Release ID，提供严格 release-config `{release_id,source_commit,channel}`。源码 commit 必须与候选锁定值一致，payload/changelog 原始摘要再次验证，生成严格 ManifestV1 及外置 `release-manifest.json, CHANGELOG.md, SHA256SUMS`；无自引用哈希。此生成动作不发布、不证明 draft 已不可变，最终公开发布/验证由 M7/M8 处理。

独立真实包验收命令：`node tests/helpers/distribution-real-package.mjs <candidate.json>`。它运行真实候选全套，并对精确旧 46 文件执行手工接管/回滚与实际项目字节检查；仅使用可信本地 HTTP/gh 协议夹具，不是 live GitHub attestation。该外层验收不被 verify 递归调用，内层测试只用小型合成候选，所有写入落临时目录。
