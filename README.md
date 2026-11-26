# Prompt-to-Experiment

> Flagsmith Toggle Wars — 主投 **Track 01「Test Something Real」**（$2,000），Track 02 备选。
> 状态：构建日 1（2026-11-26）进行中。实验尚未启动；以下流程在 Flagsmith 登录/API key 就绪后按顺序跑通。

一句话卖点：把「想一个实验 → 在 Flagsmith 里建 flag/指标/实验 → 埋点 → 跑流量 → 读结论」这条原本要手工点半天的链路，压成「**一句话提示词 + 两次人工批准**」。

## 它做什么

```
提示词 ("测一下收益型标题对注册转化率的影响")
  → agent/parse.ts + agent/plan.ts：生成 experiment-plan.json 草案 + 人读版 plan-summary.md
  → 批准门 1：人工输入 approve 才继续（不批准 = 零 API 调用）
  → agent/apply.ts：经 Flagsmith CLI/API 落地 multivariate flag → metric → experiment（draft，不启动）
  → 批准门 2：人工再次输入 approve 才 POST start（启动会锁定 flag）
  → demo/index.html：FlowBoard 假产品落地页，按 flag 变体渲染 control / treatment
  → sim/simulate.ts：2,000 个独立 identity 跑模拟流量，事件真实进 Flagsmith 托管 warehouse
  → agent/report.ts：拉平台贝叶斯结论 + 自算 z 检验交叉验证 → report.md
```

## 快速开始

```bash
# 1. 装依赖与 Flagsmith CLI v2
npm install
curl -fsSL https://get.flagsmith.com | sh   # 已装 v2.0.0 可跳过

# 2. 登录（交互式 OAuth，人工完成）并绑定项目
flagsmith login
flagsmith init --project 55963   # 项目 toggle-wars；环境 Development

# 3. 填凭证（只进 .env，绝不进仓库）
cp .env.example .env
# FLAGSMITH_ENVIRONMENT_KEY=...   # Development 环境的 client-side key
npm run demo:config               # 由 .env 生成 demo/config.js（git-ignored）

# 4. 生成实验草案（零 API 调用）
npm run plan -- "测一下收益型标题对注册转化率的影响" --out out

# 5. 读 out/plan-summary.md，确认无误后过批准门 1
npm run approve -- --gate gate-1 --plan out/experiment-plan.json --summary out/plan-summary.md

# 6. 落地三件套（先 --dry-run 检查将要执行的命令）
npm run apply -- --plan out/experiment-plan.json --dry-run
npm run apply -- --plan out/experiment-plan.json --project 55963

# 7. 批准门 2 后启动实验，再跑模拟流量（构建日 2）
# npm run approve -- --gate gate-2 --plan out/experiment-plan.json
# （start 与模拟器见 11-27 构建记录）
```

## Flagsmith 用法（本项目如何用 Flagsmith）

| 能力 | 怎么用 | 依据 |
|---|---|---|
| Multivariate flag `landing_cta` | control 为 flag 自身保留值；变体 `treatment` 带 key `treatment`（无 key 的变体不记录 exposure） | CLI：`flagsmith feature create landing_cta --value control --enabled`；`flagsmith feature variant add landing_cta --value treatment --key treatment --weight 0` |
| Metric `signup_rate` | 聚合 `occurrence`，方向 `up`，事件 `signup_completed` | `POST api/v1/environments/<env-key>/experiment-metrics/` |
| Experiment `landing-cta-headline-v1` | rollout 100%，control/treatment 各 50%；建后为 draft，启动需单独批准（启动锁定 flag） | `POST .../experiments/`，`POST .../experiments/<id>/start/` |
| 事件上报 | JS SDK 12.4.0，`init({ enableEvents: true })`；`getExperimentFlag('landing_cta')` 求值即记录 exposure；`trackEvent('signup_completed')` / `trackEvent('cta_clicked')` | SDK 的 events pipeline 是 `@experimental` 能力，需显式开启 `enableEvents` |
| 结果 | 平台贝叶斯引擎：lift、95% 可信区间、胜出概率（≥95% 建议全量）；另自算双比例 z 检验交叉验证 | `POST .../experiments/<id>/results/refresh/`（每 5 分钟最多一次）后 `GET .../results/` |
| MCP 的分工 | MCP（`https://mcp.flagsmith.com`）**不能启动实验**，官方 agent 指南明说生命周期走 CLI/API；因此 CLI/API 负责写操作与生命周期，MCP 只做读巡检（`agent/inspect.ts`，构建日 2） | docs.flagsmith.com「Set Up an Experiment with a Coding Agent」 |

**免费档**：Flagsmith Cloud 免费档（50,000 API 请求/月、1 成员、1 项目；Experimentation 在所有 SaaS 档可用，含托管 warehouse；实验内用户上限 100,000）。本项目全程只用 `toggle-wars` 一个项目、`Development` 一个环境，不付费。

**事件名大小写敏感**：`signup_completed` 必须与代码里的 `trackEvent('signup_completed')` 逐字一致，不一致会被静默丢弃。事件名在 plan 里单一定义，代码引用同一常量。

## 实验设计与统计口径

- **假设 H1**：收益承诺型标题+CTA 使注册转化率高于功能描述型（control）。
- **主要指标** `signup_rate`：exposure 后发生 `signup_completed` 的 identity 占比（occurrence 聚合，方向 up）。**只看主要指标下结论。**
- **次要指标** `cta_click_rate`（事件 `cta_clicked`）：仅观察，不下结论，防「标题吸引点击但不转化」的误读。
- **分流**：rollout 100%，control/treatment 各 50%（Flagsmith 按 identity 哈希稳定分桶，同一 identity 恒定同组）。
- **模拟真值**：control 转化率 10%，treatment 15%（相对 +50%、绝对 +5pp——效应量取大，是为了让教学型样本量内能得出明确结论）。
- **样本量**：每组 1,000 人、共 2,000 identity。双比例检验 α=0.05（双侧）、power=0.8、p₁=0.10/p₂=0.15 时每组需 ≈686 人，取 1,000 留余量。2,000 人 ×（求值+事件）远在免费档 50,000 请求与 100,000 实验用户上限内。
- **随机性与可复现**：模拟器用固定种子 PRNG（mulberry32，seed=20261126）；转化掷骰可复现。分桶由 Flagsmith 按 identity 决定（确定性哈希），identity 命名规则固定 → 整次实验可逐字重跑。
- **判读**：平台贝叶斯胜出概率 ≥95% 判「treatment 胜出，建议全量」；自算 z 检验并列写进 report.md，两者不一致时以平台为准并注明。实验跑满预定样本量才读结论（不中途偷看停跑）；无差异/不显著也是有效结论，如实写。
- **预期结果**：treatment 约 15% vs control 约 10%，z 检验 p<0.001 量级，贝叶斯胜出概率应 >99%。

## 人在环：两次批准门

1. **门 1（建对象前）**：打印 plan-summary.md 与 plan 文件 sha256，必须人工输入 `approve` 才调用 Flagsmith API。`approve.ts` 不 import 任何网络模块——不批准时零 API 调用。
2. **门 2（启动前）**：实验建好后仍为 draft；启动会锁定 flag，须再次输入 `approve` 才 POST start。

任一门拒绝即停止，草案保留，可改提示词后重新生成。

## 仓库结构

```
agent/
  parse.ts    提示词 → 结构化草案（确定性规则解析，无在线 LLM，评审可复现）
  plan.ts     生成 experiment-plan.json + plan-summary.md（含与现状的 diff 与默认值标注）
  approve.ts  批准门（gate-1 / gate-2）
  apply.ts    CLI/API 落地 flag → metric → experiment（幂等，--dry-run 可预演）
  cli.ts      npm run plan / approve / apply 的入口
  report.ts   （构建日 2）拉 results + z 检验 → report.md
  inspect.ts  （构建日 2）MCP 读巡检
demo/
  index.html  FlowBoard 假产品落地页（静态，无构建步骤）
  app.js      SDK 接入：getExperimentFlag 双变体渲染 + trackEvent
  config.js   由 .env 生成（git-ignored）；缺失时页面以 control 版本地预览
sim/
  simulate.ts （构建日 2）2,000 人模拟流量：种子 RNG、按所见变体转化、退出前 flush
examples/
  prompt.txt            示例提示词
  experiment-plan.json  由示例提示词生成的草案（可复现：npm run plan -- "$(cat examples/prompt.txt)"）
  plan-summary.md       同上的人读版
```

## 演示视频

脚本见 `~/workspace/comps/flagsmith/design.md` §4（≤3 分钟，全程真实界面）。录制于 11-28。

## 风险与降级

- **Experimentation 仍是 beta**：warehouse 启用异常 / results 刷新延迟或为空 → 先小流量冒烟（11-26 晚）提前暴露；降级为「multivariate flag + 自有分析」路线（事件同时落本地日志，统计全走自算 z 检验）；若实验侧整体不成立，按设计 §1 转投 Track 02。
- **MCP 不能启动实验**：生命周期只用 CLI/API，MCP 只做读巡检；MCP 不通则 README 如实说明，不阻塞主线。
- **事件静默丢失**：事件名单一定义、代码引用同一常量；模拟器退出前强制 flush 并做事件数对账。

## 构建记录

见 `~/workspace/comps/flagsmith/BUILD-LOG.md`（设计文档：`design.md`）。
