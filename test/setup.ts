// Minimal browser-API stubs so Node-environment tests can import modules that
// touch localStorage at load time (e.g. audio/leaderboard) without crashing.
import { vi } from 'vitest';

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string): string | null => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string): void => { store.set(k, String(v)); },
  removeItem: (k: string): void => { store.delete(k); },
  clear: (): void => { store.clear(); },
});
