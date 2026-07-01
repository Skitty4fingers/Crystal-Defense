// Shared Crystal Defense leaderboard — Vercel serverless function backed by
// Turso (libSQL). Keeps only the top 100 scores. Light server-side validation
// guards against obviously-forged payloads (no full game simulation).
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@libsql/client';

const MAX_ENTRIES = 100;
const MAX_STATS_BYTES = 4000;

// Env precedence (see api/health.ts for the mirrored version + source tags):
//  1. CRSTL_DEV_TURSO_*  — dedicated dev DB for preview / local so test scores
//     never touch production.
//  2. LEADERBOARD_TURSO_* — a STABLE, manually-managed production database. This
//     wins over the integration var so the live board SURVIVES deploys: the
//     Turso marketplace integration otherwise hands each production deployment
//     its own fresh, empty database via CRSTL_TURSO_* (DB name == deployment id).
//  3. CRSTL_TURSO_*       — the integration's (per-deployment) database.
//  4. TURSO_*             — unprefixed fallback for manual setups.
const allowDevDb = process.env.VERCEL_ENV !== 'production';
function resolveDb(): { url: string | undefined; authToken: string | undefined } {
  if (allowDevDb && process.env.CRSTL_DEV_TURSO_DATABASE_URL) {
    return { url: process.env.CRSTL_DEV_TURSO_DATABASE_URL, authToken: process.env.CRSTL_DEV_TURSO_AUTH_TOKEN };
  }
  if (process.env.LEADERBOARD_TURSO_DATABASE_URL) {
    return { url: process.env.LEADERBOARD_TURSO_DATABASE_URL, authToken: process.env.LEADERBOARD_TURSO_AUTH_TOKEN };
  }
  if (process.env.CRSTL_TURSO_DATABASE_URL) {
    return { url: process.env.CRSTL_TURSO_DATABASE_URL, authToken: process.env.CRSTL_TURSO_AUTH_TOKEN };
  }
  return { url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN };
}
const { url, authToken } = resolveDb();
const db = url ? createClient({ url, authToken }) : null;

const COLS = 'initials, score, level, wave, created_at, kind, day, challenge, stats, version';
// Top-100 within one category: arcade (challenge = NULL → all arcade), or one
// daily challenge type (challenge 0-9 → all-time best across every day that ran it).
const selectTop =
  `SELECT ${COLS} FROM scores WHERE kind = ? AND (? IS NULL OR challenge = ?)
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
      // rows read as kind='arcade' (default), day=NULL, stats=NULL, version=NULL.
      for (const ddl of [
        `ALTER TABLE scores ADD COLUMN kind TEXT NOT NULL DEFAULT 'arcade'`,
        `ALTER TABLE scores ADD COLUMN day INTEGER`,
        `ALTER TABLE scores ADD COLUMN challenge INTEGER`,
        `ALTER TABLE scores ADD COLUMN stats TEXT`,
        `ALTER TABLE scores ADD COLUMN version TEXT`,
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

function sanitizeVersion(v: unknown): string | null {
  const s = String(v ?? '').slice(0, 20);
  return /^\d+\.\d+\.\d+$/.test(s) ? s : null;
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
      // Daily boards are per challenge type (0-9); arcade is one global board.
      const challenge = kind === 'daily' ? clampInt(req.query.challenge, 0, 9) : null;
      const rs = await db.execute({ sql: selectTop, args: [kind, challenge, challenge] });
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
      // Board identity for daily is the challenge type; derive from day if absent.
      let challenge = kind === 'daily' ? clampInt(body.challenge, 0, 9) : null;
      if (kind === 'daily' && challenge === null && day !== null) challenge = day % 10;
      const stats = sanitizeStats(body.stats);
      const version = sanitizeVersion(body.version);

      const createdAt = Date.now();
      await db.execute({
        sql: 'INSERT INTO scores (initials, score, level, wave, created_at, kind, day, challenge, stats, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        args: [initials, score, level, wave, createdAt, kind, day, challenge, stats, version],
      });
      // Keep only the top 100 within this category (arcade, or one daily type).
      await db.execute({
        sql: `DELETE FROM scores WHERE kind = ? AND (? IS NULL OR challenge = ?) AND id NOT IN (
                SELECT id FROM scores WHERE kind = ? AND (? IS NULL OR challenge = ?)
                ORDER BY score DESC, created_at ASC LIMIT ${MAX_ENTRIES}
              )`,
        args: [kind, challenge, challenge, kind, challenge, challenge],
      });

      const rs = await db.execute({ sql: selectTop, args: [kind, challenge, challenge] });
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
