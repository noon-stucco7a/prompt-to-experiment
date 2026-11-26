# 实验草案：landing-cta-headline-v1

> 由提示词生成（草案，未落地 Flagsmith）。生成时间：2026-11-26T02:35:04.384Z
> 原始提示词：测一下收益型标题对注册转化率的影响

## 假设

把落地页主标题+CTA 从功能描述型改为收益承诺型，将使注册转化率从约 10% 提升到至少 13%

## 将新建的对象（与现状的 diff）

| 对象 | 名称 | 详情 |
|---|---|---|
| Multivariate flag | `landing_cta` | 默认值 `control`；变体 `treatment`（值 `treatment`），control 为 flag 自身保留值 |
| Metric（主要） | `signup_rate` | 聚合 `occurrence`，方向 `up`，事件 `signup_completed`（大小写敏感，须与代码 trackEvent 逐字一致） |
| Metric（次要，仅观察） | `cta_click_rate` | 事件 `cta_clicked`，不用于下结论 |
| Experiment | `landing-cta-headline-v1` | 分流 50/50，rollout 100%，建后为 draft、不启动 |

## 变体文案

| 变体 | 主标题 | CTA |
|---|---|---|
| control | Organize your team's work in one place | Start free trial |
| treatment | Ship projects twice as fast — start today | Get started free |

## 模拟设定

- 每组 1000 人，共 2000 个独立 identity
- 固定种子 PRNG seed=20261126，转化掷骰可复现
- 模拟真值：control 转化率 10%，treatment 15%（相对 +50%、绝对 +5pp；效应量取大是为了让教学型样本量内得出明确结论）
- 转化概率挂在「实际所见变体」上，不是预先分组；分流不均会如实进入数据

## ⚠️ 解析时用的默认值（请复核）

以下字段提示词里没写明，agent 按设计文档默认值填入。批准前请确认或修改：

- **copy.headline / copy.cta**：control: “Organize your team's work in one place” / “Start free trial”; treatment: “Ship projects twice as fast — start today” / “Get started free” —— Prompt states no explicit copy; using the documented default copy from design.md §2.5. Quote copy in the prompt to override, e.g. control「…」treatment「…」.
- **experiment.allocation**：control 50 / treatment 50 —— Prompt states no split; defaulting to an even 50/50 split.
- **simulation.identitiesPerVariant**：1000 per variant (2000 total) —— Prompt states no sample size; 1000/group leaves margin over the ≈686/group required for α=0.05, power=0.8, p1=0.10, p2=0.15 (design.md §3).

## 批准门

- 门 1（建对象前）：人工输入 `approve` 才调用 Flagsmith API 创建 flag / metric / experiment。
- 门 2（启动前）：实验建好后仍为 draft；启动会锁定 flag，须再次输入 `approve` 才 POST start。
- 任一门拒绝即停止，草案保留，可修改提示词后重新生成。

## 草案哈希

`sha256:92adb5f7e283a9969f51a228f4d5c3bc8b3819148179da82419b3becc65ae777`
