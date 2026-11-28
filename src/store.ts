import { closeSync, existsSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Note } from "./review.ts";

const RETENTION = 30 * 24 * 60 * 60 * 1_000;

export type RecentNote = Pick<Note, "topic" | "title"> & { known: 0 | 1 };
export type StoredNote = RecentNote & { seenAt: number };

export function normalizeProject(cwd: string): string {
  try {
    return realpathSync.native(cwd);
  } catch {
    return resolve(cwd);
  }
}

export class Store {
  private readonly path: string;
  private db?: DatabaseSync;

  constructor(path: string) {
    this.path = path;
  }

  private open(create: true): DatabaseSync;
  private open(create?: false): DatabaseSync | undefined;
  private open(create = false): DatabaseSync | undefined {
    if (this.db) return this.db;
    if (this.path !== ":memory:") {
      if (!create && !existsSync(this.path)) return;
      if (create) {
        mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
        closeSync(openSync(this.path, "a", 0o600));
      }
    }

    const sqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
    const db = new sqlite.DatabaseSync(this.path);
    try {
      db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 250;
        PRAGMA secure_delete = ON;
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, enabled INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS project_notes (
          project TEXT NOT NULL,
          topic TEXT NOT NULL,
          title TEXT NOT NULL,
          known INTEGER NOT NULL,
          seen_at INTEGER NOT NULL,
          PRIMARY KEY (project, topic)
        );
        CREATE INDEX IF NOT EXISTS idx_project_notes_seen ON project_notes (project, seen_at DESC);
      `);
    } catch (error) {
      db.close();
      throw error;
    }
    this.db = db;
    return db;
  }

  enabled(): boolean {
    const setting = this.open()?.prepare("SELECT enabled FROM settings WHERE key = 'heads-up'").get();
    return (setting?.enabled ?? 1) === 1;
  }

  setEnabled(enabled: boolean): void {
    this.open(true).prepare(`
      INSERT INTO settings VALUES ('heads-up', ?)
      ON CONFLICT(key) DO UPDATE SET enabled = excluded.enabled
    `).run(Number(enabled));
  }

  reviewModel(): string | undefined {
    const row = this.open()?.prepare("SELECT value FROM config WHERE key = 'review-model'").get();
    return typeof row?.value === "string" && row.value ? row.value : undefined;
  }

  setReviewModel(spec: string | undefined): void {
    if (!spec) {
      this.open()?.prepare("DELETE FROM config WHERE key = 'review-model'").run();
      return;
    }
    this.open(true).prepare(`
      INSERT INTO config VALUES ('review-model', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(spec);
  }

  prune(now = Date.now()): void {
    const db = this.open();
    if (!db) return;
    db.prepare("DELETE FROM project_notes WHERE seen_at <= ?").run(now - RETENTION);
    // Older installs stored notes without a project. Expire those rows and drop the table once empty.
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'notes'").get()) {
      db.prepare("DELETE FROM notes WHERE seen_at <= ?").run(now - RETENTION);
      if (!db.prepare("SELECT 1 FROM notes LIMIT 1").get()) {
        db.exec("DROP TABLE notes");
      }
    }
  }

  recent(project: string, now = Date.now()): RecentNote[] {
    const db = this.open();
    if (!db) return [];
    const rows = db.prepare(`
      SELECT topic, title, known FROM project_notes
      WHERE project = ? AND seen_at > ?
      ORDER BY seen_at DESC LIMIT 50
    `).all(normalizeProject(project), now - RETENTION) as RecentNote[];
    return rows.map((row) => ({ topic: row.topic, title: row.title, known: row.known }));
  }

  listNotes(project: string, now = Date.now()): StoredNote[] {
    const db = this.open();
    if (!db) return [];
    const rows = db.prepare(`
      SELECT topic, title, known, seen_at AS seenAt FROM project_notes
      WHERE project = ? AND seen_at > ?
      ORDER BY seen_at DESC LIMIT 50
    `).all(normalizeProject(project), now - RETENTION) as StoredNote[];
    return rows.map((row) => ({ topic: row.topic, title: row.title, known: row.known, seenAt: row.seenAt }));
  }

  remember(project: string, note: Note, now = Date.now()): boolean {
    const db = this.open(true);
    this.prune(now);
    const result = db.prepare(`
      INSERT INTO project_notes VALUES (?, ?, ?, 0, ?)
      ON CONFLICT(project, topic) DO UPDATE SET title = excluded.title, known = 0, seen_at = excluded.seen_at
      WHERE project_notes.seen_at <= ?
    `).run(normalizeProject(project), note.topic, note.title, now, now - RETENTION);
    return result.changes === 1;
  }

  markKnown(project: string, note: Note, now = Date.now()): void {
    this.open(true).prepare(`
      INSERT INTO project_notes VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(project, topic) DO UPDATE SET known = 1, seen_at = excluded.seen_at
    `).run(normalizeProject(project), note.topic, note.title, now);
  }

  setKnown(project: string, topic: string, known: boolean, now = Date.now()): boolean {
    const db = this.open();
    if (!db) return false;
    const result = db.prepare(`
      UPDATE project_notes SET known = ?, seen_at = ?
      WHERE project = ? AND topic = ?
    `).run(Number(known), now, normalizeProject(project), topic);
    return result.changes === 1;
  }

  deleteNote(project: string, topic: string): boolean {
    const db = this.open();
    if (!db) return false;
    const result = db.prepare("DELETE FROM project_notes WHERE project = ? AND topic = ?")
      .run(normalizeProject(project), topic);
    return result.changes === 1;
  }

  clearProject(project: string): number {
    const db = this.open();
    if (!db) return 0;
    const result = db.prepare("DELETE FROM project_notes WHERE project = ?").run(normalizeProject(project));
    return Number(result.changes);
  }

  stats(project: string, now = Date.now()): { total: number; known: number } {
    const db = this.open();
    if (!db) return { total: 0, known: 0 };
    const row = db.prepare(`
      SELECT COUNT(*) AS total, COALESCE(SUM(known), 0) AS known
      FROM project_notes
      WHERE project = ? AND seen_at > ?
    `).get(normalizeProject(project), now - RETENTION) as { total: number; known: number } | undefined;
    return { total: Number(row?.total ?? 0), known: Number(row?.known ?? 0) };
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
  }
}
