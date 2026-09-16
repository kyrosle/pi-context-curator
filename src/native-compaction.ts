import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { compact, type ExtensionContext, type SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import type { CuratorConfig } from "./types";
import { localize } from "./i18n";

// Use Pi's preparation and summarizer; only select the model for automatic runs.
export async function compactAutomatically(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  config: CuratorConfig,
  summarize: typeof compact = compact,
) {
  if (!config.enabled || !["threshold", "overflow"].includes(event.reason) || event.customInstructions) return;
  if (event.signal.aborted) return { cancel: true };
  try {
    const slash = config.analyzerModel.indexOf("/");
    const model = ctx.modelRegistry.find(config.analyzerModel.slice(0, slash), config.analyzerModel.slice(slash + 1));
    if (!model) throw new Error(`Model not found: ${config.analyzerModel}`);
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) throw new Error(auth.error);

    // Pi skips file details from extension-generated checkpoints. Carry forward
    // only our own native results, never Curator's archived/dropped block ledger.
    const previous = event.branchEntries.findLast((entry) => entry.type === "compaction");
    const details = previous?.type === "compaction" ? previous.details as Record<string, unknown> | undefined : undefined;
    const fileOps = {
      ...event.preparation.fileOps,
      read: new Set(event.preparation.fileOps.read),
      edited: new Set(event.preparation.fileOps.edited),
    };
    if (details?.kind === "pi-context-curator-native") {
      for (const [key, target] of [["readFiles", fileOps.read], ["modifiedFiles", fileOps.edited]] as const) {
        const paths = details[key];
        if (Array.isArray(paths)) for (const path of paths) if (typeof path === "string") target.add(path);
      }
    }
    const provider = ctx.modelRegistry.getProvider(model.provider);
    const headers = auth.headers ? Object.fromEntries(
      Object.entries(auth.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    ) : undefined;
    const sessionId = ctx.sessionManager.getSessionId();
    const requestHeaders = model.provider === "opencode-go"
      ? { ...headers, "x-opencode-session": sessionId, "x-opencode-client": "pi" }
      : headers;
    const result = await summarize(
      { ...event.preparation, fileOps }, model, auth.apiKey, requestHeaders,
      event.customInstructions, event.signal, clampThinkingLevel(model, config.thinkingLevel),
      provider ? (selected, context, options) => provider.streamSimple(selected, context, options) : undefined,
      auth.env, undefined, undefined, sessionId,
    );
    if (event.signal.aborted) return { cancel: true };
    return { compaction: { ...result, details: {
      ...(result.details && typeof result.details === "object" ? result.details : {}),
      kind: "pi-context-curator-native", model: config.analyzerModel,
    } } };
  } catch (error) {
    if (event.signal.aborted) return { cancel: true };
    const message = localize(config.language,
      `自动压缩模型 ${config.analyzerModel} 失败，交回 Pi 使用主聊天模型：${String(error)}`,
      `Automatic compaction with ${config.analyzerModel} failed; Pi will use the conversation model: ${String(error)}`);
    if (ctx.hasUI) ctx.ui.notify(message, "warning");
    else console.warn(message);
    return;
  }
}
