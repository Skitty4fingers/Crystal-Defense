// Shared Crystal Defense leaderboard — Vercel serverless function backed by
// Turso (libSQL). Keeps only the top 100 scores. Light server-side validation
// guards against obviously-forged payloads (no full game simulation).
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@libsql/client';

const MAX_ENTRIES = 100;

// The Vercel↔Turso marketplace integration prefixes the injected vars (here
// `CRSTL_`); fall back to the unprefixed names for `vercel dev` / manual setups.
const url = process.env.CRSTL_TURSO_DATABASE_URL ?? process.env.TURSO_DATABASE_URL;
const authToken = process.env.CRSTL_TURSO_AUTH_TOKEN ?? process.env.TURSO_AUTH_TOKEN;
const db = url ? createClient({ url, authToken }) : null;

const SELECT_TOP =
  `SELECT initials, score, level, wave, created_at FROM scores
   ORDER BY score DESC, created_at ASC LIMIT ${MAX_ENTRIES}`;

let ready: Promise<unknown> | null = null;
function ensureTable(): Promise<unknown> {
  if (!db) return Promise.resolve();
  if (!ready) {
    ready = db.execute(
      `CREATE TABLE IF NOT EXISTS scores (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         initials TEXT NOT NULL,
         score INTEGER NOT NULL,
         level INTEGER NOT NULL,
         wave INTEGER NOT NULL,
         created_at INTEGER NOT NULL
       )`,
    );
  }
  return ready;
}

function sanitizeInitials(v: unknown): string {
  return String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3) || 'AAA';
}

function clampInt(v: unknown, min: number, max: number): number | null {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
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
      const rs = await db.execute(SELECT_TOP);
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

      const createdAt = Date.now();
      await db.execute({
        sql: 'INSERT INTO scores (initials, score, level, wave, created_at) VALUES (?, ?, ?, ?, ?)',
        args: [initials, score, level, wave, createdAt],
      });
      // Keep only the top 100.
      await db.execute(
        `DELETE FROM scores WHERE id NOT IN (
           SELECT id FROM scores ORDER BY score DESC, created_at ASC LIMIT ${MAX_ENTRIES}
         )`,
      );

      const rs = await db.execute(SELECT_TOP);
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
