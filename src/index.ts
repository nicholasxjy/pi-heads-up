import { join } from "node:path";
import type { Api, AssistantMessage, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import {
  convertToLlm,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type AutocompleteItem, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  buildReviewPayload,
  buildTranscript,
  CLOSING_REVIEW_PROMPT,
  messageText,
  noteLabel,
  parseNoteResult,
  REVIEW_PROMPT,
  type Note,
} from "./review.ts";
import { Store } from "./store.ts";

const TOOL_ROUNDS_PER_CHECK = 6;
const MIN_RESULTS_FOR_CLOSING_CHECK = 3;
const WIDGET = "pi-heads-up";
const REVIEW_HINT = "/heads-up to review";
const MAX_PREVIEW_LINES = 3;
const USAGE_TEXT = "Usage: /heads-up [on|off|status|model [provider/id|auto]|history|clear]";

const SUBCOMMANDS: ReadonlyArray<{ name: string; description: string }> = [
  { name: "on", description: "Enable Heads Up suggestions" },
  { name: "off", description: "Disable Heads Up suggestions" },
  { name: "status", description: "Show status, active review model, and last review result" },
  { name: "model", description: "Choose or reset the review model (provider/id or auto)" },
  { name: "history", description: "Inspect or manage recorded project notes" },
  { name: "clear", description: "Clear recorded note history for this project" },
];

type ModelSource = Pick<AssistantMessage, "provider" | "model">;
type ReviewTrigger = "mid-task" | "closing";

interface ReviewDiagnostic {
  at: number;
  trigger: ReviewTrigger;
  model: string;
  status: "note" | "none" | "deduped" | "parse_failed" | "timeout" | "aborted" | "error";
  detail?: string;
}

interface ResolvedReviewModel {
  model: Model<Api> | undefined;
  configured?: string;
  fallbackReason?: "invalid_spec" | "not_found" | "missing_auth";
}

function noteColor(note: Note) {
  return note.kind === "heads_up" ? "warning" : "accent";
}

function formatModelId(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}

export default function headsUp(pi: ExtensionAPI) {
  const store = new Store(join(getAgentDir(), "pi-heads-up", "state.sqlite"));
  const temporary = new Store(":memory:");
  let toolRounds = 0;
  let resultsSinceReview = 0;
  let closingTranscript = "";
  let finalTurn: ModelSource | undefined;
  let finalAssistantMessage: AssistantMessage | undefined;
  let reviewAfter: ModelSource | undefined;
  let pending: AbortController | undefined;
  let lifetime = new AbortController();
  let visible: { note: Note; notes: Store } | undefined;
  let latestCtx: ExtensionContext | undefined;
  let lastReview: ReviewDiagnostic | undefined;

  function activeNotesStore(ctx: ExtensionContext): Store {
    return ctx.sessionManager.getSessionFile() ? store : temporary;
  }

  function resolveReviewModel(source: ModelSource | undefined, ctx: ExtensionContext): ResolvedReviewModel {
    const configured = store.reviewModel();
    let fallbackReason: ResolvedReviewModel["fallbackReason"];

    if (configured) {
      const slash = configured.indexOf("/");
      if (slash > 0 && slash < configured.length - 1) {
        const provider = configured.slice(0, slash);
        const id = configured.slice(slash + 1);
        const found = ctx.modelRegistry.find(provider, id);
        if (!found) {
          fallbackReason = "not_found";
        } else if (typeof ctx.modelRegistry.hasConfiguredAuth === "function" && !ctx.modelRegistry.hasConfiguredAuth(found)) {
          fallbackReason = "missing_auth";
        } else {
          return { model: found, configured };
        }
      } else {
        fallbackReason = "invalid_spec";
      }
    }

    if (ctx.model?.api === "pi-virtual") {
      return {
        model: source ? ctx.modelRegistry.find(source.provider, source.model) : undefined,
        configured,
        fallbackReason,
      };
    }
    return { model: ctx.model, configured, fallbackReason };
  }

  function render(ctx: ExtensionContext): void {
    const note = visible?.note;
    if (!note) {
      ctx.ui.setWidget(WIDGET, undefined);
      return;
    }
    ctx.ui.setWidget(WIDGET, (_tui, theme) => ({
      invalidate() {},
      render(width) {
        if (width < 2) return [];
        const label = `✦ ${noteLabel(note)}`;
        const prefix = `${label} · `;
        const prefixWidth = visibleWidth(prefix);
        const indent = width - prefixWidth >= 24 ? prefixWidth : 0;
        const bodyWidth = width - indent;
        const padding = " ".repeat(indent);
        const heading = theme.fg(noteColor(note), theme.bold(truncateToWidth(indent ? prefix : label, width, "…")));
        const lines = wrapTextWithAnsi(note.title, bodyWidth);
        const preview = lines.slice(0, MAX_PREVIEW_LINES);
        if (lines.length > MAX_PREVIEW_LINES) {
          const last = MAX_PREVIEW_LINES - 1;
          preview[last] = truncateToWidth(preview[last], bodyWidth - 1, "").trimEnd() + "…";
        }
        const hint = bodyWidth >= REVIEW_HINT.length ? REVIEW_HINT : truncateToWidth("/heads-up", bodyWidth, "…");
        const summary = preview.map((line, i) => (i === 0 && indent ? heading : padding) + theme.fg("muted", line));
        if (!indent) summary.unshift(heading);
        return [...summary, padding + theme.fg("muted", hint)];
      },
    }));
  }

  function clearEvidence(): void {
    toolRounds = 0;
    closingTranscript = "";
    finalTurn = undefined;
    finalAssistantMessage = undefined;
    reviewAfter = undefined;
  }

  function cancelCheck(): void {
    pending?.abort();
    clearEvidence();
  }

  function resetTask(ctx: ExtensionContext): void {
    cancelCheck();
    resultsSinceReview = 0;
    lifetime.abort();
    lifetime = new AbortController();
    visible = undefined;
    if (ctx.mode === "tui") render(ctx);
  }

  async function review(
    transcript: string,
    model: Model<Api> | undefined,
    ctx: ExtensionContext,
    trigger: ReviewTrigger,
    systemPrompt = REVIEW_PROMPT,
    reviewedResults = resultsSinceReview,
  ): Promise<void> {
    if (!transcript || !model || pending || visible) return;
    const controller = new AbortController();
    pending = controller;
    const modelName = formatModelId(model);
    const timeoutSignal = AbortSignal.timeout(45_000);
    const signals = [controller.signal, timeoutSignal];
    if (ctx.signal) signals.push(ctx.signal);
    const signal = AbortSignal.any(signals);

    try {
      if (ctx.signal?.aborted || !store.enabled()) return;
      const notes = activeNotesStore(ctx);
      const content = buildReviewPayload(transcript, notes.recent(ctx.cwd));
      const maxTokens = Math.min(model.reasoning ? 2_048 : 800, model.maxTokens);
      const reasoning = model.reasoning && model.thinkingLevelMap?.off === null ? "minimal" : undefined;
      const streamOptions: SimpleStreamOptions = {
        signal,
        maxTokens,
        cacheRetention: "none",
        ...(reasoning ? { reasoning } : {}),
      };
      const response = await ctx.modelRegistry.streamSimple(model, {
        systemPrompt,
        messages: [{
          role: "user",
          content,
          timestamp: Date.now(),
        }],
      }, streamOptions).result();

      if (signal.aborted || !store.enabled()) {
        lastReview = {
          at: Date.now(),
          trigger,
          model: modelName,
          status: timeoutSignal.aborted ? "timeout" : "aborted",
        };
        return;
      }

      if (response.stopReason === "error" || response.stopReason === "aborted") {
        lastReview = {
          at: Date.now(),
          trigger,
          model: modelName,
          status: response.stopReason,
          detail: response.errorMessage,
        };
        return;
      }

      const parsed = parseNoteResult(response);
      if (parsed.status === "invalid") {
        lastReview = {
          at: Date.now(),
          trigger,
          model: modelName,
          status: "parse_failed",
          detail: parsed.reason,
        };
        return;
      }

      resultsSinceReview = Math.max(0, resultsSinceReview - reviewedResults);
      if (parsed.status === "none") {
        lastReview = { at: Date.now(), trigger, model: modelName, status: "none" };
        return;
      }

      if (!notes.remember(ctx.cwd, parsed.note)) {
        lastReview = {
          at: Date.now(),
          trigger,
          model: modelName,
          status: "deduped",
          detail: parsed.note.topic,
        };
        return;
      }

      lastReview = {
        at: Date.now(),
        trigger,
        model: modelName,
        status: "note",
        detail: parsed.note.topic,
      };
      visible = { note: parsed.note, notes };
      render(ctx);
    } catch (error) {
      // Review failures must not interrupt the main task.
      if (timeoutSignal.aborted) {
        lastReview = { at: Date.now(), trigger, model: modelName, status: "timeout" };
      } else if (signal.aborted) {
        lastReview = { at: Date.now(), trigger, model: modelName, status: "aborted" };
      } else {
        const detail = error instanceof Error ? error.message : String(error);
        lastReview = { at: Date.now(), trigger, model: modelName, status: "error", detail };
      }
    } finally {
      if (pending === controller) pending = undefined;
    }
  }

  pi.on("session_start", (event, ctx) => {
    latestCtx = ctx;
    if (ctx.mode === "tui") store.prune();
    if (event.reason !== "startup") resetTask(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    latestCtx = ctx;
    resetTask(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    latestCtx = undefined;
    resetTask(ctx);
    store.close();
    temporary.close();
  });
  pi.on("before_agent_start", (_event, ctx) => {
    latestCtx = ctx;
    resetTask(ctx);
  });
  pi.on("message_start", (event, ctx) => {
    latestCtx = ctx;
    // Pi can deliver a queued follow-up after a finished turn within the same run.
    if (finalTurn && event.message.role === "user") resetTask(ctx);
  });
  pi.on("agent_settled", (event, ctx) => {
    latestCtx = ctx;
    if (event.aborted) return cancelCheck();
    if (
      closingTranscript &&
      finalTurn &&
      resultsSinceReview >= MIN_RESULTS_FOR_CLOSING_CHECK &&
      !pending &&
      !visible &&
      !ctx.hasPendingMessages()
    ) {
      const replyText = finalAssistantMessage ? messageText(finalAssistantMessage) : "";
      const transcript = replyText
        ? `${closingTranscript}\n\nFinal assistant reply: ${replyText}`
        : closingTranscript;
      const resolved = resolveReviewModel(finalTurn, ctx);
      void review(transcript, resolved.model, ctx, "closing", CLOSING_REVIEW_PROMPT, resultsSinceReview);
    }
    clearEvidence();
  });
  pi.on("turn_end", (event, ctx) => {
    latestCtx = ctx;
    if (ctx.mode !== "tui") return;
    finalTurn = undefined;
    finalAssistantMessage = undefined;
    if (event.outcome !== "completed" || event.message.role !== "assistant") return;
    const { provider, model } = event.message;
    if (event.toolResults.length === 0) {
      if (event.message.stopReason === "stop") {
        finalTurn = { provider, model };
        finalAssistantMessage = event.message;
      }
      return;
    }
    resultsSinceReview += event.toolResults.length;
    closingTranscript = "";
    if (++toolRounds < TOOL_ROUNDS_PER_CHECK || pending || visible) return;
    toolRounds = 0;
    reviewAfter = { provider, model };
  });
  // Pi filters request context before this hook. The final reply has no such pass.
  pi.on("context_with_system", (event, ctx) => {
    latestCtx = ctx;
    finalTurn = undefined;
    finalAssistantMessage = undefined;
    closingTranscript = "";
    const previous = reviewAfter;
    reviewAfter = undefined;
    if (!previous && (resultsSinceReview < MIN_RESULTS_FOR_CLOSING_CHECK || pending || visible)) return;
    try {
      if (!store.enabled()) return;
      const transcript = buildTranscript(convertToLlm(event.messages));
      if (previous) {
        const resolved = resolveReviewModel(previous, ctx);
        void review(transcript, resolved.model, ctx, "mid-task", REVIEW_PROMPT, resultsSinceReview);
      }
      if (resultsSinceReview >= MIN_RESULTS_FOR_CLOSING_CHECK) closingTranscript = transcript;
    } catch {
      // An unavailable store or unreadable context must not interrupt Pi's request.
    }
  });

  function setEnabled(ctx: ExtensionContext, enabled: boolean): void {
    const wasEnabled = store.enabled();
    store.setEnabled(enabled);
    if (!enabled || !wasEnabled) cancelCheck();
    if (!enabled) {
      lifetime.abort();
      lifetime = new AbortController();
      visible = undefined;
      render(ctx);
    }
    ctx.ui.notify(enabled ? "Heads Up enabled" : "Heads Up disabled", "info");
  }

  function showStatus(ctx: ExtensionContext): void {
    const enabled = store.enabled();
    const resolved = resolveReviewModel(undefined, ctx);
    const notes = activeNotesStore(ctx);
    const { total, known } = notes.stats(ctx.cwd);

    let modelDesc = "auto (none active)";
    if (resolved.configured && !resolved.fallbackReason && resolved.model) {
      modelDesc = `${formatModelId(resolved.model)} (custom)`;
    } else if (resolved.configured && resolved.fallbackReason) {
      const fallback = resolved.model ? formatModelId(resolved.model) : (ctx.model ? formatModelId(ctx.model) : "none");
      modelDesc = `${resolved.configured} unavailable (${resolved.fallbackReason}); fallback: ${fallback}`;
    } else if (ctx.model) {
      modelDesc = ctx.model.api === "pi-virtual"
        ? `auto (physical model from ${formatModelId(ctx.model)})`
        : `auto (${formatModelId(ctx.model)})`;
    }

    const reviewSummary = lastReview
      ? `${lastReview.trigger}, ${lastReview.model}, ${lastReview.status}${lastReview.detail ? ` (${lastReview.detail})` : ""}`
      : "none yet";

    ctx.ui.notify(
      [
        `Heads Up: ${enabled ? "on" : "off"}`,
        `Review model: ${modelDesc}`,
        `Project history: ${total} note(s), ${known} known`,
        `Last review: ${reviewSummary}`,
      ].join("\n"),
      "info",
    );
  }

  async function configureModel(ctx: ExtensionContext, spec: string, signal: AbortSignal): Promise<void> {
    if (spec) {
      const lower = spec.toLowerCase();
      if (lower === "auto" || lower === "default" || lower === "reset") {
        store.setReviewModel(undefined);
        ctx.ui.notify("Heads Up review model set to auto (follow current model)", "info");
        return;
      }
      const slash = spec.indexOf("/");
      if (slash <= 0 || slash >= spec.length - 1) {
        ctx.ui.notify("Specify a model as provider/modelId or 'auto'", "warning");
        return;
      }
      const provider = spec.slice(0, slash);
      const id = spec.slice(slash + 1);
      const found = ctx.modelRegistry.find(provider, id);
      if (!found) {
        ctx.ui.notify(`Model not found: ${spec}`, "warning");
        return;
      }
      if (typeof ctx.modelRegistry.hasConfiguredAuth === "function" && !ctx.modelRegistry.hasConfiguredAuth(found)) {
        ctx.ui.notify(`No configured auth for model: ${formatModelId(found)}`, "warning");
        return;
      }
      const normalized = formatModelId(found);
      store.setReviewModel(normalized);
      ctx.ui.notify(`Heads Up review model set to ${normalized}`, "info");
      return;
    }

    const available = typeof ctx.modelRegistry.getAvailable === "function"
      ? ctx.modelRegistry.getAvailable()
      : [];
    const current = store.reviewModel();
    const autoLabel = "Auto (follow current model)";
    const modelOptions = available.map(formatModelId);
    const choice = await ctx.ui.select(
      `Review model · current: ${current ?? "auto"}`,
      [autoLabel, ...modelOptions],
      { signal },
    );
    if (!choice || signal.aborted) return;
    if (choice === autoLabel) {
      store.setReviewModel(undefined);
      ctx.ui.notify("Heads Up review model set to auto (follow current model)", "info");
      return;
    }
    store.setReviewModel(choice);
    ctx.ui.notify(`Heads Up review model set to ${choice}`, "info");
  }

  async function manageHistory(ctx: ExtensionContext, signal: AbortSignal): Promise<void> {
    const notes = activeNotesStore(ctx);
    while (!signal.aborted) {
      const items = notes.listNotes(ctx.cwd);
      if (items.length === 0) {
        ctx.ui.notify("No Heads Up history for this project", "info");
        return;
      }
      const entries = items.map((item) => ({
        item,
        label: `[${item.known ? "known" : "unseen"}] ${item.topic} · ${item.title}`,
      }));
      const pickedLabel = await ctx.ui.select(
        `Heads Up project history (${items.length})`,
        entries.map((entry) => entry.label),
        { signal },
      );
      if (!pickedLabel || signal.aborted) return;
      const selected = entries.find((entry) => entry.label === pickedLabel)?.item;
      if (!selected) return;

      const toggleLabel = selected.known ? "Mark as unseen" : "Mark as known";
      const action = await ctx.ui.select(
        `${selected.topic}\n\n${selected.title}`,
        [toggleLabel, "Delete note", "Back"],
        { signal },
      );
      if (!action || signal.aborted) return;
      if (action === "Back") continue;
      if (action === toggleLabel) {
        const nextKnown = !selected.known;
        notes.setKnown(ctx.cwd, selected.topic, nextKnown);
        ctx.ui.notify(
          nextKnown ? `Marked '${selected.topic}' as known` : `Marked '${selected.topic}' as unseen`,
          "info",
        );
        return;
      }
      if (action === "Delete note") {
        notes.deleteNote(ctx.cwd, selected.topic);
        ctx.ui.notify(`Deleted note '${selected.topic}'`, "info");
        return;
      }
    }
  }

  async function clearHistory(ctx: ExtensionContext, signal: AbortSignal): Promise<void> {
    const notes = activeNotesStore(ctx);
    const { total } = notes.stats(ctx.cwd);
    if (total === 0) {
      ctx.ui.notify("No Heads Up history to clear for this project", "info");
      return;
    }
    const confirmed = await ctx.ui.confirm(
      "Clear Heads Up history",
      `Delete ${total} recorded note(s) for this project?`,
      { signal },
    );
    if (!confirmed || signal.aborted) return;
    const removed = notes.clearProject(ctx.cwd);
    ctx.ui.notify(`Cleared ${removed} note(s) for this project`, "info");
  }

  pi.registerCommand("heads-up", {
    description: "Open a Heads Up note or manage suggestions, model, and project history",
    getArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
      const normalized = argumentPrefix.trimStart();
      if (normalized.startsWith("model ")) {
        const query = normalized.slice("model ".length).trimStart().toLowerCase();
        const available = typeof latestCtx?.modelRegistry.getAvailable === "function"
          ? latestCtx.modelRegistry.getAvailable()
          : [];
        const items: AutocompleteItem[] = [
          { value: "model auto", label: "auto", description: "Follow the current session model" },
          ...available.map((m) => ({
            value: `model ${formatModelId(m)}`,
            label: formatModelId(m),
            description: m.name,
          })),
        ];
        const matches = query
          ? items.filter((item) => item.label.toLowerCase().includes(query) || (item.description?.toLowerCase().includes(query) ?? false))
          : items;
        return matches.length > 0 ? matches : null;
      }

      const query = normalized.toLowerCase();
      const matches = SUBCOMMANDS
        .filter((cmd) => !query || cmd.name.startsWith(query))
        .map((cmd) => ({
          value: cmd.name,
          label: cmd.name,
          description: cmd.description,
        }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      latestCtx = ctx;
      if (ctx.mode !== "tui") return;
      const trimmed = args.trim();
      const [subcommand = "", ...rest] = trimmed.split(/\s+/u);
      const subArg = rest.join(" ").trim();
      const signal = lifetime.signal;

      if (subcommand === "on" || subcommand === "off") {
        if (subArg) {
          ctx.ui.notify(USAGE_TEXT, "warning");
          return;
        }
        setEnabled(ctx, subcommand === "on");
        return;
      }
      if (subcommand === "status") {
        if (subArg) {
          ctx.ui.notify(USAGE_TEXT, "warning");
          return;
        }
        showStatus(ctx);
        return;
      }
      if (subcommand === "model") {
        await configureModel(ctx, subArg, signal);
        return;
      }
      if (subcommand === "history") {
        if (subArg) {
          ctx.ui.notify(USAGE_TEXT, "warning");
          return;
        }
        await manageHistory(ctx, signal);
        return;
      }
      if (subcommand === "clear") {
        if (subArg) {
          ctx.ui.notify(USAGE_TEXT, "warning");
          return;
        }
        await clearHistory(ctx, signal);
        return;
      }
      if (trimmed) {
        ctx.ui.notify(USAGE_TEXT, "warning");
        return;
      }

      const enabled = store.enabled();
      const current = enabled ? visible : undefined;
      if (!current) {
        if (visible) {
          visible = undefined;
          render(ctx);
        }
        const toggleOption = enabled ? "Turn off suggestions" : "Turn on suggestions";
        const choice = await ctx.ui.select(
          enabled ? "Heads Up is on · No note to review" : "Heads Up is off",
          [toggleOption, "View status", "Configure review model", "View project history"],
          { signal },
        );
        if (!choice || signal.aborted) return;
        if (choice === toggleOption) {
          setEnabled(ctx, !enabled);
        } else if (choice === "View status") {
          showStatus(ctx);
        } else if (choice === "Configure review model") {
          await configureModel(ctx, "", signal);
        } else if (choice === "View project history") {
          await manageHistory(ctx, signal);
        }
        return;
      }

      const { note, notes } = current;
      const { theme } = ctx.ui;
      const title = `${theme.fg(noteColor(note), noteLabel(note))} · ${theme.fg("text", note.title)}`;
      ctx.ui.setWidget(WIDGET, undefined);
      try {
        let choice = await ctx.ui.select(title, ["Learn more", "Knew this already", "Dismiss"], { signal });
        if (choice === "Learn more" && !signal.aborted && visible === current) {
          const detail = `${title}\n\n${theme.fg("text", note.detail)}`;
          choice = await ctx.ui.select(detail, ["Understood", "Chat in main session", "Dismiss"], { signal });
        }
        if (!choice || signal.aborted || visible !== current) return;
        if (choice === "Knew this already" || choice === "Understood") notes.markKnown(ctx.cwd, note);
        if (choice === "Chat in main session") {
          const quoted = `> ${noteLabel(note)}: ${note.title}\n> ${note.detail}`;
          ctx.ui.setEditorText([ctx.ui.getEditorText(), quoted].filter(Boolean).join("\n\n") + "\n\n");
        }
        visible = undefined;
        render(ctx); // Refresh the editor after writing the quoted draft.
      } finally {
        if (visible === current) render(ctx);
      }
    },
  });
}
