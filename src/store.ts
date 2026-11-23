import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Note } from "./review.ts";

const RETENTION = 30 * 24 * 60 * 60 * 1_000;

type RecentNote = Pick<Note, "topic" | "title"> & { known: 0 | 1 };

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
        PRAGMA busy_timeout = 250;
        PRAGMA secure_delete = ON;
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, enabled INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS project_notes (
          project TEXT NOT NULL,
          topic TEXT NOT NULL,
          title TEXT NOT NULL,
          known INTEGER NOT NULL,
          seen_at INTEGER NOT NULL,
          PRIMARY KEY (project, topic)
        );
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

  prune(now = Date.now()): void {
    const db = this.open();
    if (!db) return;
    db.prepare("DELETE FROM project_notes WHERE seen_at <= ?").run(now - RETENTION);
    // Older installs stored notes without a project. Only expire those rows.
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'notes'").get()) {
      db.prepare("DELETE FROM notes WHERE seen_at <= ?").run(now - RETENTION);
    }
  }

  recent(project: string, now = Date.now()): RecentNote[] {
    this.prune(now);
    return (this.open()?.prepare(`
      SELECT topic, title, known FROM project_notes WHERE project = ? ORDER BY seen_at DESC LIMIT 50
    `).all(project) ?? []) as RecentNote[];
  }

  remember(project: string, note: Note, now = Date.now()): boolean {
    const result = this.open(true).prepare(`
      INSERT INTO project_notes VALUES (?, ?, ?, 0, ?)
      ON CONFLICT(project, topic) DO UPDATE SET title = excluded.title, known = 0, seen_at = excluded.seen_at
      WHERE project_notes.seen_at <= ?
    `).run(project, note.topic, note.title, now, now - RETENTION);
    return result.changes === 1;
  }

  markKnown(project: string, note: Note, now = Date.now()): void {
    this.open(true).prepare(`
      INSERT INTO project_notes VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(project, topic) DO UPDATE SET known = 1, seen_at = excluded.seen_at
    `).run(project, note.topic, note.title, now);
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
  }
}
