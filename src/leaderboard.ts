// Arcade-style local leaderboard persisted in localStorage.

export interface ScoreEntry {
  initials: string;
  score: number;
  level: number;
  wave: number;
  date: number;
}

const KEY = 'cd-leaderboard';
const MAX_ENTRIES = 10;

export function loadScores(): ScoreEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ScoreEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** True if this score earns a spot on the board. */
export function qualifies(score: number): boolean {
  const board = loadScores();
  return board.length < MAX_ENTRIES || score > board[board.length - 1].score;
}

/** Inserts the entry and returns its rank index (0-based), or -1 if it didn't place. */
export function addScore(entry: ScoreEntry): number {
  const board = loadScores();
  board.push(entry);
  board.sort((a, b) => b.score - a.score || a.date - b.date);
  const trimmed = board.slice(0, MAX_ENTRIES);
  localStorage.setItem(KEY, JSON.stringify(trimmed));
  return trimmed.indexOf(entry);
}
