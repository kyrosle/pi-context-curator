# pi-context-curator

[English](./README.md) · **简体中文**

面向 [Pi](https://github.com/earendil-works/pi) 的交互式、用户可控上下文策展插件。

它不会让上下文压缩变成一次完全自动且不透明的重写，而是让一个快速的额外模型把可压缩历史拆成每次仅 2–3 个语义块，再由你决定哪些内容保留摘要、原样保留、继续细拆或从 active context 排除。

原始 append-only session 始终可以恢复。插件缩小的是模型当前使用的 active context，不是磁盘上的 JSONL 历史文件。

## 为什么需要它

长时间编码 session 通常会落入两个极端：

- 什么都保留，导致后续每轮越来越贵、越来越嘈杂；
- 完全自动压缩，关键约束可能在没有用户决策点的情况下消失。

Context Curator 在保持轻量化的同时，把控制权留给用户：

```mermaid
flowchart LR
  A["Pi append-only session"] --> B["可压缩历史前缀"]
  B --> C["分析模型提出 2–3 个块"]
  C --> D["交互式 Curator 树"]
  D -->|摘要 / 原样 / 排除| E["确定性 checkpoint"]
  A --> F["最新 raw tail"]
  E --> G["模型 active context"]
  F --> G
```

分析模型只负责提出结构，不会自行应用压缩。最终 Apply 始终由用户执行。

## 主要能力

- 每次只提供 2–3 个上下文选项。
- 即使可压缩历史只有一个超大回合，也会先无损预切分，因此第一个 Curator 窗口仍直接显示 2–3 个选择。
- 支持自然语言策展指令，可以重新分组并预选哪些内容保留摘要、原样保留或排除。
- 深层结构使用短本地标题、按宽度保留元数据和自动换行的当前项区域，不再反复拼接父级路径。
- 可以递归细拆，并且不会对摘要再次摘要。
- 三种保留模式：`summary`、`exact`、`drop`。
- 最新 raw tail 始终原样保留。
- 用户选择完成后，确定性编译 checkpoint，不再让模型二次改写。
- 支持手动或自动触发 Curator。
- 新输入优先：排队的 RPC、intercom 或其他输入会关闭任何已经过时的 Curator，并且不会吞掉该输入。
- 紧急区提供 `B`，可明确选择 Pi 原生 compaction。
- 在同一个设置窗口管理全局、受信任项目和当前 session；session 记录不会进入模型上下文。
- 支持中英文界面、checkpoint 和分析模型输出语言。
- 使用 Pi 原生的可搜索、定高模型选择器选择分析模型，thinking level 跟随所选模型能力。
- 大上下文支持受控并发的分层分析。
- 包含来源覆盖、快照、依赖和 session 过期校验。
- 提供当前分支的只读 History，可以恢复任意列表 checkpoint 的归档摘要，并安全 fork 到策展前。
- 支持恢复归档摘要和回到策展前节点。

## 环境要求

- 支持扩展的 Pi。目前开发与测试基于 Pi `0.84.2`。
- 至少有一个已认证、可用作分析器的 Pi 模型。
- 交互式 Curator 和设置窗口需要 Pi TUI。

非交互模式不会打开 Curator 窗口，并继续保留 Pi 原生压缩行为。

## 安装

直接从 GitHub 安装：

```bash
pi install git:github.com/kyrosle/pi-context-curator
```

也可以使用 HTTPS：

```bash
pi install https://github.com/kyrosle/pi-context-curator
```

安装后重新启动 Pi。开发本地 checkout 时可以直接加载：

```bash
pi -e /absolute/path/to/pi-context-curator/index.ts
```

不要同时加载本地 checkout 和已经安装的 Git 包，否则两边都会注册 `/curate`。

## 快速开始

1. 在 Pi 中认证你准备作为分析器的模型。
2. 执行 `/curate settings`，选择分析模型、thinking level、语言和触发方式。
3. 手动执行 `/curate`，或者把 `triggerMode` 设为 `auto`。
4. 检查模型提出的上下文块。
5. 只有在 checkpoint 符合预期时才按 `A` 应用。

不传入焦点时，`/curate` 会自动采用最近一条用户请求作为下一阶段焦点：

```text
/curate
/curate 完成迁移并验证生产构建
```

## 命令

| 命令 | 作用 |
| --- | --- |
| `/curate [focus]` | 分析可压缩前缀并打开交互树。 |
| `/curate settings` | 编辑全局、受信任项目或当前 session 设置。 |
| `/curate status` | 显示有效配置和当前上下文用量。 |
| `/curate history` | 浏览当前分支上的全部 Curator checkpoint，查看内容不会进入模型上下文。 |
| `/curate undo` | 把分支指针移动到最近一次 Curator checkpoint 之前，不删除历史。 |
| `/curate restore` | 从最近一次 Curator checkpoint 恢复一个归档摘要。 |

## Curator 按键

| 按键 | 操作 |
| --- | --- |
| `Up` / `Down` | 在上下文块之间移动。 |
| `Space` | 循环 `summary → exact → drop`。 |
| `E` | 把当前叶子标记为 `exact`。 |
| `Enter` / `Right` | 把叶子细拆成 2–3 个子块，或展开已有分支。 |
| `Left` | 折叠分支。 |
| `F` | 输入或替换自然语言策展指令，并重新生成方案。 |
| `I` | 查看摘要、保留理由、依赖、证据和来源 ID。 |
| `P` | 预览确定性 checkpoint。 |
| `S` | 打开分层设置；保存内容从下一次 `/curate` 生效。 |
| `H` | 切换 `boundary` 与 `handoff` 应用方式。 |
| `A` | 应用 checkpoint；高风险选择需要再次按 `A`。 |
| `B` | 仅在紧急阈值出现，关闭 Curator 并运行 Pi 原生 compaction。 |
| `Esc` / `Q` | 取消手动 Curator，或者跳过自动 Curator 并返回聊天。 |

正在执行某次细拆时，`Esc` / `Q` 只会取消该次细拆并返回上下文树。

## 自然语言策展指令

在 Curator 中按 `F`，直接描述你想要的结果，例如：

```text
只保留 C 的实现和验证，排除旧的 A、B 方案；路径、错误和命令必须原样保留。
```

分析模型会基于同一份来源快照重新分组，并用推荐的 `summary`、`exact` 或 `drop` 初始化每个叶子。因此“只保留 C”不会让 A、B 的来源 ID 静默消失，而是继续显示为未勾选的 `drop` 候选。Apply 前仍然可以检查并覆盖所有建议；排除高风险块依旧需要二次确认。

需要注意的边界：

- 指令只作用于可压缩历史前缀，最新 raw tail 仍然原样保留；
- `drop` 只会从模型 active context 排除内容，不会删除 Pi append-only session 历史；
- 所有来源单元仍必须通过互斥且 100% 的覆盖校验；
- 指令最多 2,000 个字符，提交空内容可以清除当前指令；
- 重新生成后仍然必须由用户手动 Apply。

最终接受的策展指令会写入 checkpoint，让后续模型知道上下文为什么被收窄。

## History 与显式恢复

`/curate history` 会打开只读 popup，列出当前 Pi 分支上的全部 Curator checkpoint。完整的不变量与兼容性边界见 [History 规格](docs/history.zh-CN.md)。

列表会显示策展时间、focus、预计 token 变化，以及 `summary` / `exact` / `drop` 数量。按 `Enter` 可以查看当时持久化的决策树；较长的 focus、指令和摘要会根据终端大小自动换行并截断。

History 中的恢复操作全部要求显式触发：

| 按键 | 操作 |
| --- | --- |
| `Enter` / `Right` | 查看所选 checkpoint 及其决策树。 |
| `R` | 恢复当前选中的 drop 块，或者从该 checkpoint 的归档块中选择一个；只恢复摘要。 |
| `F` | 确认后，从这次策展之前创建并切换到新的 Pi session。 |
| `Left` / `Esc` | 从详情返回 History 列表。 |
| `Q` | 从任意页面关闭 History。 |

浏览 History 不会调用模型，也不会把 metadata 或被 drop 的内容放回 active context。Restore 只会加入用户明确选择的归档摘要，并记录来源 checkpoint ID。Fork 不会删除或移动原 session。

第一版有意限制在当前分支。`handoff` 会创建具有独立分支的子 session，因此 History 不会静默跨到父 session。精确恢复某个块的完整原聊天、跨 session 建立索引都需要后续 provenance schema；如果需要完整的压缩前历史，请使用 `F` 或 `/curate undo`。

## 自动模式与聊天优先级

`triggerMode` 决定 Curator 由用户手动调用还是根据压力自动打开。

### `manual`——默认

- 只有用户执行 `/curate` 才会运行 Curator。
- 阈值只显示状态或提醒。
- Pi 原生阈值/溢出压缩使用 Curator 当前生效的分析模型和 thinking（含 session 覆盖），保留 Pi 的原生摘要与切分机制。

### `auto`

内置默认值包含三个压力阶段：

| 上下文用量 | 行为 |
| --- | --- |
| `65%`（`notifyPercent`） | 只显示状态提醒。 |
| `80%`（`strongNotifyPercent`） | 自动分析，并在强提醒区间最多打开一次 Curator。 |
| `92%`（`emergencyPercent`） | 紧急区最多再打开一次，并显示 `B` 原生兜底操作。 |
| Pi 自身限制 | 如果用户跳过 Curator 或突然溢出抢先发生，Pi 原生 compaction 仍然可以运行。 |

Curator 是模态窗口：不能直接在窗口内部使用普通 composer 输入新聊天内容。但它不会锁住用户：

- `Esc` / `Q` 会跳过这次自动策展并返回聊天；
- 同一个压力区间不会反复弹窗；
- 进入紧急区后最多再提供一次 Curator；
- 新到达的排队输入拥有更高优先级，会终止自动分析或关闭窗口，然后正常继续；
- 完成 compaction、切换 session，或者用量下降到强提醒阈值以下后，自动门控会重置。

即使使用 `auto`，Apply 也始终是手动操作。

## 保留模式

### `summary`

保留分析模型生成的摘要，以及经过原始来源校验的短证据字符串。

### `exact`

在 `<verbatim-context>` 中保留完整原始来源单元。适合不能安全改写的用户约束、路径、命令、哈希、错误和验证证据。

### `drop`

从模型 active context 排除该块。块摘要和来源指针仍保存在 checkpoint metadata 中，因此之后可以通过 `/curate restore` 恢复摘要。

默认 `archiveIndex: false`，被排除块的标题和摘要不会重新泄漏到模型可见 checkpoint 中。

## 应用方式

### `boundary`——默认

在当前 session 中追加普通 Pi compaction boundary。确定性 checkpoint 替代历史前缀，raw tail 保持原样。

### `handoff`

创建一个干净子 session，先写入 checkpoint，再精确复制保留的 raw-tail 消息。子 session 会引用父 session 作为来源，但不会把父 session 的更早 entry 导入 active context。适合明确进入一个新工作阶段时使用。

两种方式都不会删除或改写原始 append-only 历史。

## 连续策展与兜底边界

会话自动触发的 `threshold` 和 `overflow` 压缩会调用 Pi 导出的 `compact()`，模型和 thinking 实时取自 `/curate settings`。Curator 弹窗设为手动或自动时均生效。这条路径不生成交互树：来源准备、近期原文保留、旧摘要更新、跨轮次摘要和溢出重试仍由 Pi 负责。选择 Curator 分析模型也表示授权将自动压缩内容发送给该模型，跨 provider 时不会另弹确认窗。

模型不可用、认证或摘要调用失败时会警告，并退回主聊天模型；取消则停止压缩。禁用 Curator 时停止模型路由。手动 `/compact`、紧急 `B`、其他扩展带专用标记的请求保留原行为；Curator Apply 仍直接写入已审阅的 checkpoint，不再交给模型重写。`/curate status` 可查看自动压缩路由，原生结果不会作为交互 checkpoint 出现在 `/curate history`。

接法参考 [pi-compaction-model](https://github.com/JMHSV/pi-compaction-model)：直接调用 Pi 原生算法，集成在 Curator 内共享模型设置。不要同时启用其他接管相同自动压缩事件的插件（包括 pi-vcc 的 `overrideDefaultCompaction`），否则 Pi 后执行的 handler 可能覆盖前面的结果。

`/curate` 读取的是 Pi 经过 compaction 解析后的 `buildContextEntries()`，绝不会直接扫描完整 JSONL transcript。完成一次 Curator checkpoint 后，下一次 Curator 能看到的内容如下：

| 上一次结果 | 下一次 Curator 能看到什么 |
| --- | --- |
| `summary` | 只有已经编译的摘要和接受的原样证据，看不到摘要背后的原聊天。 |
| `exact` | 上次 verbatim block 中明确选择的原始来源文本。 |
| `drop` | 完全看不到该块；归档 metadata 仍在模型不可见区域，除非用户明确恢复。 |
| raw tail | 最近保留的消息继续原样存在，直到之后进入新的可压缩前缀。 |
| 后续工作 | Checkpoint 之后新增的消息正常进入上下文。 |

只有显式执行 `/curate undo` 等分支操作才会让完整旧历史重新成为 active context；`/curate restore` 只恢复用户选中的归档摘要。启用 `archiveIndex: true` 时，会有意暴露归档标题和来源数量，但不会暴露归档摘要。

兜底行为与 Curator 行为明确分离：

| 情况 | 边界行为 |
| --- | --- |
| 手动模式且没有打开 Curator | Pi threshold/overflow 原生 compaction 保持不变。 |
| 跳过自动 Curator | Pi 原生 compaction 继续作为最终兜底。 |
| Curator 打开期间到达新输入或完成了其他 compaction | 无论手动还是自动 Curator 都会立即关闭，旧方案不能 Apply。 |
| 紧急区按 `B` | 不附加 Curator 指令，直接运行 Pi 原生 compaction。 |
| Curator Apply 与其他 compaction 竞态 | Leaf identity 和 pending plan ID 会阻止过期或无关结果写入。 |

原生兜底只会摘要当时的 active context，因此不会重新引入之前已经 `drop` 的块；但它可能改写先前的 `exact` 块，因为 Pi 原生 compaction 不理解 Curator 的保留模式。如果某段内容必须跨下一次压缩继续逐字保留，应再次使用 Curator 并把它设为 `exact`，不要选择原生兜底。

## 语言切换

可以在 `/curate settings` 或 JSON 配置中把 `language` 设为 `zh` 或 `en`。

语言设置会控制：

- 设置窗口和 Curator 窗口；
- loading、进度、状态、警告和错误；
- 新编译 checkpoint 的标题与 metadata；
- 分析模型生成标题、摘要和理由时要求使用的语言。

在设置窗口中切换后会立即重绘。原始 raw tail 和原样证据永远不会被翻译，已有 checkpoint 也不会被追溯改写。

## 分析模型与 Provider

分析器直接通过 Pi ModelRegistry 调用。插件没有自己实现另一套 Provider client 或凭据存储。

- `analyzerModel` 使用 `provider/model-id` 格式。
- 设置窗口会列出 Pi 当前已经认证并可用的模型。选择器使用 Pi 原生模糊搜索，每次固定显示 10 行，并使用标准选择按键上下滚动。
- Thinking 选项来自所选模型的 Pi metadata，切换模型时会自动 clamp。
- 默认选择器是 `deepseek/deepseek-v4-flash`；如果你的 Pi 没有这个模型，请在设置中更换。
- `confirmCrossProvider: true` 时，如果分析器 Provider 与当前聊天 Provider 不同，每个 Pi 进程、每个分析模型第一次发送前会询问一次。

可压缩历史本身可能包含敏感信息，请只选择你认可其隐私和数据保留条款的分析 Provider。

## 配置

全局配置：

```text
~/.pi/agent/context-curator.json
```

受信任项目的覆盖配置：

```text
<project>/.pi/context-curator.json
```

有效优先级：

```text
当前 session 弹窗 override
  → 受信任项目 JSON
  → 全局 JSON
  → 内置默认值
```

Session override 会保存为 Pi custom entry，跟随 session 分支历史，并且不会被转换成 LLM message。

`/curate settings` 默认打开 Session 层。按 `Tab` 在 `Global → Project → Session` 之间切换，`S` 保存当前层，`R` 只清除当前层中由弹窗管理的字段。Pi 尚未信任当前项目时，Project 层不可用。Global 与 Project 保存会更新各自 JSON，同时保留弹窗未暴露的高级字段。每层只保存相对父层不同的值，因此以后修改父层时，未覆盖字段仍会正常继承。

内置默认配置示例：

```json
{
  "enabled": true,
  "language": "zh",
  "analyzerModel": "deepseek/deepseek-v4-flash",
  "thinkingLevel": "low",
  "triggerMode": "manual",
  "confirmCrossProvider": true,
  "maxConcurrentAnalyzerCalls": 3,
  "rawTailTokens": 16000,
  "targetCheckpointTokens": 24000,
  "maxAnalyzerInputTokens": 600000,
  "maxBlocksPerSplit": 3,
  "archiveIndex": false,
  "notifyPercent": 65,
  "strongNotifyPercent": 80,
  "emergencyPercent": 92,
  "defaultApplyMode": "boundary"
}
```

| 字段 | 含义 |
| --- | --- |
| `enabled` | 启用命令和阈值行为。 |
| `language` | `zh` 或 `en`，控制显示和生成摘要语言。 |
| `analyzerModel` | Pi ModelRegistry 中的 `provider/model-id` 选择器。 |
| `thinkingLevel` | 请求的 Pi thinking level，会按模型能力 clamp。 |
| `triggerMode` | `manual` 或 `auto`。 |
| `confirmCrossProvider` | 每个 Pi 进程首次向不同 Provider 的分析器发送历史前确认。 |
| `maxConcurrentAnalyzerCalls` | 分层分析局部分组的并发数，范围 1–4。 |
| `rawTailTokens` | 最新、始终原样保留历史的目标大小。 |
| `targetCheckpointTokens` | checkpoint 超过该目标后，Apply 需要确认。 |
| `maxAnalyzerInputTokens` | 超过该直接分析阈值后改用分层分组。 |
| `maxBlocksPerSplit` | 每次决策最多 2 或 3 个块。 |
| `archiveIndex` | 是否在可见 checkpoint 中包含归档块标题、ID 和来源数量。 |
| `notifyPercent` | 状态提醒阈值。 |
| `strongNotifyPercent` | 自动 Curator 强提醒区阈值。 |
| `emergencyPercent` | 紧急区阈值，也是显示 `B` 的最低阈值。 |
| `defaultApplyMode` | `boundary` 或 `handoff`。 |

旧版 `autoOpenMode` 仍然可以读取：`popup` 映射为 `auto`，`suggest` 和 `off` 映射为 `manual`。

## 大上下文分析

如果历史前缀同时没有超过 `maxAnalyzerInputTokens`，并且低于所选模型在 Pi 中报告 context window 的 80%，插件会使用一次全局分析。

更大的前缀使用受控分层流程：

1. 把来源单元分成相互独立的组；
2. 以不超过 `maxConcurrentAnalyzerCalls` 的并发分析各组；
3. 使用一次全局 merge 恢复一致的最终 2–3 块结构；
4. 把局部分析获得的原样证据带入最终块。

只有相互独立的第一阶段分组会并发。用户主动进行的递归细拆仍是独立分析调用。

## 可靠性与恢复

- 每个来源单元必须在分析结果中恰好出现一次。
- 无效的分析模型 JSON 会重试一次，之后拒绝使用。
- 证据字符串只有确实存在于原始来源中才会被保留。
- 递归细拆读取原始来源单元，不会摘要再摘要。
- 单个超大来源单元会先无损切成连续片段，再进行语义拆分。
- 保留快照身份，并在 Apply 前重新检查 session leaf。
- 新输入会使活动中的自动 Curator 失效，旧结果不会继续显示或应用。
- 排除高风险块、排除所有块、破坏依赖或者超过 checkpoint 目标，需要再次按 `A`。
- 已接受的块保存为结构化 ledger，下一次策展可以再次独立展开。
- `/curate undo` 只移动分支指针，不删除历史。
- `/curate restore` 可以重新引入归档摘要。

## 实际限制

- 模型摘要仍然是模型输出，应用前必须人工检查。
- 分析模型偶尔可能不遵循输出语言；插件不会做严格语言拒绝，因为路径、技术词和原样证据可能合理地包含另一种文字。
- 反复递归细拆会增加延迟和分析 token 消耗。
- 插件减少的是 active context，不会缩小磁盘上的 append-only session。
- 突然的上下文溢出可能让 Pi 原生 compaction 先于自动 Curator 触发。
- 交互式决策必须使用 TUI。

## 开发

```bash
bun test ./tests
bun run check
```

`bun run check` 会执行严格 TypeScript 检查和 Bun bundle smoke build。测试覆盖配置、双语 UI、来源 ledger、分析器调度、分层并发、压力区门控、新输入抢占、原生兜底、overlay 输入、checkpoint 编译和扩展注册。
