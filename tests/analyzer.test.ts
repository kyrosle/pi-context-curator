import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { analyzePartition } from "../src/analyzer";
import { DEFAULT_CONFIG } from "../src/config";
import type { SourceUnit } from "../src/types";

describe("analyzer dispatch", () => {
  test("uses Pi ModelRegistry and preserves a complete source partition", async () => {
    const units: SourceUnit[] = [
      { id: "u0001", entryIds: ["e1"], text: "constraint", tokens: 10, hash: "a" },
      { id: "u0002", entryIds: ["e2"], text: "validation", tokens: 10, hash: "b" },
    ];
    const model = {
      id: "deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      api: "openai-completions",
      provider: "deepseek",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 384_000,
    };
    let capturedOptions: Record<string, unknown> | undefined;
    let capturedContext: { systemPrompt?: string; messages: Array<{ content: Array<{ text: string }> }> } | undefined;
    const ctx = {
      modelRegistry: {
        find: () => model,
        getApiKeyAndHeaders: async () => ({ ok: true }),
        complete: async (
          _model: unknown,
          context: { systemPrompt?: string; messages: Array<{ content: Array<{ text: string }> }> },
          options: Record<string, unknown>,
        ) => {
          capturedContext = context;
          capturedOptions = options;
          return {
            role: "assistant",
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  blocks: [
                    {
                      title: "Requirements",
                      summary: "Keep the constraint.",
                      sourceUnitIds: ["u0001"],
                      recommendedMode: "drop",
                      risk: "high",
                      rationale: "Needed next.",
                      dependencies: [],
                      verbatimEvidence: ["constraint"],
                    },
                    {
                      title: "Evidence",
                      summary: "Keep validation status.",
                      sourceUnitIds: ["u0002"],
                      recommendedMode: "summary",
                      risk: "medium",
                      rationale: "Useful proof.",
                      dependencies: ["Requirements"],
                      verbatimEvidence: ["validation"],
                    },
                  ],
                }),
              },
            ],
            stopReason: "stop",
            timestamp: Date.now(),
          };
        },
      },
    } as unknown as ExtensionContext;

    const nodes = await analyzePartition(
      ctx,
      units,
      "finish validation",
      { ...DEFAULT_CONFIG, language: "en" },
      new AbortController().signal,
      undefined,
      undefined,
      "keep only validation evidence",
    );

    expect(nodes).toHaveLength(2);
    expect(nodes.flatMap((node) => node.sourceUnitIds)).toEqual(["u0001", "u0002"]);
    expect(capturedOptions?.reasoningEffort).toBe("low");
    expect(capturedOptions?.maxTokens).toBe(8_000);
    expect(capturedContext?.systemPrompt).toContain("in English");
    expect(capturedContext?.systemPrompt).toContain("recommend drop for unrelated blocks");
    expect(capturedContext?.messages[0]?.content[0]?.text).toContain("Output language: English");
    expect(capturedContext?.messages[0]?.content[0]?.text).toContain(
      'Curation instruction: "keep only validation evidence"',
    );
    expect(nodes[0]?.mode).toBe("drop");
  });

  test("runs independent hierarchy groups with bounded concurrency before one merge", async () => {
    const units: SourceUnit[] = [1, 2, 3].map((index) => ({
      id: `u000${index}`,
      entryIds: [`e${index}`],
      text: `source-${index}`,
      tokens: 60_000,
      hash: String(index),
    }));
    const model = {
      id: "deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      api: "openai-completions",
      provider: "deepseek",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 125_000,
      maxTokens: 384_000,
    };
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    const ctx = {
      modelRegistry: {
        find: () => model,
        getApiKeyAndHeaders: async () => ({ ok: true }),
        complete: async (_model: unknown, context: { messages: Array<{ content: Array<{ text: string }> }> }) => {
          calls++;
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 15));
          const prompt = context.messages[0]?.content[0]?.text ?? "";
          const ids = prompt.includes('"id":"m0001"')
            ? ["m0001", "m0002", "m0003"]
            : units.filter((unit) => prompt.includes(`"id":"${unit.id}"`)).map((unit) => unit.id);
          const blocks = ids[0]?.startsWith("m")
            ? [
                {
                  title: "Merged A",
                  summary: "First merged group.",
                  sourceUnitIds: ids.slice(0, 2),
                  recommendedMode: "summary",
                  risk: "medium",
                  rationale: "Relevant.",
                  dependencies: [],
                  verbatimEvidence: [],
                },
                {
                  title: "Merged B",
                  summary: "Second merged group.",
                  sourceUnitIds: ids.slice(2),
                  recommendedMode: "summary",
                  risk: "low",
                  rationale: "Optional.",
                  dependencies: [],
                  verbatimEvidence: [],
                },
              ]
            : [
                {
                  title: `Local ${ids[0]}`,
                  summary: "Local summary.",
                  sourceUnitIds: ids,
                  recommendedMode: "summary",
                  risk: "medium",
                  rationale: "Needed for merge.",
                  dependencies: [],
                  verbatimEvidence: [],
                },
              ];
          inFlight--;
          return {
            role: "assistant",
            content: [{ type: "text", text: JSON.stringify({ blocks }) }],
            stopReason: "stop",
            timestamp: Date.now(),
          };
        },
      },
    } as unknown as ExtensionContext;
    const progress: string[] = [];

    const nodes = await analyzePartition(
      ctx,
      units,
      "next phase",
      {
        ...DEFAULT_CONFIG,
        maxAnalyzerInputTokens: 600_000,
        maxConcurrentAnalyzerCalls: 2,
      },
      new AbortController().signal,
      undefined,
      (event) => progress.push(`${event.phase}:${event.completed}/${event.total}`),
    );

    expect(calls).toBe(4);
    expect(maxInFlight).toBe(2);
    expect(nodes.flatMap((node) => node.sourceUnitIds)).toEqual(["u0001", "u0002", "u0003"]);
    expect(progress).toContain("local:3/4");
    expect(progress.at(-1)).toBe("merge:4/4");
  });
});
