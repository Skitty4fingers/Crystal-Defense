// Lightweight health check for the leaderboard backend. Reports which Turso
// database the running deployment resolved (dev / production / fallback) and
// whether it's reachable — without ever exposing the auth token. Handy for
// confirming a Vercel Preview is hitting the dedicated dev DB, not production.
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@libsql/client';

// Mirror the env precedence in api/leaderboard.ts and tag the source so the
// response makes clear which database is in use. The dev override is ignored in
// production, so the live deployment always reports the production database.
function resolveDb(): { source: string; url: string | undefined; authToken: string | undefined } {
  const allowDevDb = process.env.VERCEL_ENV !== 'production';
  if (allowDevDb && process.env.CRSTL_DEV_TURSO_DATABASE_URL) {
    return { source: 'dev', url: process.env.CRSTL_DEV_TURSO_DATABASE_URL, authToken: process.env.CRSTL_DEV_TURSO_AUTH_TOKEN };
  }
  if (process.env.CRSTL_TURSO_DATABASE_URL) {
    return { source: 'production', url: process.env.CRSTL_TURSO_DATABASE_URL, authToken: process.env.CRSTL_TURSO_AUTH_TOKEN };
  }
  if (process.env.TURSO_DATABASE_URL) {
    return { source: 'fallback', url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN };
  }
  return { source: 'none', url: undefined, authToken: undefined };
}

/** Host only — never the token (which lives in authToken, not the URL anyway). */
function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try { return new URL(url.replace(/^libsql:/, 'https:')).host; } catch { return null; }
}

export default async function handler(_req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const { source, url, authToken } = resolveDb();
  const host = hostOf(url);
  const env = process.env.VERCEL_ENV ?? 'local'; // 'production' | 'preview' | 'development'

  if (!url) {
    res.status(200).json({ ok: false, db: 'none', env, reachable: false, error: 'No database configured' });
    return;
  }

  try {
    const db = createClient({ url, authToken });
    const rs = await db.execute(
      `SELECT COUNT(*) AS n FROM scores`,
    );
    const scores = Number(rs.rows[0]?.['n'] ?? 0);
    res.status(200).json({ ok: true, db: source, env, host, reachable: true, schemaOk: true, scores });
  } catch (err) {
    // Reachable connection but missing table still tells us which DB we hit.
    const msg = String(err);
    const schemaOk = !/no such table/i.test(msg);
    res.status(200).json({ ok: false, db: source, env, host, reachable: false, schemaOk, error: msg });
  }
}
