import { app } from "electron";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  CallRecord,
  HistoryItem,
  HistoryPage,
  HistorySearch,
  SaveCallRequest,
  TranscriptLine,
} from "../shared/types";

/** Snippet highlight markers: control characters that can't appear in speech text. */
export const MARK_START = "\u0002";
export const MARK_END = "\u0003";

const PAGE_SIZE = 10;

let db: DatabaseSync | undefined;

function open(): DatabaseSync {
  if (db) return db;
  db = new DatabaseSync(path.join(app.getPath("userData"), "history.sqlite"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS calls (
      id          INTEGER PRIMARY KEY,
      title       TEXT    NOT NULL,
      started_at  INTEGER NOT NULL,
      ended_at    INTEGER NOT NULL,
      meeting_app TEXT,
      transcript  TEXT    NOT NULL,  -- JSON array of TranscriptLine
      notes       TEXT    NOT NULL DEFAULT ''
    );
    -- Full-text index over the searchable text; rowid = calls.id.
    CREATE VIRTUAL TABLE IF NOT EXISTS calls_fts
      USING fts5(title, body, notes, tokenize = 'porter unicode61');
  `);
  return db;
}

function transcriptText(lines: TranscriptLine[]): string {
  return lines.map((l) => `${l.speaker === "them" ? "Them" : "You"}: ${l.text}`).join("\n");
}

/** A readable title: the first question they asked, else the first thing said. */
function deriveTitle(lines: TranscriptLine[]): string {
  const first =
    lines.find((l) => l.speaker === "them" && l.text.trim().endsWith("?")) ?? lines[0];
  const text = first?.text.trim() ?? "";
  if (!text) return "Untitled call";
  return text.length > 80 ? `${text.slice(0, 77).trimEnd()}…` : text;
}

/**
 * Turns what the user typed into a safe FTS5 query: every word must match,
 * and the last characters of each word can still be missing (prefix match),
 * so results update sensibly while typing. Punctuation and FTS syntax are dropped.
 */
function toMatchQuery(input: string): string {
  const words = input.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.map((w) => `"${w}"*`).join(" ");
}

export function saveCall(req: SaveCallRequest): number {
  const lines = req.transcript.filter((l) => l.text.trim());
  if (lines.length === 0) throw new Error("Nothing was transcribed, so there's nothing to save.");
  const d = open();
  const title = deriveTitle(lines);
  const notes = req.notes ?? "";
  const { lastInsertRowid } = d
    .prepare(
      `INSERT INTO calls (title, started_at, ended_at, meeting_app, transcript, notes)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(title, req.startedAt, req.endedAt, req.meetingApp ?? null, JSON.stringify(lines), notes);
  const id = Number(lastInsertRowid);
  d.prepare(`INSERT INTO calls_fts (rowid, title, body, notes) VALUES (?, ?, ?, ?)`).run(
    id,
    title,
    transcriptText(lines),
    notes,
  );
  return id;
}

export function updateNotes(id: number, notes: string): void {
  const d = open();
  d.prepare(`UPDATE calls SET notes = ? WHERE id = ?`).run(notes, id);
  d.prepare(`UPDATE calls_fts SET notes = ? WHERE rowid = ?`).run(notes, id);
}

export function deleteCall(id: number): void {
  const d = open();
  d.prepare(`DELETE FROM calls WHERE id = ?`).run(id);
  d.prepare(`DELETE FROM calls_fts WHERE rowid = ?`).run(id);
}

export function getCall(id: number): CallRecord | undefined {
  const row = open()
    .prepare(`SELECT id, title, started_at, ended_at, meeting_app, transcript, notes FROM calls WHERE id = ?`)
    .get(id) as Record<string, any> | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    title: row.title,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    meetingApp: row.meeting_app,
    transcript: JSON.parse(row.transcript),
    notes: row.notes,
  };
}

function toItem(row: Record<string, any>): HistoryItem {
  return {
    id: row.id,
    title: row.title,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    meetingApp: row.meeting_app,
    snippet: row.snippet ?? "",
  };
}

export function searchCalls(req: HistorySearch): HistoryPage {
  const d = open();
  const offset = Math.max(0, Math.floor(req.offset ?? 0));
  const match = toMatchQuery(req.query ?? "");

  if (!match) {
    // No search term: most recent calls, with the start of the transcript as preview.
    const total = (d.prepare(`SELECT COUNT(*) AS n FROM calls`).get() as { n: number }).n;
    const rows = d
      .prepare(
        `SELECT c.id, c.title, c.started_at, c.ended_at, c.meeting_app,
                substr(f.body, 1, 160) AS snippet
           FROM calls c JOIN calls_fts f ON f.rowid = c.id
          ORDER BY c.started_at DESC
          LIMIT ? OFFSET ?`,
      )
      .all(PAGE_SIZE, offset) as Record<string, any>[];
    return page(rows, total, offset);
  }

  const total = (
    d.prepare(`SELECT COUNT(*) AS n FROM calls_fts WHERE calls_fts MATCH ?`).get(match) as {
      n: number;
    }
  ).n;
  // bm25 weights: a hit in the title counts most, then notes, then transcript.
  // snippet column -1 lets SQLite pick whichever column matched best.
  const rows = d
    .prepare(
      `SELECT c.id, c.title, c.started_at, c.ended_at, c.meeting_app,
              snippet(calls_fts, -1, ?, ?, '…', 14) AS snippet
         FROM calls_fts JOIN calls c ON c.id = calls_fts.rowid
        WHERE calls_fts MATCH ?
        ORDER BY bm25(calls_fts, 10.0, 1.0, 3.0), c.started_at DESC
        LIMIT ? OFFSET ?`,
    )
    .all(MARK_START, MARK_END, match, PAGE_SIZE, offset) as Record<string, any>[];
  return page(rows, total, offset);
}

function page(rows: Record<string, any>[], total: number, offset: number): HistoryPage {
  const items = rows.map(toItem);
  const next = offset + items.length;
  return { items, total, nextOffset: next < total ? next : null };
}
