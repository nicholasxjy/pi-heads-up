import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import {
  buildReviewPayload,
  buildTranscript,
  messageText,
  parseNote,
  parseNoteResult,
} from "../src/review.ts";

function makeResponse(
  text: string,
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
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
    stopReason,
    timestamp: Date.now(),
  };
}

function toolResult(name = "read", text = "ok", isError = false): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: "tc-1",
    toolName: name,
    content: [{ type: "text", text }],
    isError,
    timestamp: Date.now(),
  };
}

describe("review helpers", () => {
  it("enforces limit across string, text, and bounded toolCall arguments", () => {
    const userMsg: Message = { role: "user", content: "   " + "a".repeat(200), timestamp: 1 };
    assert.equal(messageText(userMsg, 50), "a".repeat(50));

    const multiPart: AssistantMessage = {
      ...makeResponse(""),
      content: [
        { type: "text", text: "   first part" },
        { type: "toolCall", id: "1", name: "write", arguments: { path: "big.ts", content: "x".repeat(50_000) } },
        { type: "text", text: "never reached" },
      ],
    };
    const bounded = messageText(multiPart, 60);
    assert.ok(bounded.length <= 60);
    assert.ok(bounded.startsWith("first part\nwrite("));
    assert.ok(!bounded.includes("never reached"));
  });

  it("does not duplicate latestUser when latestUser exceeds remaining transcript budget", () => {
    const latestUser: Message = { role: "user", content: "UNIQUE_USER_INTENT " + "u".repeat(2_000), timestamp: 1 };
    const messages: Message[] = [
      latestUser,
      ...Array.from({ length: 6 }, () => toolResult("bash", "b".repeat(2_800))),
    ];
    const transcript = buildTranscript(messages);
    const occurrences = transcript.split("UNIQUE_USER_INTENT").length - 1;
    assert.equal(occurrences, 1);
    assert.ok(transcript.startsWith("Latest user request: UNIQUE_USER_INTENT"));
    assert.ok(transcript.length <= 20_000);
  });

  it("bounds recentNotes inside buildReviewPayload", () => {
    const manyNotes = Array.from({ length: 50 }, (_, i) => ({
      topic: `topic-${i}`,
      title: "T".repeat(160),
      known: 0 as const,
    }));
    const payload = buildReviewPayload("short transcript", manyNotes);
    const parsed = JSON.parse(payload) as { transcript: string; recentNotes: unknown[] };
    assert.equal(parsed.transcript, "short transcript");
    assert.ok(parsed.recentNotes.length > 0 && parsed.recentNotes.length < 50);
    assert.ok(JSON.stringify(parsed.recentNotes).length <= 4_000);
  });

  it("parses JSON wrapped in prose or fences, normalizes topic, and truncates long fields", () => {
    const proseWrapped = makeResponse(
      `Here is the review:\n\`\`\`json\n{"kind":"heads_up","topic":"Auth__Token  Scope","title":"${"A".repeat(210)}","detail":"${"B".repeat(650)}"}\n\`\`\`\nDone.`,
    );
    const res = parseNoteResult(proseWrapped);
    assert.equal(res.status, "note");
    if (res.status === "note") {
      assert.equal(res.note.topic, "auth-token-scope");
      assert.equal(res.note.title.length, 180);
      assert.ok(res.note.title.endsWith("…"));
      assert.equal(res.note.detail.length, 600);
      assert.ok(res.note.detail.endsWith("…"));
    }

    assert.deepEqual(parseNoteResult(makeResponse("Nothing to report: null")), { status: "none" });
    assert.equal(parseNote(makeResponse("null")), undefined);
    assert.deepEqual(parseNoteResult(makeResponse('{"kind":"heads_up"}', "length")), {
      status: "invalid",
      reason: "stopReason:length",
    });
    assert.deepEqual(parseNoteResult(makeResponse("not json at all")), {
      status: "invalid",
      reason: "invalid_json",
    });
  });
});
