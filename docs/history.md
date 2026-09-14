# Curator History Specification

[简体中文](history.zh-CN.md)

Status: implemented MVP for checkpoint metadata version 1.

## Purpose

`/curate history` makes repeated curation auditable and allows an explicitly selected archived summary to be recovered after newer curation checkpoints have been created.

History is a control-plane view. It is not agent memory and is never injected into model context merely because it was opened or inspected.

The popup is TUI-only. In RPC, JSON, and print modes the command fails closed with a notice and changes no context.

## Source of truth

The command reads the active Pi session branch and selects only `compaction` entries whose `details` satisfy:

```json
{
  "kind": "pi-context-curator",
  "version": 1
}
```

Native Pi compactions, malformed metadata, and entries from inactive branches are ignored. Results are presented newest first. The underlying append-only session is not rewritten.

## User-visible data

The list view exposes:

- checkpoint time and focus;
- estimated tokens before and after curation;
- counts of `summary`, `exact`, and `drop` leaves.

The detail view additionally exposes:

- analyzer model, curation instruction, and source hash;
- the persisted decision tree;
- each node's retention mode and summary.

Long text must wrap to the popup width and be bounded vertically so it cannot displace navigation controls.

## Actions and invariants

### Browse

- Makes no model call.
- Appends no session entry.
- Adds nothing to active model context.

### Restore archived summary

- Requires an explicit `R` action and, when no dropped leaf is selected, an explicit block selection.
- Restores only the archived summary, never the original transcript.
- Appends a model-visible custom message containing provenance: checkpoint entry ID, checkpoint creation time, block ID, title, summary, and source-unit IDs.
- Re-resolves the selected checkpoint against the current branch before mutation. If the branch changed, no restore occurs.

### Fork before curation

- Requires explicit confirmation.
- Uses the selected compaction entry's `parentId` and Pi's `fork(..., { position: "at" })` API.
- Creates and switches to a new session file.
- Never deletes or rewrites the original session or its newer entries.

## Compatibility boundary

Version 1 metadata retains archived summaries and source-unit IDs, but not a stable `sourceUnit -> entry/range/hash` provenance map. Therefore version 1 supports summary recovery, not exact per-block transcript recovery.

History is current-branch only. It does not silently traverse a `handoff` parent session. Complete pre-curation recovery remains available through a history fork or `/curate undo` for the latest checkpoint.

## Deferred version 2 work

A future provenance schema may add:

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

That schema is required before exact block restoration or a cross-session history index can be considered reliable.

## Acceptance criteria

- All valid Curator checkpoints on the active branch appear newest first.
- Native and malformed compactions cannot crash or pollute History.
- Inspecting History has no model-context side effect.
- An archived summary from any listed checkpoint, not only the newest, can be restored explicitly.
- Restore records its exact source checkpoint.
- Fork targets the pre-curation parent and asks for confirmation.
- Session changes while the popup is open fail closed.
- English and Chinese UI and documentation describe identical behavior.
