# Curator History 规格

[English](history.md)

状态：checkpoint metadata version 1 的 MVP 已实现。

## 目标

`/curate history` 让连续多次策展可以审计，并允许用户在产生更新的 checkpoint 之后，仍然显式恢复任意旧 checkpoint 中的归档摘要。

History 属于控制面，不是 agent memory。仅仅打开或查看 History，绝不会把内容注入模型上下文。

Popup 仅支持 TUI。在 RPC、JSON 和 print mode 中，命令只提示当前限制并 fail closed，不会修改上下文。

## 数据来源

命令读取当前 Pi session 分支，并且只接受 `details` 满足以下条件的 `compaction` entry：

```json
{
  "kind": "pi-context-curator",
  "version": 1
}
```

Pi 原生 compaction、损坏的 metadata 和不在当前分支上的 entry 都会被忽略。结果按从新到旧排列，不会改写底层 append-only session。

## 展示内容

列表页展示：

- checkpoint 时间和 focus；
- 策展前后的预计 token；
- `summary`、`exact`、`drop` 叶子数量。

详情页额外展示：

- 分析模型、策展指令和 source hash；
- 已持久化的决策树；
- 每个节点的保留方式与摘要。

长文本必须按 popup 宽度换行并限制纵向行数，不能挤掉导航区域。

## 操作与不变量

### 浏览

- 不调用模型。
- 不追加 session entry。
- 不向模型 active context 添加任何内容。

### 恢复归档摘要

- 必须显式按 `R`；没有直接选中 drop 叶子时，还必须显式选择归档块。
- 只恢复归档摘要，绝不恢复原始 transcript。
- 追加一条模型可见 custom message，并记录 checkpoint entry ID、checkpoint 时间、block ID、标题、摘要和 source-unit IDs。
- 真正写入前必须在当前分支中重新解析 checkpoint；分支变化时不执行恢复。

### 从策展前 fork

- 必须显式确认。
- 使用所选 compaction entry 的 `parentId`，并调用 Pi 的 `fork(..., { position: "at" })`。
- 创建并切换到新的 session 文件。
- 不删除或改写原 session 及其后续 entry。

## 兼容性边界

Version 1 metadata 保存了归档摘要和 source-unit IDs，但没有保存稳定的 `sourceUnit -> entry/range/hash` provenance 映射。因此 version 1 支持恢复摘要，不支持精确恢复单个块的完整原聊天。

History 只读取当前分支，不会静默跨到 `handoff` 的父 session。需要完整的压缩前历史时，可以从 History fork；最近一次 checkpoint 也可以使用 `/curate undo`。

## 延后的 version 2

后续 provenance schema 可以加入：

```json
{
  "planId": "...",
  "parentPlanId": "...",
  "sourceRefs": [
    {
      "unitId": "u0003.2",
      "entryIds": ["..."],
      "hash": "...",
      "range": [1200, 3600]
    }
  ]
}
```

只有具备这套 schema，精确恢复单个块或者建立跨 session History 索引才足够可靠。

## 验收条件

- 当前分支的全部有效 Curator checkpoint 按从新到旧显示。
- 原生或损坏的 compaction 不会让 History 崩溃或混入错误记录。
- 查看 History 对模型上下文没有副作用。
- 可以显式恢复任意列表 checkpoint 的归档摘要，而不只是最新一次。
- Restore 会记录准确的来源 checkpoint。
- Fork 指向策展前父节点，并且要求确认。
- Popup 打开期间 session 变化时必须 fail closed。
- 中英文 UI 和文档描述完全一致。
