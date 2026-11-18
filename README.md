# 构建门户重跑任务的日志证据领取

这是面向资料接收人员的 Node.js 收件服务。当前版本支持原始资料领取、内容校验、人工摘要登记和按出处回查，也可从构建门户入口自动领取重跑任务的日志证据：按任务实际所属执行代次保存日志原文、步骤边界与制品关联，区分暂存与已封口，并可查看单次尝试或最后一次交付引用了哪些历史任务。它不执行仓库代码，也不触发新的构建。

## 本地运行

运行环境为 Node.js 22（最低 22.22.1），使用运行时内置模块，没有第三方运行依赖。package.json 与 package-lock.json 声明相同的兼容范围；平台 Linux 基线使用 Node.js 22.23.4，独立 Dockerfile 仍固定 22.22.1 镜像摘要。启动与测试不执行依赖下载。执行以下命令启动真实收件与来源服务：

```sh
npm start
```

默认收件地址为本机 4310 端口，授权资料源为本机 4311 端口。PORT、SOURCE_PORT、ARCHIVE_DIR 可分别调整端口和资料目录；.local 为本地持久化内容，不纳入版本。停止进程后重新启动会继续读取原有收件。

## 检查与使用

```sh
npm run build
npm test
npm run demo
```

build 对所有源码做语法检查，test 检查收件能力、来源服务和构建证据领取。demo 从临时空目录启动两个真实 HTTP 服务，领取实际来源，输出收件、记录与资料索引，然后关闭并清理临时状态；不重播预先保存的日志。它没有固定等待，不超过来源请求本身的超时。完整来源下 demo 会领取两次尝试（含重跑沿用的旧任务）、失败任务的日志和最终制品；SOURCE_STAGE=partial 可观察未封口日志作为暂存。

```sh
npm run acceptance:structured
npm run acceptance:partial
```

这两项检查分别读取完整与不完整来源样本，核对 docs/source-contract.md 中的结构化记录与出处关系：任务使用代次、失败任务日志、制品关联，以及暂存日志的问题说明。它们与 `npm test` 中的回归检查使用同一套本地来源。

## 可复现环境

```sh
docker build --network=none -t local-receiver .
docker run --rm --network=none local-receiver npm test
docker run --rm --network=none local-receiver npm run demo
```

Dockerfile 固定 Linux Node 镜像摘要，容器仅需内部回环网络。镜像构建不安装额外依赖，也不读取真实账户、用户数据或公共网站；首次拉取基础镜像属于环境准备，不属于正式运行。脚本输出规模受小型本地资料控制，正常完整运行可以在九十秒内观察。
