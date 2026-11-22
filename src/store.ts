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
        CREATE TABLE IF NOT EXISTS notes (
          topic TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          known INTEGER NOT NULL,
          seen_at INTEGER NOT NULL
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
    this.open()?.prepare("DELETE FROM notes WHERE seen_at <= ?").run(now - RETENTION);
  }

  recent(now = Date.now()): RecentNote[] {
    this.prune(now);
    return (this.open()?.prepare(`
      SELECT topic, title, known FROM notes ORDER BY seen_at DESC LIMIT 50
    `).all() ?? []) as RecentNote[];
  }

  remember(note: Note, now = Date.now()): boolean {
    const result = this.open(true).prepare(`
      INSERT INTO notes VALUES (?, ?, 0, ?)
      ON CONFLICT(topic) DO UPDATE SET title = excluded.title, known = 0, seen_at = excluded.seen_at
      WHERE notes.seen_at <= ?
    `).run(note.topic, note.title, now, now - RETENTION);
    return result.changes === 1;
  }

  markKnown(note: Note, now = Date.now()): void {
    this.open(true).prepare(`
      INSERT INTO notes VALUES (?, ?, 1, ?)
      ON CONFLICT(topic) DO UPDATE SET known = 1, seen_at = excluded.seen_at
    `).run(note.topic, note.title, now);
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
  }
}
