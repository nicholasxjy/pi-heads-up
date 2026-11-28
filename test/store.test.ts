import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { normalizeProject, Store } from "../src/store.ts";

const RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const tempDirs: string[] = [];

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-heads-up-store-"));
  tempDirs.push(dir);
  return dir;
}

describe("Store", () => {
  it("normalizes symlinks for project isolation and supports WAL concurrent reads", () => {
    const dir = makeTempDir();
    const linkProject = join(dir, "link-project");
    const fsReal = mkdtempSync(join(dir, "proj-"));
    symlinkSync(fsReal, linkProject);
    assert.equal(normalizeProject(linkProject), normalizeProject(fsReal));

    const dbPath = join(dir, "state.sqlite");
    const store = new Store(dbPath);
    try {
      assert.equal(
        store.remember(fsReal, {
          kind: "heads_up",
          topic: "wal-topic",
          title: "WAL works",
          detail: "Readers do not block.",
        }, 1_000),
        true,
      );

      const writer = new DatabaseSync(dbPath);
      try {
        writer.exec("BEGIN IMMEDIATE");
        const recent = store.recent(linkProject, 2_000);
        assert.deepEqual(recent, [{ topic: "wal-topic", title: "WAL works", known: 0 }]);
        writer.exec("ROLLBACK");
      } finally {
        writer.close();
      }
    } finally {
      store.close();
    }
  });

  it("persists reviewModel and manages history items (list, setKnown, delete, clear, stats)", () => {
    const dir = makeTempDir();
    const store = new Store(join(dir, "state.sqlite"));
    try {
      assert.equal(store.reviewModel(), undefined);
      store.setReviewModel("anthropic/claude-sonnet-4");
      assert.equal(store.reviewModel(), "anthropic/claude-sonnet-4");
      store.setReviewModel(undefined);
      assert.equal(store.reviewModel(), undefined);

      const proj = dir;
      store.remember(proj, { kind: "heads_up", topic: "t1", title: "Title 1", detail: "D1" }, 10_000);
      store.remember(proj, { kind: "you_should_know", topic: "t2", title: "Title 2", detail: "D2" }, 20_000);
      assert.deepEqual(store.stats(proj, 25_000), { total: 2, known: 0 });

      assert.equal(store.setKnown(proj, "t1", true, 30_000), true);
      assert.deepEqual(store.stats(proj, 30_000), { total: 2, known: 1 });

      const listed = store.listNotes(proj, 30_000);
      assert.deepEqual(
        listed.map((n) => ({ topic: n.topic, known: n.known })),
        [{ topic: "t1", known: 1 }, { topic: "t2", known: 0 }],
      );

      assert.equal(store.setKnown(proj, "t1", false, 35_000), true);
      assert.equal(store.deleteNote(proj, "t2"), true);
      assert.equal(store.deleteNote(proj, "missing"), false);
      assert.deepEqual(store.stats(proj, 35_000), { total: 1, known: 0 });

      // Expired notes are excluded from read-only recent/list/stats without needing a write
      assert.deepEqual(store.recent(proj, 35_000 + RETENTION_MS), []);
      assert.deepEqual(store.stats(proj, 35_000 + RETENTION_MS), { total: 0, known: 0 });

      assert.equal(store.clearProject(proj), 1);
      assert.equal(store.clearProject(proj), 0);
    } finally {
      store.close();
    }
  });

  it("drops legacy notes table once all legacy rows expire", () => {
    const dir = makeTempDir();
    const dbPath = join(dir, "state.sqlite");
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY, enabled INTEGER NOT NULL);
      CREATE TABLE notes (topic TEXT PRIMARY KEY, title TEXT NOT NULL, known INTEGER NOT NULL, seen_at INTEGER NOT NULL);
      INSERT INTO notes VALUES ('old', 'Old title', 0, 1000);
    `);
    raw.close();

    const store = new Store(dbPath);
    try {
      store.prune(1000 + RETENTION_MS);
    } finally {
      store.close();
    }

    const check = new DatabaseSync(dbPath);
    try {
      const table = check.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'notes'").get();
      assert.equal(table, undefined);
    } finally {
      check.close();
    }
  });
});
