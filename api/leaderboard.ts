// Shared Crystal Defense leaderboard — Vercel serverless function backed by
// Turso (libSQL). Keeps only the top 100 scores. Light server-side validation
// guards against obviously-forged payloads (no full game simulation).
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@libsql/client';

const MAX_ENTRIES = 100;
const MAX_STATS_BYTES = 4000;

// Env precedence: a dedicated dev database (set CRSTL_DEV_TURSO_* on the Vercel
// Preview environment) wins, so preview/dev test scores never touch production.
// Production has only CRSTL_TURSO_* (the Turso marketplace integration prefix);
// the unprefixed names are a fallback for `vercel dev` / manual setups.
const url = process.env.CRSTL_DEV_TURSO_DATABASE_URL
  ?? process.env.CRSTL_TURSO_DATABASE_URL ?? process.env.TURSO_DATABASE_URL;
const authToken = process.env.CRSTL_DEV_TURSO_AUTH_TOKEN
  ?? process.env.CRSTL_TURSO_AUTH_TOKEN ?? process.env.TURSO_AUTH_TOKEN;
const db = url ? createClient({ url, authToken }) : null;

const COLS = 'initials, score, level, wave, created_at, kind, day, stats';
// Top-100 within one category (arcade, or one daily challenge day).
const selectTop =
  `SELECT ${COLS} FROM scores WHERE kind = ? AND (? IS NULL OR day = ?)
   ORDER BY score DESC, created_at ASC LIMIT ${MAX_ENTRIES}`;

let ready: Promise<unknown> | null = null;
async function ensureTable(): Promise<void> {
  if (!db) return;
  if (!ready) {
    ready = (async () => {
      await db.execute(
        `CREATE TABLE IF NOT EXISTS scores (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           initials TEXT NOT NULL,
           score INTEGER NOT NULL,
           level INTEGER NOT NULL,
           wave INTEGER NOT NULL,
           created_at INTEGER NOT NULL
         )`,
      );
      // Additive, backward-compatible migration for pre-existing tables. Legacy
      // rows read as kind='arcade' (default), day=NULL, stats=NULL.
      for (const ddl of [
        `ALTER TABLE scores ADD COLUMN kind TEXT NOT NULL DEFAULT 'arcade'`,
        `ALTER TABLE scores ADD COLUMN day INTEGER`,
        `ALTER TABLE scores ADD COLUMN stats TEXT`,
      ]) {
        try { await db.execute(ddl); } catch { /* column already exists */ }
      }
    })();
  }
  await ready;
}

function sanitizeInitials(v: unknown): string {
  return String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3) || 'AAA';
}

function clampInt(v: unknown, min: number, max: number): number | null {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

function sanitizeStats(v: unknown): string | null {
  if (v == null) return null;
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length <= MAX_STATS_BYTES ? s : null;
  } catch {
    return null;
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  if (!db) {
    res.status(503).json({ error: 'Leaderboard storage not configured' });
    return;
  }

  try {
    await ensureTable();

    if (req.method === 'GET') {
      const kind = req.query.kind === 'daily' ? 'daily' : 'arcade';
      const day = kind === 'daily' ? clampInt(req.query.day, 0, 1e9) : null;
      const rs = await db.execute({ sql: selectTop, args: [kind, day, day] });
      res.status(200).json({ scores: rs.rows });
      return;
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {});
      const initials = sanitizeInitials(body.initials);
      const score = clampInt(body.score, 0, 1e12);
      const level = clampInt(body.level, 0, 100000);
      const wave = clampInt(body.wave, 0, 100000);
      if (score === null || level === null || wave === null) {
        res.status(400).json({ error: 'Invalid score payload' });
        return;
      }
      const kind = body.kind === 'daily' ? 'daily' : 'arcade';
      const day = kind === 'daily' ? clampInt(body.day, 0, 1e9) : null;
      const stats = sanitizeStats(body.stats);

      const createdAt = Date.now();
      await db.execute({
        sql: 'INSERT INTO scores (initials, score, level, wave, created_at, kind, day, stats) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        args: [initials, score, level, wave, createdAt, kind, day, stats],
      });
      // Keep only the top 100 within this category.
      await db.execute({
        sql: `DELETE FROM scores WHERE kind = ? AND (? IS NULL OR day = ?) AND id NOT IN (
                SELECT id FROM scores WHERE kind = ? AND (? IS NULL OR day = ?)
                ORDER BY score DESC, created_at ASC LIMIT ${MAX_ENTRIES}
              )`,
        args: [kind, day, day, kind, day, day],
      });

      const rs = await db.execute({ sql: selectTop, args: [kind, day, day] });
      const scores = rs.rows as unknown as Array<{ initials: string; score: number; created_at: number }>;
      const rank = scores.findIndex(
        (r) => r.initials === initials && Number(r.score) === score && Number(r.created_at) === createdAt,
      );
      res.status(200).json({ rank, scores });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    res.status(500).json({ error: 'Leaderboard error', detail: String(err) });
  }
}
