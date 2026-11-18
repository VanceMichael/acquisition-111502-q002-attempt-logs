# 来源资料契约

入口 /pipelines/build-7 列出尝试地址。attempt.jobs 表示本次尝试的可见任务，executedAttempt 是真正执行代次，inherited 表示沿用。任务身份为 pipeline+job id，尝试另存 job-use 引用；不能把 inherited 改成重新执行。state 与日志末尾 ::sealed:: 均满足才能称日志完整，failed 可是已封口日志。日志用 ::step::名称 与 ::endstep:: 标识步骤。未封口为暂存。job-log 的 value 含 job、executedAttempt、sealed、text；job-use 含 attempt、job、executedAttempt；artifact 含 name、attempt、producerJobs。过期领取需要重新读取任务元数据，不把地址用作任务主键。partial 来源提供未封口的新尝试。

上述字段必须按语义落到记录上：job-use 的 attempt 是出现页面，executedAttempt 是执行代次；job-log 以 executedAttempt 为主键的一部分，并保留步骤的原文行列与字节边界；artifact 把 producerJobs 解析为对应代次。最后一次尝试可以沿用旧代次任务，交付解释要同时给出交付尝试与历史执行，不能把沿用的任务描述成新执行，也不能只保留最新页面。

每条已解释资料均可回到真实来源收件和具体位置。原始载荷与版本必须继续可查，不能以解析后的摘要替代原文。同一任务日志重新申请领取后仍是同一内容身份；内容真正变化时新旧版本都保留为收件并明确标识。未列出的标准扩展允许明确标识未支持，不允许假称已解释。

已封口任务用 logLease 地址申请一次性领取链接，响应 href 只可读取一次；链接过期需重新申请，job 身份不变。logLease 与旧未封口任务的 log 均属于来源契约，不能遗漏原失败任务。
