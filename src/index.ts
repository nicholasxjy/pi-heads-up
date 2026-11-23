import { join } from "node:path";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
  convertToLlm,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { buildTranscript, noteLabel, parseNote, REVIEW_PROMPT, type Note } from "./review.ts";
import { Store } from "./store.ts";

const TOOL_ROUNDS_PER_CHECK = 6;
const MIN_RESULTS_FOR_CLOSING_CHECK = 3;
const WIDGET = "pi-heads-up";
const REVIEW_HINT = "/heads-up to review";
const MAX_PREVIEW_LINES = 3;

type ModelSource = Pick<AssistantMessage, "provider" | "model">;

function reviewModel(message: ModelSource, ctx: ExtensionContext): Model<Api> | undefined {
  if (ctx.model?.api === "pi-virtual") {
    return ctx.modelRegistry.find(message.provider, message.model);
  }
  return ctx.model;
}

function noteColor(note: Note) {
  return note.kind === "heads_up" ? "warning" : "accent";
}

export default function headsUp(pi: ExtensionAPI) {
  const store = new Store(join(getAgentDir(), "pi-heads-up", "state.sqlite"));
  const temporary = new Store(":memory:");
  let toolRounds = 0;
  let toolResults = 0;
  let reviewed = false;
  let closingTranscript = "";
  let finalTurn: ModelSource | undefined;
  let reviewAfter: ModelSource | undefined;
  let pending: AbortController | undefined;
  let lifetime = new AbortController();
  let visible: { note: Note; notes: Store } | undefined;

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
    toolResults = 0;
    closingTranscript = "";
    finalTurn = undefined;
    reviewAfter = undefined;
  }

  function cancelCheck(): void {
    pending?.abort();
    clearEvidence();
  }

  function resetTask(ctx: ExtensionContext): void {
    cancelCheck();
    reviewed = false;
    lifetime.abort();
    lifetime = new AbortController();
    visible = undefined;
    if (ctx.mode === "tui") render(ctx);
  }

  async function review(
    transcript: string,
    model: Model<Api> | undefined,
    ctx: ExtensionContext,
    systemPrompt = REVIEW_PROMPT,
  ): Promise<void> {
    if (!transcript || !model || pending || visible) return;
    const controller = new AbortController();
    pending = controller;
    try {
      if (ctx.signal?.aborted || !store.enabled()) return;
      const signals = [controller.signal, AbortSignal.timeout(45_000)];
      if (ctx.signal) signals.push(ctx.signal);
      const signal = AbortSignal.any(signals);
      const notes = ctx.sessionManager.getSessionFile() ? store : temporary;
      const content = JSON.stringify({ transcript, recentNotes: notes.recent(ctx.cwd) });
      reviewed = true;
      const response = await ctx.modelRegistry.complete(model, {
        systemPrompt,
        messages: [{
          role: "user",
          content,
          timestamp: Date.now(),
        }],
      }, { signal, maxTokens: Math.min(800, model.maxTokens), cacheRetention: "none" });
      if (signal.aborted || !store.enabled()) return;
      const note = parseNote(response);
      if (!note || !notes.remember(ctx.cwd, note)) return;
      visible = { note, notes };
      render(ctx);
    } catch {
      // Review failures must not interrupt the main task.
    } finally {
      if (pending === controller) pending = undefined;
    }
  }

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode === "tui") store.prune();
  });
  pi.on("session_tree", (_event, ctx) => resetTask(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    resetTask(ctx);
    store.close();
    temporary.close();
  });
  pi.on("before_agent_start", (_event, ctx) => resetTask(ctx));
  pi.on("message_start", (event, ctx) => {
    // Pi can deliver a queued follow-up after a finished turn within the same run.
    if (finalTurn && event.message.role === "user") resetTask(ctx);
  });
  pi.on("agent_settled", (event, ctx) => {
    if (event.aborted) return cancelCheck();
    if (closingTranscript && finalTurn && !reviewed && !ctx.hasPendingMessages()) {
      void review(closingTranscript, reviewModel(finalTurn, ctx), ctx,
        `${REVIEW_PROMPT}\nThe task has ended. The final reply is unavailable. Assess only the supplied evidence.`);
    }
    clearEvidence();
  });
  pi.on("turn_end", (event, ctx) => {
    if (ctx.mode !== "tui") return;
    finalTurn = undefined;
    if (event.outcome !== "completed" || event.message.role !== "assistant") return;
    const { provider, model } = event.message;
    if (event.toolResults.length === 0) {
      if (event.message.stopReason === "stop") finalTurn = { provider, model };
      return;
    }
    toolResults += event.toolResults.length;
    closingTranscript = "";
    if (++toolRounds < TOOL_ROUNDS_PER_CHECK || pending || visible) return;
    toolRounds = 0;
    reviewAfter = { provider, model };
  });
  // Pi filters request context before this hook. The final reply has no such pass.
  pi.on("context_with_system", (event, ctx) => {
    finalTurn = undefined;
    closingTranscript = "";
    const previous = reviewAfter;
    reviewAfter = undefined;
    if (!previous && (reviewed || toolResults < MIN_RESULTS_FOR_CLOSING_CHECK)) return;
    try {
      if (!store.enabled()) return;
      const transcript = buildTranscript(convertToLlm(event.messages));
      if (previous) void review(transcript, reviewModel(previous, ctx), ctx);
      if (!reviewed) closingTranscript = transcript;
    } catch {
      // An unavailable store or unreadable context must not interrupt Pi's request.
    }
  });

  function setEnabled(ctx: ExtensionContext, enabled: boolean): void {
    const wasEnabled = store.enabled();
    store.setEnabled(enabled);
    if (!enabled || !wasEnabled) cancelCheck();
    if (!enabled) {
      visible = undefined;
      render(ctx);
    }
    ctx.ui.notify(enabled ? "Heads Up enabled" : "Heads Up disabled", "info");
  }

  pi.registerCommand("heads-up", {
    description: "Open a Heads Up note or manage suggestions (on/off)",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") return;
      const argument = args.trim();
      if (argument === "on" || argument === "off") {
        setEnabled(ctx, argument === "on");
        return;
      }
      if (argument) {
        ctx.ui.notify("Usage: /heads-up [on|off]", "warning");
        return;
      }

      const signal = lifetime.signal;
      const enabled = store.enabled();
      const current = enabled ? visible : undefined;
      if (!current) {
        if (visible) {
          visible = undefined;
          render(ctx);
        }
        const choice = await ctx.ui.select(
          enabled ? "Heads Up is on · No note to review" : "Heads Up is off",
          [enabled ? "Turn off suggestions" : "Turn on suggestions"],
          { signal },
        );
        if (choice && !signal.aborted) setEnabled(ctx, !enabled);
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
