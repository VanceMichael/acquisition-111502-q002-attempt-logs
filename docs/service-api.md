# 收件服务接口

人工资料接收保持兼容。POST /intakes 的 JSON 字段为 collectionId、sourceKey、revision、mediaType、contentBase64；返回 receiptId、sha256、byteLength 和轻量 summary。相同资料集、来源键与修订对应同一收件，字节不同返回 409。GET /receipts/{receiptId} 可读元数据，GET /receipts/{receiptId}/body 返回原字节。

POST /acquisitions 接受 collectionId、entry 和可选 options，entry 是授权来源完整地址。服务从该入口读取流水线尝试页、任务日志和制品声明，登记自动观察，返回 collectionId 与本次新增的 receiptIds。自动解释只依据来源实际返回的内容；所有原始载荷（入口、尝试页、日志、租约描述）都各自留有一份收件，不用人工造 records 代替自动接入。来源访问只限启动时冻结的 origin，不访问其他主机、不执行交付件、不触发构建。

GET /collections 返回资料集列表，GET /collections/{collectionId} 返回 collectionId、receiptIds、records、issues，自动观察后可能另有 recordHistory（被替换的旧视图）。records 的每项包含 kind、key、value、provenance；key 由各来源身份语义决定。provenance 是含 receiptId 与 location 的数组，location 可采用字节区间、原行列、JSON Pointer 等可复查定位。issues 每项包含 reason、location，至少能说明原因、受影响范围和已有来源依据，不能用静默丢弃表示未知。自动观察产生的 issues 带 origin: "automatic"；重新领取会以当次来源状态替换这些自动说明，已归档原文收件不删除。

## 构建证据记录

自动领取产生以下 kind：

- job-use：某个尝试页上可见的一次任务使用。value 含 pipeline、attempt、job、executedAttempt、inherited、state。attempt 是它出现在哪次尝试，executedAttempt 是真正执行代次；重跑沿用时 executedAttempt 保持旧值且 inherited 为 true，不能记成新的执行。
- job-log：某次任务执行代次的日志。key 为 pipeline:job-log:{job}:{executedAttempt}，因此日志与步骤边界始终挂在执行代次上，而不挂在最新页面上。value 含 attempt（等于 executedAttempt）、executedAttempt、state、sealed、staged、sha256、byteLength、steps。steps 每项含 name、startLine、endLine、startByte、endByte、closed、closedBy；closed 为 false 表示该步骤在日志截断时仍未结束。
- artifact：制品与生产任务。value 含 pipeline、name、attempt、producerJobs 和 producers；producers 把每个生产任务解析到它在该次交付中实际使用的 executedAttempt。
- delivery：最后一次交付的解释。value 含 attempt、jobs（含 inherited 与 executedAttempt）、historicalExecutions（交付尝试中沿用自更早代次的任务）、artifacts。它说明最后交付引用了哪些历史任务。

日志是否完整由两项共同决定：任务 state 为终态（sealed 或 failed）且日志末尾存在 ::sealed:: 标记。任一不满足即为暂存（staged: true），并登记 log_unsealed、log_missing_seal_marker 或 log_state_not_terminal 之一。失败任务的已封口日志是完整日志。

日志通过 logLease 申请一次性领取链接；链接用后或过期时按同一任务重新申请，不使用旧地址作为任务主键。日志的 sourceKey 与 revision 均由 pipeline、job、executedAttempt 和内容摘要决定，因此重新申请链接不会改变内容身份。若同一执行代次的日志内容真的变化，新旧字节各自成为独立收件，当前记录指向当次读取的版本，旧收件仍可按 receiptId 回查。

GET /collections/{collectionId}/attempts/{attempt} 返回单次尝试视图：该次可见的 jobs（含 executedAttempt、inherited、state 与对应 job-log 的封口、步骤、出处）、artifacts、是否 delivered、交付解释和相关 issues。它只表示该次尝试实际看到和使用的内容，不会把最新页面上的任务拼成一次新的执行。

POST /collections/{collectionId}/records 可录入人工确认记录，必须附本资料集的真实收件出处。人工记录采用同键不可变约定，同键不同值返回 409。自动领取可以替换自己此前生成的同类记录（例如暂存转为封口），旧视图保留在 recordHistory 中；自动领取不会覆盖人工记录，两者同键冲突时返回 409。来源契约中的值是查询视图契约，不限定解析器、状态机或索引的内部实现。

本地 provider 是独立 HTTP 来源，fixtures 为合成的公开样本，不包含真实个人或机构凭据。fixtures/descriptor.json 说明来源入口与接入选项。多数资料源用 /deliveries 声明 deliveryId、revision、roots 和 resources；roots 是需处理的独立入口，resources 是同包可领取资源，不是公网搜索指令。文件可用 GET、HEAD 与单段 Range 读取；ETag 表示返回字节的身份。SOURCE_STAGE=partial 启动不完整交付状态，完整状态是默认值。来源服务不接受写操作。
