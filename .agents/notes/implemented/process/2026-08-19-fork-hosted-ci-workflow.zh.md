# Agent Note：Fork 托管 CI 工作流

Status: implemented

[English](2026-08-19-fork-hosted-ci-workflow.md) | 中文

## 问题

[CI](../../../../.github/workflows/ci.yml) 的必需 Linux 通道通过企业级 runner 池和自托管标签（`vm-backup`、`dsh-win-ci`）解析，而这些只有上游仓库才提供。在个人 fork 上，每次 CI 运行都在启动阶段以零作业告终，因此 fork 的 pull request 和 master 推送在完全没有已执行门禁证据的情况下合并；fork 积累的唯一工作流运行是 GitHub 托管的 Copilot 评审。若修改 `ci.yml` 以改用托管 runner，则每次上游同步都会陷入永久合并冲突。

## 决定

独立工作流 [Fork CI](../../../../.github/workflows/fork-ci.yml) 在标准 `ubuntu-latest` runner 上运行完整的本地门禁集。每个作业都以 `github.repository_owner != 'deepseek-ai'` 守卫，因此该文件即使随 pull request 进入上游也保持惰性；`ci.yml` 保持原样，上游同步不产生冲突。

三个并行作业通过 `pnpm run` 脚本复用 [run-gates](../../../../scripts/run-gates.ts) 中的门禁聚合（运行器要求 `npm_execpath`）：`static` 运行 `check:ci:static`，并附加显式的 `typecheck` 与 `verify-third-party-notices` 步骤，因为 `typecheck` 仅存在于 `ci-primary`，而第三方声明检查不属于任何聚合；`coverage` 运行 `check:ci:coverage`；`consumers` 在以 `pnpm-lock.yaml` 为键的 `actions/cache` 后安装 Playwright Chromium，再运行 `check:ci:consumers`。`ci-static` 内的 `docs:build:mpa` 门禁作为站点构建信号，与上游必需 Linux 通道一致。工作线程预算固定为 4 核托管机型（`DSH_COVERAGE_MAX_WORKERS=4`，`DSH_GATE_CONCURRENCY` 为 2/4），因为 `ci-consumers` 否则会把并发默认为门禁数量。触发器与并发组镜像 `ci.yml`：pull request 取消被取代的运行，master 推送永不取消。

## 考虑过的替代方案

**直接在 `ci.yml` 中用 fork 条件的 `runs-on` 表达式改目标。** 该文件的每次上游同步都会变成合并冲突，且这些条件表达式会进入上游成为噪音。

**单个串行作业运行 `check:all`。** 单作业将 runner 小时成本减半，但把覆盖率排在构建和快照之后串行执行；三通道划分沿用上游已验证的分区，并让最慢的通道（v8 插桩下的覆盖率）保持独立。

**跳过重型通道，只运行 lint 加单元测试。** 这会退化为比本地会话手动运行还弱的门禁集，且按[测试政策](../../../../docs/testing.md)，CI 覆盖率门禁是 `test:coverage` 而非 `test`。

## 后果

Fork 的 pull request 和 master 推送在免费托管 runner 上获得覆盖完整本地门禁集的合并阻断证据。覆盖率通道是最长瓶颈：13,524 个测试在 4 核上做 v8 插桩，而上游预算是 16 核 6 工作线程；其 `timeout-minutes: 120` 接受较慢的反馈，若仍不够，后续手段是分片，绝不降级为无插桩的 `test`。Windows、真实 API e2e、发布打包和 Python 发布矩阵仍是上游独有的信号；fork 工作流不做尝试。
