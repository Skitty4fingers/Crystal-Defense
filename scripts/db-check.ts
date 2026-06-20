// One-off connectivity check for the dev Turso leaderboard DB (not part of the
// build). Reads .env.local, ensures the schema/migration, does an insert ->
// select -> delete round-trip, and reports row counts. Leaves no probe behind.
//   npx tsx scripts/db-check.ts
import { readFileSync } from 'node:fs';
import { createClient } from '@libsql/client';

// Minimal .env.local loader (KEY="value" lines).
for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([\w]+)\s*=\s*"?([^"\n]*)"?\s*$/);
  if (m) process.env[m[1]] = m[2];
}

const url = process.env.CRSTL_DEV_TURSO_DATABASE_URL;
const authToken = process.env.CRSTL_DEV_TURSO_AUTH_TOKEN;
if (!url) { console.error('No CRSTL_DEV_TURSO_DATABASE_URL in .env.local'); process.exit(1); }
console.log('Connecting to', url.replace(/\/\/.*@/, '//')); // host only, no creds

const db = createClient({ url, authToken });

async function main(): Promise<void> {
  await db.execute(
    `CREATE TABLE IF NOT EXISTS scores (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       initials TEXT NOT NULL, score INTEGER NOT NULL,
       level INTEGER NOT NULL, wave INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
  );
  for (const ddl of [
    `ALTER TABLE scores ADD COLUMN kind TEXT NOT NULL DEFAULT 'arcade'`,
    `ALTER TABLE scores ADD COLUMN day INTEGER`,
    `ALTER TABLE scores ADD COLUMN stats TEXT`,
  ]) {
    try { await db.execute(ddl); } catch { /* column exists */ }
  }

  const probe = await db.execute({
    sql: 'INSERT INTO scores (initials, score, level, wave, created_at, kind, day, stats) VALUES (?,?,?,?,?,?,?,?)',
    args: ['CHK', 1, 1, 1, Date.now(), 'arcade', null, '{"probe":true}'],
  });
  const id = probe.lastInsertRowid;
  const back = await db.execute({ sql: 'SELECT initials, stats FROM scores WHERE id = ?', args: [String(id)] });
  await db.execute({ sql: 'DELETE FROM scores WHERE id = ?', args: [String(id)] });

  const counts = await db.execute(`SELECT kind, COUNT(*) AS n FROM scores GROUP BY kind`);
  console.log('Round-trip OK — read back:', back.rows[0]);
  console.log('Rows by kind:', counts.rows.length ? counts.rows : '(empty — clean dev DB)');
  console.log('Probe row deleted. Dev leaderboard DB is reachable and schema-ready. ✅');
}

main().catch((e) => { console.error('DB check FAILED:', e); process.exit(1); });
