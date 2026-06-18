// Shared leaderboard backed by the serverless API (Turso/libSQL). Falls back to
// localStorage when the backend is unavailable (e.g. `npm run dev` without
// `vercel dev`), so the arcade flow keeps working offline.

export interface ScoreEntry {
  initials: string;
  score: number;
  level: number;
  wave: number;
  date: number;
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
}

function fromRow(r: ServerRow): ScoreEntry {
  return {
    initials: r.initials,
    score: Number(r.score),
    level: Number(r.level),
    wave: Number(r.wave),
    date: Number(r.created_at),
  };
}

function loadLocal(): ScoreEntry[] {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    const parsed = raw ? (JSON.parse(raw) as ScoreEntry[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveLocal(board: ScoreEntry[]): void {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(board.slice(0, MAX_ENTRIES)));
  } catch {
    /* storage unavailable — ignore */
  }
}

function sortBoard(board: ScoreEntry[]): ScoreEntry[] {
  return board.slice().sort((a, b) => b.score - a.score || a.date - b.date).slice(0, MAX_ENTRIES);
}

/** Top-100 board from the shared backend; falls back to the local board offline. */
export async function fetchScores(): Promise<ScoreEntry[]> {
  try {
    const res = await fetch(API, { method: 'GET' });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = (await res.json()) as { scores: ServerRow[] };
    return data.scores.map(fromRow);
  } catch {
    return sortBoard(loadLocal());
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
      }),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = (await res.json()) as { rank: number; scores: ServerRow[] };
    return { rank: data.rank, scores: data.scores.map(fromRow) };
  } catch {
    // Offline / no backend: persist a local board so the flow still works.
    const board = sortBoard([...loadLocal(), entry]);
    saveLocal(board);
    return { rank: board.indexOf(entry), scores: board };
  }
}
