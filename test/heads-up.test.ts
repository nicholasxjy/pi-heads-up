import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { Api, AssistantMessage, Context, Message, Model, ToolResultMessage } from "@earendil-works/pi-ai";
import {
  createEventBus,
  discoverAndLoadExtensions,
  ExtensionRunner,
  type ExtensionContext,
  type ExtensionUIDialogOptions,
  type ExtensionUIContext,
  type ModelRegistry,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { REVIEW_PROMPT } from "../src/review.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const ORIGINAL_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
const tempDirs: string[] = [];

after(() => {
  if (ORIGINAL_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = ORIGINAL_AGENT_DIR;
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(prefix = "pi-heads-up-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeModel(maxTokens = 2048): Model<Api> {
  return {
    id: "mock-model",
    name: "Mock Model",
    api: "openai-responses",
    provider: "mock",
    baseUrl: "https://mock.local",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens,
  };
}

function assistantJson(value: unknown): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: JSON.stringify(value) }],
    api: "openai-responses",
    provider: "mock",
    model: "mock-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function toolResult(name = "read", text = "ok"): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: "tc-1",
    toolName: name,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.now(),
  };
}

const DEFAULT_LLM_MESSAGES: Message[] = [
  { role: "user", content: "Inspect the auth middleware", timestamp: 1 },
  {
    role: "assistant",
    content: [{ type: "toolCall", id: "tc-1", name: "read", arguments: { path: "auth.ts" } }],
    api: "openai-responses",
    provider: "mock",
    model: "mock-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 2,
  },
  toolResult("read", "export function auth() {}"),
];

interface CompleteCall {
  model: Model<Api>;
  context: Context;
  options: Record<string, unknown> | undefined;
}

interface SelectCall {
  title: string;
  options: string[];
  opts: ExtensionUIDialogOptions | undefined;
}

async function createHarness(opts: {
  agentDir: string;
  cwd?: string;
  extensions?: string[];
  mode?: ExtensionContext["mode"];
  sessionFile?: string;
  model?: Model<Api>;
  physicalModel?: Model<Api>;
  hasPendingMessages?: () => boolean;
  complete?: (model: Model<Api>, context: Context, options?: Record<string, unknown>) => Promise<AssistantMessage>;
  select?: (title: string, options: string[], opts?: ExtensionUIDialogOptions) => Promise<string | undefined>;
}) {
  const cwd = opts.cwd ?? opts.agentDir;
  process.env.PI_CODING_AGENT_DIR = opts.agentDir;
  const eventBus = createEventBus();
  const paths = [REPO_ROOT, ...(opts.extensions ?? [])];
  const loaded = await discoverAndLoadExtensions(paths, cwd, opts.agentDir, eventBus);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, paths.length);

  const completeCalls: CompleteCall[] = [];
  const selectCalls: SelectCall[] = [];
  const notifications: Array<{ message: string; type?: "info" | "warning" | "error" }> = [];
  const sentMessages: unknown[] = [];
  let editorText = "";
  let renderWidget: ((width: number) => string) | undefined;

  const model = opts.model ?? makeModel();
  const modelRegistry = {
    find: (provider: string, id: string) => {
      const physical = opts.physicalModel;
      return physical?.provider === provider && physical.id === id ? physical : undefined;
    },
    complete: async (m: Model<Api>, context: Context, options?: Record<string, unknown>) => {
      completeCalls.push({ model: m, context, options });
      if (opts.complete) return opts.complete(m, context, options);
      return assistantJson(null);
    },
  } as unknown as ModelRegistry;

  const sessionManager = {
    getSessionFile: () => opts.sessionFile,
  } as unknown as SessionManager;

  const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, cwd, sessionManager, modelRegistry);
  runner.bindCore(
    {
      sendMessage: (msg) => sentMessages.push({ kind: "custom", msg }),
      sendUserMessage: (content) => sentMessages.push({ kind: "user", content }),
      appendEntry: () => {},
      setSessionName: () => {},
      getSessionName: () => undefined,
      setLabel: () => {},
      getActiveTools: () => [],
      getAllTools: () => [],
      getSettings: () => ({}) as never,
      setActiveTools: () => {},
      refreshTools: () => {},
      getCommands: () => [],
      setModel: async () => true,
      getThinkingLevel: () => "off",
      setThinkingLevel: () => {},
    },
    {
      getModel: () => model,
      getScopedModels: () => [],
      isIdle: () => true,
      isProjectTrusted: () => true,
      getSignal: () => undefined,
      abort: () => {},
      hasPendingMessages: opts.hasPendingMessages ?? (() => false),
      shutdown: () => {},
      getContextUsage: () => undefined,
      compact: () => {},
      getSystemPrompt: () => "",
    },
  );

  const themeStub = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
  const uiStub: ExtensionUIContext = {
    select: async (title, options, dialogOpts) => {
      selectCalls.push({ title, options, opts: dialogOpts });
      return opts.select ? opts.select(title, options, dialogOpts) : undefined;
    },
    confirm: async () => false,
    input: async () => undefined,
    notify: (message, type) => {
      notifications.push({ message, type });
    },
    onTerminalInput: () => () => {},
    setStatus: () => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: (key, content) => {
      if (key !== "pi-heads-up") return;
      if (typeof content === "function") {
        const component = content(null as never, themeStub as never);
        renderWidget = (width) => component.render(width).join("\n");
      } else {
        renderWidget = content ? () => content.join("\n") : undefined;
      }
    },
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    custom: async () => undefined as never,
    pasteToEditor: () => {},
    setEditorText: (text) => {
      editorText = text;
    },
    getEditorText: () => editorText,
    editor: async () => undefined,
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    get theme() {
      return themeStub as never;
    },
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: true }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  };

  runner.setUIContext(uiStub, opts.mode ?? "tui");

  async function runCommand(args = ""): Promise<void> {
    const cmd = runner.getCommand("heads-up");
    assert.ok(cmd, "/heads-up command should be registered");
    await cmd.handler(args, runner.createCommandContext());
  }

  async function emitToolTurn(overrides?: {
    toolResults?: ToolResultMessage[];
    message?: AssistantMessage;
    outcome?: "completed" | "aborted" | "error";
    llmMessages?: Message[];
    boundaryMessages?: Message[];
    skipContext?: boolean;
  }): Promise<void> {
    await runner.emitBoundary(
      {
        type: "turn_end",
        turnIndex: 0,
        message: overrides?.message ?? assistantJson(null),
        toolResults: overrides?.toolResults ?? [toolResult()],
        messageEntryId: "m1",
        toolResultEntryIds: ["t1"],
        outcome: overrides?.outcome ?? "completed",
      },
      () => ({
        contextEntries: [],
        contextMessages: [],
        llmMessages: overrides?.boundaryMessages ?? DEFAULT_LLM_MESSAGES,
        pendingMessages: [],
        canContinue: false,
      }),
    );
    if (!overrides?.skipContext) await runner.emitContext(overrides?.llmMessages ?? DEFAULT_LLM_MESSAGES);
  }

  async function emitToolTurns(count: number, llmMessages?: Message[]): Promise<void> {
    for (let i = 0; i < count; i++) {
      await emitToolTurn({ llmMessages });
    }
  }

  async function finishTask(stopReason: AssistantMessage["stopReason"] = "stop", aborted = false) {
    await emitToolTurn({
      message: { ...assistantJson("UNFILTERED_FINAL"), stopReason },
      toolResults: [], boundaryMessages: [toolResult("read", "UNFILTERED_BOUNDARY")], skipContext: true,
    });
    await runner.emit({ type: "agent_settled", aborted });
  }

  return {
    runner,
    finishTask,
    completeCalls,
    selectCalls,
    notifications,
    sentMessages,
    getCurrentWidget: (width = 120) => renderWidget?.(width),
    getEditorText: () => editorText,
    setEditorText: (t: string) => {
      editorText = t;
    },
    runCommand,
    startTask: () => runner.emitBeforeAgentStart({ messageType: "user", prompt: "next task" }, { cwd }),
    emitToolTurn,
    emitToolTurns,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("pi-heads-up", { concurrency: false }, () => {
  it("defaults on and preserves an explicit opt-out across restart", async () => {
    const agentDir = makeTempDir();
    const dbPath = join(agentDir, "pi-heads-up", "state.sqlite");

    const h1 = await createHarness({
      agentDir,
      sessionFile: join(agentDir, "session.jsonl"),
      select: async () => undefined,
    });
    await h1.runner.emit({ type: "session_start", reason: "startup" });
    await h1.emitToolTurns(6);
    assert.equal(h1.completeCalls.length, 1);
    assert.equal(existsSync(dbPath), false);

    await h1.runCommand("invalid");
    assert.deepEqual(h1.notifications.at(-1), { message: "Usage: /heads-up [on|off]", type: "warning" });

    await h1.runCommand();
    assert.equal(h1.selectCalls.at(-1)?.title, "Heads Up is on · No note to review");
    assert.deepEqual(h1.selectCalls.at(-1)?.options, ["Turn off suggestions"]);

    await h1.runCommand("off");
    assert.deepEqual(h1.notifications.at(-1), { message: "Heads Up disabled", type: "info" });
    assert.equal(existsSync(dbPath), true);
    await h1.runner.emit({ type: "session_shutdown", reason: "quit" });

    // Restart with fresh extension instance against same agentDir
    const h2 = await createHarness({
      agentDir,
      sessionFile: join(agentDir, "session.jsonl"),
    });
    await h2.runner.emit({ type: "session_start", reason: "startup" });
    await h2.emitToolTurns(6);
    assert.equal(h2.completeCalls.length, 0);

    await h2.runCommand();
    assert.equal(h2.selectCalls.at(-1)?.title, "Heads Up is off");
    assert.deepEqual(h2.selectCalls.at(-1)?.options, ["Turn on suggestions"]);

    await h2.runCommand("on");
    assert.deepEqual(h2.notifications.at(-1), { message: "Heads Up enabled", type: "info" });
    await h2.emitToolTurns(6);
    assert.equal(h2.completeCalls.length, 1);
    await h2.runner.emit({ type: "session_shutdown", reason: "quit" });
  });

  it("isolates note titles and duplicate topics by project while sharing the global setting", async () => {
    const agentDir = makeTempDir();
    const projectA = makeTempDir();
    const projectB = makeTempDir();
    const note = { kind: "heads_up", topic: "cache", title: "Project A diagnostic", detail: "Cache is stale." };
    async function open(cwd: string, title: string) {
      return createHarness({
        agentDir, cwd, sessionFile: join(cwd, "session.jsonl"),
        complete: async () => assistantJson({ ...note, title }),
        select: async () => "Knew this already",
      });
    }
    const a = await open(projectA, note.title);
    await a.emitToolTurns(6);
    await a.runCommand();
    const b = await open(projectB, "Project B diagnostic");
    await b.emitToolTurns(6);
    assert.deepEqual(JSON.parse(String(b.completeCalls[0].context.messages[0].content)).recentNotes, []);
    assert.ok(b.getCurrentWidget()?.includes("Project B diagnostic"));
    await b.runCommand("off");
    await a.emitToolTurns(6);
    assert.equal(a.completeCalls.length, 1);
    await b.runCommand("on");
    await a.runner.emit({ type: "session_shutdown", reason: "quit" });
    await b.runner.emit({ type: "session_shutdown", reason: "quit" });
    const restarted = await open(projectA, note.title);
    await restarted.emitToolTurns(6);
    assert.deepEqual(JSON.parse(String(restarted.completeCalls[0].context.messages[0].content)).recentNotes, [
      { topic: note.topic, title: note.title, known: 1 },
    ]);
    assert.equal(restarted.getCurrentWidget(), undefined);
    await restarted.runner.emit({ type: "session_shutdown", reason: "quit" });
  });

  it("keeps legacy opt-out and expires unscoped notes without sending them to any project", async (t) => {
    const agentDir = makeTempDir();
    const dir = join(agentDir, "pi-heads-up");
    mkdirSync(dir);
    const db = new DatabaseSync(join(dir, "state.sqlite"));
    t.after(() => db.close());
    db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, enabled INTEGER NOT NULL);
      INSERT INTO settings VALUES ('heads-up', 0);
      CREATE TABLE notes (topic TEXT PRIMARY KEY, title TEXT NOT NULL, known INTEGER NOT NULL, seen_at INTEGER NOT NULL);`);
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    db.prepare("INSERT INTO notes VALUES (?, ?, 1, ?)").run("cache", "Legacy project title", now);
    const h = await createHarness({ agentDir, sessionFile: join(agentDir, "session.jsonl") });
    await h.emitToolTurns(3);
    await h.finishTask();
    assert.equal(h.completeCalls.length, 0);
    await h.runCommand("on");
    await h.emitToolTurns(6);
    assert.deepEqual(JSON.parse(String(h.completeCalls[0].context.messages[0].content)).recentNotes, []);
    assert.equal(db.prepare("SELECT title FROM notes").get()?.title, "Legacy project title");
    now += RETENTION_MS;
    await h.emitToolTurns(6);
    assert.equal(db.prepare("SELECT * FROM notes").all().length, 0);
    await h.runner.emit({ type: "session_shutdown", reason: "quit" });
  });

  it("requires six completed tool-result turns in TUI and stays inert in print/RPC modes", async () => {
    const agentDir = makeTempDir();

    // Enable in TUI first
    const setup = await createHarness({ agentDir });
    await setup.runCommand("on");
    await setup.runner.emit({ type: "session_shutdown", reason: "quit" });

    for (const mode of ["print", "json", "rpc"] as const) {
      const inert = await createHarness({ agentDir, mode });
      await inert.runner.emit({ type: "session_start", reason: "startup" });
      await inert.emitToolTurns(7);
      await inert.finishTask();
      await inert.runCommand("off");
      await inert.runCommand();
      assert.equal(inert.completeCalls.length, 0, `${mode} mode should not call complete`);
      assert.equal(inert.notifications.length, 0, `${mode} mode should not notify`);
      assert.equal(inert.selectCalls.length, 0, `${mode} mode should not prompt`);
      await inert.runner.emit({ type: "session_shutdown", reason: "quit" });
    }

    const tui = await createHarness({ agentDir, mode: "tui" });
    await tui.runner.emit({ type: "session_start", reason: "startup" });
    // Non-tool or non-completed turns do not count; 5 completed tool turns do not trigger
    await tui.emitToolTurn({ toolResults: [] });
    await tui.emitToolTurn({ outcome: "aborted" });
    await tui.emitToolTurn({ outcome: "error" });
    await tui.emitToolTurns(5);
    assert.equal(tui.completeCalls.length, 0);

    await tui.emitToolTurn();
    assert.equal(tui.completeCalls.length, 1);
    await tui.runner.emit({ type: "session_shutdown", reason: "quit" });
  });

  it("runs a non-blocking, tool-less review on the physical model using filtered, bounded context", async () => {
    const agentDir = makeTempDir();
    const model = makeModel(4096);
    const pending = deferred<AssistantMessage>();

    const h = await createHarness({
      agentDir,
      model: { ...model, id: "virtual", api: "pi-virtual" },
      physicalModel: model,
      sessionFile: join(agentDir, "session.jsonl"),
      complete: () => pending.promise,
    });
    await h.runner.emit({ type: "session_start", reason: "startup" });
    await h.runCommand("on");

    const hugeOldUser: Message = { role: "user", content: "old-" + "a".repeat(8_000), timestamp: 1 };
    const latestUser: Message = { role: "user", content: "LATEST_USER_REQUEST_MARKER", timestamp: 2 };
    const hugeTrailingTool = toolResult("bash", "out-" + "x".repeat(25_000));
    const messages: Message[] = [hugeOldUser, latestUser, hugeTrailingTool];

    await h.emitToolTurns(5, messages);
    const redacted = toolResult("bash", "REDACTED_MARKER");
    await h.emitToolTurn({ boundaryMessages: [...messages, redacted], skipContext: true });
    assert.equal(h.completeCalls.length, 0);
    await h.runner.emitContext(messages);
    assert.equal(h.completeCalls.length, 1);
    assert.equal(h.getCurrentWidget(), undefined);

    // Additional tool turns while pending do not spawn a second concurrent request
    await h.emitToolTurns(7, messages);
    assert.equal(h.completeCalls.length, 1);

    const call = h.completeCalls[0];
    assert.equal(call.model, model);
    assert.equal(call.context.systemPrompt, REVIEW_PROMPT);
    assert.equal("tools" in call.context, false);
    assert.equal(call.options?.cacheRetention, "none");
    assert.equal(call.options?.maxTokens, 800);
    assert.ok(call.options?.signal instanceof AbortSignal);

    const payload = JSON.parse(String(call.context.messages[0].content)) as {
      transcript: string;
      recentNotes: unknown[];
    };
    assert.ok(payload.transcript.length <= 20_000);
    assert.ok(payload.transcript.includes("LATEST_USER_REQUEST_MARKER"));
    assert.ok(payload.transcript.includes("tool result (bash): out-"));
    assert.ok(!payload.transcript.includes("REDACTED_MARKER"));

    pending.resolve(
      assistantJson({
        kind: "heads_up",
        topic: "Token Scope",
        title: "Missing scope check in auth middleware.",
        detail: "The handler accepts tokens without verifying the write scope.",
      }),
    );
    await new Promise((r) => setTimeout(r, 0));

    const widget = h.getCurrentWidget();
    assert.ok(widget?.includes("Heads up"));
    assert.ok(widget?.includes("Missing scope check in auth middleware."));
    assert.ok(widget?.includes("/heads-up to review"));

    // While a note is visible, more tool turns do not start another review
    await h.emitToolTurns(6);
    assert.equal(h.completeCalls.length, 1);
    await h.runner.emit({ type: "session_shutdown", reason: "quit" });
  });

  it("reviews one short settled task using only the last filtered evidence", async () => {
    const physical = makeModel();
    const response = deferred<AssistantMessage>();
    const agentDir = makeTempDir();
    const redactor = join(agentDir, "redactor.mjs");
    writeFileSync(redactor, `export default function (pi) {
      pi.on("context", (event) => ({ messages: event.messages.filter((m) => m.toolName !== "private") }));
    }`);
    const h = await createHarness({
      agentDir, extensions: [redactor], model: { ...physical, api: "pi-virtual", id: "virtual" },
      physicalModel: physical, complete: () => response.promise,
    });
    const results = [toolResult(), toolResult(), toolResult()];
    await h.emitToolTurn({ toolResults: results, llmMessages: [toolResult("read", "EARLIER_SNAPSHOT")] });
    await h.runner.emitContext([toolResult("read", "FILTERED_EVIDENCE"), toolResult("private", "PRIVATE_EVIDENCE")]);
    assert.equal(h.completeCalls.length, 0);
    await h.finishTask();
    assert.equal(h.completeCalls.length, 1);
    const call = h.completeCalls[0];
    assert.equal(call.model, physical);
    const { transcript } = JSON.parse(String(call.context.messages[0].content));
    assert.equal(transcript, "tool result (read): FILTERED_EVIDENCE");
    await h.runner.emit({ type: "agent_settled", aborted: false });
    assert.equal(h.completeCalls.length, 1);
    response.resolve(assistantJson({ kind: "heads_up", topic: "tests", title: "Only unit tests ran.", detail: "No integration run appeared." }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(h.getCurrentWidget()?.includes("Only unit tests ran."));
    await h.runner.emit({ type: "session_shutdown", reason: "quit" });
  });

  it("discards a closing review that returns after another task starts", async () => {
    const late = deferred<AssistantMessage>();
    const note = { kind: "heads_up", topic: "result", title: "Late task result", detail: "Only for the first task." };
    const h = await createHarness({ agentDir: makeTempDir(), complete: () => late.promise });
    await h.emitToolTurns(3);
    await h.finishTask();
    const signal = h.completeCalls[0].options?.signal as AbortSignal;
    await h.startTask();
    assert.ok(signal.aborted);
    late.resolve(assistantJson(note));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.getCurrentWidget(), undefined);
    await h.emitToolTurns(3);
    await h.finishTask();
    assert.deepEqual(JSON.parse(String(h.completeCalls[1].context.messages[0].content)).recentNotes, []);
    assert.ok(h.getCurrentWidget()?.includes(note.title));
    await h.runner.emit({ type: "session_shutdown", reason: "quit" });
  });

  it("skips closing checks for incomplete, queued, already reviewed and ineligible tasks", async () => {
    const agentDir = makeTempDir();
    let queued = false;
    const h = await createHarness({ agentDir, hasPendingMessages: () => queued });
    const start = h.startTask;
    await h.emitToolTurns(2);
    await h.finishTask();
    assert.equal(h.completeCalls.length, 0);
    for (const reason of ["error", "aborted", "length", "stop"] as const) {
      await start();
      await h.emitToolTurns(3);
      await h.finishTask(reason, reason === "stop");
      assert.equal(h.completeCalls.length, 0, reason);
    }
    await start();
    await h.emitToolTurns(3);
    queued = true;
    await h.finishTask();
    assert.equal(h.completeCalls.length, 0);
    queued = false;
    await start();
    await h.emitToolTurns(6);
    await h.finishTask();
    assert.equal(h.completeCalls.length, 1);
    await start();
    await h.emitToolTurns(6);
    await h.runCommand("off");
    await h.runCommand("on");
    await h.emitToolTurns(3);
    await h.finishTask();
    assert.equal(h.completeCalls.length, 2);
    await start();
    await h.emitToolTurns(3);
    await h.finishTask();
    assert.equal(h.completeCalls.length, 3);
    await h.runner.emit({ type: "session_shutdown", reason: "quit" });
  });

  it("starts a queued follow-up with its own tool count when Pi drains the queue before settling", async () => {
    const h = await createHarness({ agentDir: makeTempDir() });
    await h.emitToolTurns(3);
    await h.emitToolTurn({ toolResults: [], skipContext: true });
    const followUp: Message = { role: "user", content: "A quick follow-up", timestamp: Date.now() };
    await h.runner.emit({ type: "message_start", message: followUp });
    await h.runner.emitContext([followUp]);
    await h.finishTask();
    assert.equal(h.completeCalls.length, 0);
    await h.runner.emit({ type: "session_shutdown", reason: "quit" });
  });

  it("can run a closing check when a database writer prevented the mid-task request", async (t) => {
    const agentDir = makeTempDir();
    const h = await createHarness({ agentDir, sessionFile: join(agentDir, "task.jsonl") });
    await h.runCommand("on");
    const writer = new DatabaseSync(join(agentDir, "pi-heads-up", "state.sqlite"));
    t.after(() => writer.close());
    writer.exec("BEGIN IMMEDIATE");
    await h.emitToolTurns(6);
    assert.equal(h.completeCalls.length, 0);
    writer.exec("ROLLBACK");
    await h.finishTask();
    assert.equal(h.completeCalls.length, 1);
    await h.runner.emit({ type: "session_shutdown", reason: "quit" });
  });

  it("keeps both ends of long failed tool results within the per-message and transcript budgets", async () => {
    const h = await createHarness({ agentDir: makeTempDir() });
    const failure: ToolResultMessage = {
      ...toolResult("bash"), isError: true,
      content: [
        { type: "text", text: "build src/main.ts\n" + "x".repeat(4000) },
        { type: "text", text: "OMITTED_MIDDLE" },
        { type: "text", text: "y".repeat(4000) + "\nE_EXIT at src/main.ts:12" },
      ],
    };
    await h.emitToolTurns(6, [...Array<Message>(8).fill(toolResult("read", "a".repeat(3000))), failure]);
    const { transcript } = JSON.parse(String(h.completeCalls[0].context.messages[0].content));
    assert.ok(transcript.length <= 20_000);
    const excerpt = transcript.split("tool result (bash, error): ").at(-1);
    assert.ok(excerpt.startsWith("build src/main.ts\n"));
    assert.ok(excerpt.endsWith("E_EXIT at src/main.ts:12"));
    assert.ok(excerpt.includes("[truncated]") && !excerpt.includes("OMITTED_MIDDLE"));
    assert.ok(excerpt.length <= 3000);
    // These newer results leave 14 characters for the older failure.
    const errorAtCutoff = { ...toolResult("bash", "H" + "x".repeat(3000) + "T"), isError: true };
    await h.emitToolTurns(6, [errorAtCutoff, ...Array(5).fill(toolResult("bash", "b".repeat(3000))),
      toolResult("bash", "b".repeat(1793))]);
    const second = JSON.parse(String(h.completeCalls[1].context.messages[0].content)).transcript;
    assert.match(second, /^tool result \(bash, error\): Hx*…x*T\n\n/);
    await h.runner.emit({ type: "session_shutdown", reason: "quit" });
  });

  it("clears an ignored note at the next task, keeps the draft and dedupe, and accepts a fresh note", async () => {
    let note = { kind: "heads_up", topic: "old", title: "Old task note", detail: "Old evidence" };
    const h = await createHarness({ agentDir: makeTempDir(), complete: async () => assistantJson(note) });
    await h.emitToolTurns(6);
    assert.ok(h.getCurrentWidget()?.includes("Old task note"));
    h.setEditorText("Existing draft");
    await h.startTask();
    assert.equal(h.getCurrentWidget(), undefined);
    assert.equal(h.getEditorText(), "Existing draft");
    await h.emitToolTurns(6);
    assert.equal(h.completeCalls.length, 2);
    assert.equal(h.getCurrentWidget(), undefined);
    note = { ...note, topic: "fresh", title: "New task note" };
    await h.emitToolTurns(6);
    assert.ok(h.getCurrentWidget()?.includes("New task note"));
    assert.equal(h.getEditorText(), "Existing draft");
    await h.runner.emit({ type: "session_shutdown", reason: "quit" });
  });

  it("fits a wide-character note to the terminal and restores its preview when the detail menu is cancelled", async () => {
    const note = {
      kind: "you_should_know",
      topic: "retry-delay",
      title: "重试延迟会随失败次数逐步增加。".repeat(5),
      detail: "到达上限后，后续重试使用相同的延迟。",
    };
    const h = await createHarness({
      agentDir: makeTempDir(),
      complete: async () => assistantJson(note),
      select: async (title) => {
        assert.equal(h.getCurrentWidget(), undefined);
        return title.includes(note.detail) ? undefined : "Learn more";
      },
    });
    await h.emitToolTurns(6);

    const prefix = "✦ You should know · ";
    const wide = h.getCurrentWidget(80)!.split("\n");
    assert.ok(wide[0].startsWith(prefix));
    assert.ok(wide.slice(1).every((line) => line.startsWith(" ".repeat(visibleWidth(prefix)))));
    assert.ok(wide.every((line) => visibleWidth(line) <= 80));
    assert.equal(wide.slice(0, -1).map((line, i) => line.slice(i === 0 ? prefix.length : visibleWidth(prefix))).join(""), note.title);

    const narrow = h.getCurrentWidget(32)!.split("\n");
    assert.equal(narrow[0], "✦ You should know");
    assert.equal(narrow.length, 5);
    assert.ok(narrow[3].endsWith("…"));
    assert.equal(narrow[4], "/heads-up to review");
    assert.ok(narrow.every((line) => visibleWidth(line) <= 32));

    await h.runCommand();
    assert.equal(h.selectCalls.length, 2);
    assert.ok(h.selectCalls[1].title.includes(note.title));
    assert.deepEqual(h.getCurrentWidget(32)?.split("\n"), narrow);
    await h.runner.emit({ type: "session_shutdown", reason: "quit" });
  });

  it("supports Learn more detail, draft-only Chat in main session, and Knew this already vs Dismiss", async () => {
    const agentDir = makeTempDir();
    let nextNote = {
      kind: "you_should_know",
      topic: "draft-topic",
      title: "Retries use exponential backoff.",
      detail: "Each failure doubles the delay up to 30 seconds.",
    };
    let selectPlan: string[] = [];

    const h = await createHarness({
      agentDir,
      sessionFile: join(agentDir, "session.jsonl"),
      complete: async () => assistantJson(nextNote),
      select: async () => selectPlan.shift(),
    });
    await h.runner.emit({ type: "session_start", reason: "startup" });
    await h.runCommand("on");

    // 1. Learn more -> Chat in main session (draft-only, preserves existing draft, keeps known=0)
    await h.emitToolTurns(6);
    assert.ok(h.getCurrentWidget()?.includes("You should know"));
    h.setEditorText("Existing draft");
    selectPlan = ["Learn more", "Chat in main session"];
    await h.runCommand();

    assert.equal(h.selectCalls.length, 2);
    assert.deepEqual(h.selectCalls[0].options, ["Learn more", "Knew this already", "Dismiss"]);
    assert.deepEqual(h.selectCalls[1].options, ["Understood", "Chat in main session", "Dismiss"]);
    assert.equal(h.selectCalls[1].title, `You should know · ${nextNote.title}\n\n${nextNote.detail}`);
    assert.equal(h.sentMessages.length, 0);
    assert.equal(
      h.getEditorText(),
      "Existing draft\n\n> You should know: Retries use exponential backoff.\n> Each failure doubles the delay up to 30 seconds.\n\n",
    );
    assert.equal(h.getCurrentWidget(), undefined);

    // 2. Dismiss clears widget, leaves known=0, and still dedupes the topic
    nextNote = {
      kind: "heads_up",
      topic: "dismiss-topic",
      title: "Port 8080 is hardcoded.",
      detail: "Config overrides are ignored by the listener.",
    };
    await h.emitToolTurns(6);
    assert.ok(h.getCurrentWidget()?.includes("Port 8080 is hardcoded."));
    selectPlan = ["Dismiss"];
    await h.runCommand();
    assert.equal(h.getCurrentWidget(), undefined);

    // Returning same dismissed topic again is deduped
    await h.emitToolTurns(6);
    assert.equal(h.getCurrentWidget(), undefined);

    // 3. Knew this already marks known=1 in recentNotes sent to model
    nextNote = {
      kind: "heads_up",
      topic: "known-topic",
      title: "Cache skips negative responses.",
      detail: "404 responses bypass Redis.",
    };
    await h.emitToolTurns(6);
    selectPlan = ["Knew this already"];
    await h.runCommand();
    assert.equal(h.getCurrentWidget(), undefined);

    nextNote = {
      kind: "heads_up",
      topic: "probe-topic",
      title: "Probe note.",
      detail: "Probe detail.",
    };
    await h.emitToolTurns(6);
    const recentPayload = JSON.parse(String(h.completeCalls.at(-1)?.context.messages[0].content)) as {
      recentNotes: Array<{ topic: string; known: number }>;
    };
    const byTopic = new Map(recentPayload.recentNotes.map((n) => [n.topic, n.known]));
    assert.equal(byTopic.get("draft-topic"), 0);
    assert.equal(byTopic.get("dismiss-topic"), 0);
    assert.equal(byTopic.get("known-topic"), 1);
    await h.runner.emit({ type: "session_shutdown", reason: "quit" });
  });

  it("persists dedupe with 30-day expiry and discards late results on session reset", async (t) => {
    const agentDir = makeTempDir();
    let now = 1_700_000_000_000;
    t.mock.method(Date, "now", () => now);

    const persistentNote = {
      kind: "heads_up",
      topic: "Persist-Topic",
      title: "Lock file is stale.",
      detail: "The build left a stale lock.",
    };

    // Remember note in persisted session
    const h1 = await createHarness({
      agentDir,
      sessionFile: join(agentDir, "session.jsonl"),
      complete: async () => assistantJson(persistentNote),
    });
    await h1.runner.emit({ type: "session_start", reason: "startup" });
    await h1.emitToolTurns(6);
    assert.ok(h1.getCurrentWidget()?.includes("Lock file is stale."));
    await h1.runner.emit({ type: "session_shutdown", reason: "quit" });

    // Restart within 30 days -> deduped
    now += RETENTION_MS - 60_000;
    const h2 = await createHarness({
      agentDir,
      sessionFile: join(agentDir, "session.jsonl"),
      complete: async () => assistantJson(persistentNote),
    });
    await h2.runner.emit({ type: "session_start", reason: "startup" });
    await h2.emitToolTurns(6);
    assert.equal(h2.getCurrentWidget(), undefined);
    await h2.runner.emit({ type: "session_shutdown", reason: "quit" });

    // Advance past 30-day retention -> expired and surfaces again
    now += 60_000;
    const h3 = await createHarness({
      agentDir,
      sessionFile: join(agentDir, "session.jsonl"),
      complete: async () => assistantJson(persistentNote),
    });
    await h3.runner.emit({ type: "session_start", reason: "startup" });
    await h3.emitToolTurns(6);
    assert.ok(h3.getCurrentWidget()?.includes("Lock file is stale."));
    await h3.runner.emit({ type: "session_shutdown", reason: "quit" });

    // In-memory (--no-session) notes do not persist to disk
    const hMem = await createHarness({
      agentDir,
      sessionFile: undefined,
      complete: async () =>
        assistantJson({
          kind: "heads_up",
          topic: "ephemeral-topic",
          title: "Only in memory.",
          detail: "Should not persist.",
        }),
    });
    await hMem.runner.emit({ type: "session_start", reason: "startup" });
    await hMem.emitToolTurns(6);
    assert.ok(hMem.getCurrentWidget()?.includes("Only in memory."));
    await hMem.runner.emit({ type: "session_shutdown", reason: "quit" });

    // Late result after session_tree reset is discarded and not remembered
    let late = deferred<AssistantMessage>();
    let useLate = true;
    const hReset = await createHarness({
      agentDir,
      sessionFile: join(agentDir, "session.jsonl"),
      complete: () =>
        useLate
          ? late.promise
          : Promise.resolve(
              assistantJson({
                kind: "heads_up",
                topic: "ephemeral-topic",
                title: "Surfaces after reset.",
                detail: "Not deduped by discarded late result.",
              }),
            ),
    });
    await hReset.runner.emit({ type: "session_start", reason: "startup" });
    await hReset.emitToolTurns(6);
    const firstSignal = hReset.completeCalls[0].options?.signal as AbortSignal;
    assert.equal(firstSignal.aborted, false);

    await hReset.runner.emit({ type: "session_tree", newLeafId: "n2", oldLeafId: "n1" });
    assert.equal(firstSignal.aborted, true);
    await hReset.emitToolTurns(6);
    assert.equal(hReset.completeCalls.length, 1);

    late.resolve(
      assistantJson({
        kind: "heads_up",
        topic: "ephemeral-topic",
        title: "Stale result.",
        detail: "Should be discarded.",
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(hReset.getCurrentWidget(), undefined);

    // Since late result was discarded (and --no-session didn't persist), topic still surfaces
    useLate = false;
    await hReset.emitToolTurns(6);
    assert.ok(hReset.getCurrentWidget()?.includes("Surfaces after reset."));
    await hReset.runner.emit({ type: "session_shutdown", reason: "quit" });
  });
});
