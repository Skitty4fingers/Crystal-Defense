// Restore recovered leaderboard rows into a STABLE Turso database.
//
// Usage (PowerShell):
//   $env:RESTORE_TURSO_DATABASE_URL = "libsql://<your-stable-db>.turso.io"
//   $env:RESTORE_TURSO_AUTH_TOKEN   = "<token>"
//   node backups/restore-leaderboard.mjs backups/leaderboard-backup-2026-06-20.json
//
// Idempotent: a row is skipped if one with the same (initials, score,
// created_at) already exists, so re-running never duplicates or overwrites.
// It only ever INSERTs — it never DELETEs or prunes.
import { readFileSync } from 'node:fs';
import { createClient } from '@libsql/client';

const file = process.argv[2] ?? 'backups/leaderboard-backup-2026-06-20.json';
const url = process.env.RESTORE_TURSO_DATABASE_URL;
const authToken = process.env.RESTORE_TURSO_AUTH_TOKEN;

if (!url) {
  console.error('Set RESTORE_TURSO_DATABASE_URL (and RESTORE_TURSO_AUTH_TOKEN) first.');
  process.exit(1);
}

const backup = JSON.parse(readFileSync(file, 'utf8'));
const rows = backup.rows ?? [];
const db = createClient({ url, authToken });

// Match the live schema in api/leaderboard.ts (create + additive columns).
await db.execute(
  `CREATE TABLE IF NOT EXISTS scores (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     initials TEXT NOT NULL, score INTEGER NOT NULL, level INTEGER NOT NULL,
     wave INTEGER NOT NULL, created_at INTEGER NOT NULL
   )`,
);
for (const ddl of [
  `ALTER TABLE scores ADD COLUMN kind TEXT NOT NULL DEFAULT 'arcade'`,
  `ALTER TABLE scores ADD COLUMN day INTEGER`,
  `ALTER TABLE scores ADD COLUMN challenge INTEGER`,
  `ALTER TABLE scores ADD COLUMN stats TEXT`,
]) {
  try { await db.execute(ddl); } catch { /* column already exists */ }
}

let inserted = 0, skipped = 0;
for (const r of rows) {
  const exists = await db.execute({
    sql: 'SELECT 1 FROM scores WHERE initials = ? AND score = ? AND created_at = ? LIMIT 1',
    args: [r.initials, r.score, r.created_at],
  });
  if (exists.rows.length) { skipped++; continue; }
  await db.execute({
    sql: `INSERT INTO scores (initials, score, level, wave, created_at, kind, day, challenge, stats)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [r.initials, r.score, r.level, r.wave, r.created_at, r.kind, r.day, r.challenge, r.stats],
  });
  inserted++;
  console.log(`  + ${r.initials} ${r.score} (${r.kind}${r.challenge != null ? ` #${r.challenge}` : ''})`);
}

const total = await db.execute('SELECT COUNT(*) AS n FROM scores');
console.log(`\nDone. Inserted ${inserted}, skipped ${skipped} (already present). Table now holds ${Number(total.rows[0].n)} rows.`);
