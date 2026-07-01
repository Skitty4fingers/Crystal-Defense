// Shared leaderboard backed by the serverless API (Turso/libSQL). Falls back to
// localStorage when the backend is unavailable (e.g. `npm run dev` without
// `vercel dev`), so the arcade flow keeps working offline.

/** Which board an entry belongs to. Daily entries also carry their `day`. */
export type RunKind = 'arcade' | 'daily';

/** Per-run build summary captured for the leaderboard drill-in popup. */
export interface RunStats {
  towers: Record<string, { count: number; maxLevel: number }>;
  goldEarned: number;
  goldSpent: number;
  abilities: Record<string, number>;
  enemiesKilled: number;
  bossesKilled: number;
  maxBossMult: number;
  /** Ordered arcade draft path: which mutator was taken at each level. */
  mutatorPath: { level: number; id: string; name: string }[];
  /** Daily challenge played, if any. */
  challenge: { id: string; name: string } | null;
}

export interface ScoreEntry {
  initials: string;
  score: number;
  level: number;
  wave: number;
  date: number;
  kind: RunKind;
  day: number | null;
  /** Daily challenge type (0-9); the daily board is keyed by this, not by day. */
  challenge: number | null;
  stats: RunStats | null;
  /** Game version the run was played on (null for legacy rows recorded before this existed). */
  version: string | null;
}

const API = '/api/leaderboard';
const LOCAL_KEY = 'cd-leaderboard';
const MAX_ENTRIES = 100;

interface ServerRow {
  initials: string;
  score: number;
  level: number;
  wave: number;
  created_at: number;
  kind?: string;
  day?: number | null;
  challenge?: number | null;
  stats?: string | null;
  version?: string | null;
}

function parseStats(raw: unknown): RunStats | null {
  if (!raw) return null;
  if (typeof raw === 'object') return raw as RunStats;
  try {
    return JSON.parse(String(raw)) as RunStats;
  } catch {
    return null;
  }
}

function fromRow(r: ServerRow): ScoreEntry {
  return {
    initials: r.initials,
    score: Number(r.score),
    level: Number(r.level),
    wave: Number(r.wave),
    date: Number(r.created_at),
    kind: r.kind === 'daily' ? 'daily' : 'arcade',
    day: r.day == null ? null : Number(r.day),
    challenge: r.challenge == null ? null : Number(r.challenge),
    stats: parseStats(r.stats),
    version: r.version ?? null,
  };
}

/**
 * Local boards are keyed per category so arcade/daily don't mix offline. Daily
 * is keyed by challenge type (0-9), matching the shared backend's grouping.
 */
function localKey(kind: RunKind, challenge: number | null): string {
  return kind === 'daily' ? `${LOCAL_KEY}:daily:${challenge ?? 0}` : `${LOCAL_KEY}:arcade`;
}

function loadLocal(kind: RunKind, challenge: number | null): ScoreEntry[] {
  try {
    const raw = localStorage.getItem(localKey(kind, challenge));
    const parsed = raw ? (JSON.parse(raw) as ScoreEntry[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveLocal(kind: RunKind, challenge: number | null, board: ScoreEntry[]): void {
  try {
    localStorage.setItem(localKey(kind, challenge), JSON.stringify(board.slice(0, MAX_ENTRIES)));
  } catch {
    /* storage unavailable — ignore */
  }
}

function sortBoard(board: ScoreEntry[]): ScoreEntry[] {
  return board.slice().sort((a, b) => b.score - a.score || a.date - b.date).slice(0, MAX_ENTRIES);
}

function query(kind: RunKind, challenge: number | null): string {
  const p = new URLSearchParams({ kind });
  if (kind === 'daily' && challenge != null) p.set('challenge', String(challenge));
  return `${API}?${p.toString()}`;
}

/** Top-100 board for a category from the shared backend; falls back to local offline. */
export async function fetchScores(kind: RunKind = 'arcade', challenge: number | null = null): Promise<ScoreEntry[]> {
  try {
    const res = await fetch(query(kind, challenge), { method: 'GET' });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = (await res.json()) as { scores: ServerRow[] };
    return data.scores.map(fromRow);
  } catch {
    return sortBoard(loadLocal(kind, challenge));
  }
}

/** True if `score` makes the board (board is the already-fetched top list). */
export function qualifies(score: number, board: ScoreEntry[]): boolean {
  return board.length < MAX_ENTRIES || score > board[board.length - 1].score;
}

/** Submit a score; returns the updated board and the new entry's rank (-1 if it didn't place). */
export async function submitScore(entry: ScoreEntry): Promise<{ rank: number; scores: ScoreEntry[] }> {
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        initials: entry.initials, score: entry.score, level: entry.level, wave: entry.wave,
        kind: entry.kind, day: entry.day, challenge: entry.challenge, stats: entry.stats,
        version: entry.version,
      }),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = (await res.json()) as { rank: number; scores: ServerRow[] };
    return { rank: data.rank, scores: data.scores.map(fromRow) };
  } catch {
    // Offline / no backend: persist a local board so the flow still works.
    const board = sortBoard([...loadLocal(entry.kind, entry.challenge), entry]);
    saveLocal(entry.kind, entry.challenge, board);
    return { rank: board.indexOf(entry), scores: board };
  }
}
