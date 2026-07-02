# Crystal Defense

Endless 3D tower defense built with **Vite + TypeScript + Three.js** — daily challenges, mutator drafts, and a global leaderboard. Defend the crystal forever, or until it shatters.

![Crystal Defense gameplay](crystal-defense-screenshot.png)

**Endless mode:** each level is 10 waves on a procedurally generated map (random
path, random stream crossing, random foliage). Clear a level and the battlefield
regenerates at a higher difficulty: your towers are salvaged for 60% of their
invested gold, the crystal heals a little, and the climb continues until the
crystal dies. Bosses arrive on waves 5 and 10 of every level. Waves can roll
random modifiers (HORDE, IRONCLAD, LIGHTNING, UNDYING, ELITE).

## Run it

```bash
npm install
npm run dev
```

Open the printed URL (default `http://localhost:5173`).

Production build: `npm run build`, then `npm run preview`.

## Tests

Unit tests (Vitest) cover the pure game logic — balance math, the seeded RNG,
wave generation, mutators and leaderboard rules:

```bash
npm test          # run once
npm run test:watch
```

`npm run build` runs **type-check → tests → bundle** (`tsc && vitest run &&
vite build`), so a failing test blocks the production build/deploy.

## Leaderboard & data

Scores are submitted to a shared leaderboard — a Vercel serverless function
(`api/leaderboard.ts`) backed by a Turso (libSQL) database. `api/health.ts`
reports which database a deployment resolved (`/api/health`).

Database selection (highest precedence first):

| Env var pair | Used by | Notes |
| ------------ | ------- | ----- |
| `LEADERBOARD_TURSO_*` | **production** | The stable production board. Set these manually (Production scope). |
| `CRSTL_DEV_TURSO_*` | preview / local | Dedicated dev DB so test scores never hit production. |
| `CRSTL_TURSO_*` | fallback | **Managed by the Turso↔Vercel integration — do not rely on it for production.** |

> ⚠️ The Turso integration provisions a **new database branch per deployment**
> and injects it as `CRSTL_TURSO_DATABASE_URL` at deploy time, so using that var
> for production meant every deploy pointed the live board at a fresh, empty DB.
> Production therefore reads a **manually-set** `LEADERBOARD_TURSO_*` pair (a name
> the integration doesn't manage) so the board survives deploys. Confirm with
> `/api/health` → it should report `db:"production-stable"`.

`backups/` holds a recovery snapshot of the leaderboard plus
`restore-leaderboard.mjs`, an **insert-only, idempotent** restore script:

```bash
RESTORE_TURSO_DATABASE_URL=... RESTORE_TURSO_AUTH_TOKEN=... \
  node backups/restore-leaderboard.mjs backups/<snapshot>.json
```

## How to play

1. Click a tower card (or keys **1–6**), then click a tile to build. Esc cancels.
2. Press **Start Game** (or **Space**) for wave 1. After that, waves auto-start
   on a 5-second countdown (12s between levels) — click the button to start early.
3. Click a built tower to **upgrade** it (Lv.1 → Lv.5) or sell it — the left-side
   panel shows its live stats (damage, range, fire rate, kills, DPM, gold
   invested, and DPM-per-gold efficiency). **Upgrade All** upgrades cheapest-first.
4. The crystal has a health bar; enemies that reach it deal damage (it flashes
   and shakes). At zero, the run ends.
5. Killing enemies grants **mana**; it also regenerates during waves. Abilities
   start locked (100g to unlock) and scale hard from Lv.1 → Lv.5. Spend mana on:
   - **☄ Meteor Strike (Q)** — click the map, area damage that scales 10× per level.
   - **✚ Heal (W)** — repair the crystal, from +2 up to a full heal at max level.
   - **⚡ Frenzy (E)** — all towers fire faster (×1.2 → ×2.8) for 8–14s.
6. Watch the **NEXT** intel panel and pre-build counters before a wave lands.
7. **Right-drag** rotates the camera, **wheel** zooms, **middle-drag** pans.
8. Towers can't be built on the path, the stream, or foliage. The path crosses
   the stream on a plank bridge.
9. Sound effects are synthesized in-browser (no assets) — toggle sound with the
   **🔊 button** or **M**, music with **N**, and graphics quality with the
   **Qual/Perf** button (see *Graphics & performance*). All settings persist.
10. Game speed cycles **1× → 2× → 3×**.
11. When the crystal falls, a **global leaderboard** appears — enter your three
    initials. Scores are stored server-side (Turso). Daily Challenge scores keep
    their own per-challenge board.
12. **Pause** doubles as Help: it pauses the game and opens How to Play as an
    overlay. Closing it (Back) resumes — that's the only way to unpause.
13. Each level's build phase gives you **15 seconds** (a large countdown shows
    on screen), immune to the 1×–3× speed setting. Tower placement works
    during it; no other actions (building, upgrading, selling, abilities) can
    be taken while paused.
14. Tower and ability upgrades are **gated by game level**: Lv.1 = no
    upgrades, Lv.2 unlocks upgrades to Lv.2, ... Lv.5+ unlocks the full Lv.5
    cap. Towers rebuild fresh every level, so this eases you into full power
    over your first few levels rather than handing it out immediately.

## Graphics & performance

The top-left cluster has three toggles — **🔊 sound** (`M`), **🎵 music** (`N`),
and a **graphics-quality** button — each persisted to `localStorage`:

| Mode | What it does |
| ---- | ------------ |
| **Qual** (default) | Full visuals: bloom/glow, soft shadows, a colour-grade + vignette pass, per-level palettes, and all the polish VFX (muzzle flashes, hit-flash, tower recoil, boss telegraph auras, spawn materialize, frost-shatter kills, per-archetype death bursts, fireflies, a school of fish in the river, a health-tied crystal aura). |
| **Perf** | Keeps **full resolution + antialias** (stays crisp) but aggressively strips the expensive work — no bloom, shadows, colour-grade, stars, or particle VFX, no tower recoil, a flat static sea tinted to match the sky (no water texture/motion), a frozen portal + crystal, and no impact/hit puffs — for smooth play on weaker hardware. The rare set-pieces (meteor cast, crystal-death finale) still play. |

There's no auto-detection: the default is **Qual**, and players flip to **Perf**
themselves. Each cost centre is a named flag in `QualityConfig`
(`src/quality.ts`) — `extras` gates the polish VFX, and `recoil` / `background`
/ `worldAnim` / `impactFx` strip the rest — so Performance mode stays lean.

Rendering is Three.js with an `EffectComposer` chain (bloom → colour-grade →
output), ACES tone mapping, and PCF soft shadows — all asset-free (geometry from
primitives, textures generated on-canvas).

## Towers

| Tower  | Cost | Role |
| ------ | ---- | ---- |
| Basic  | 250  | Balanced damage/range/rate |
| Rapid  | 450  | Short-range burst DPS — huge damage-per-minute, tiny range, shredded by armor |
| Sniper | 650  | Huge range, heavy beam — punches through armor |
| Frost  | 500  | Slows enemies to half speed |
| Cannon | 850  | Splash shells — answer to swarms/hordes |
| Tesla  | 1100 | Chain lightning: hits 3 enemies, +1 per level |

Exact live numbers (damage, range, fire rate, and derived DPM / DPM-per-gold)
are always in-game via the tower build-menu tooltips and the **How to Play**
panel, generated straight from `src/config.ts` so they never drift from this table.

## Enemies

Grunts, fast Runners, tiny Swarmers in packs, **Ironbacks** (flat armor blunts
small hits — high per-hit damage beats them), and armored regenerating
**Bosses**. Regenerating **Trolls** shrug off 50% of Tesla's chain damage but
take +50% from Sniper's armor-piercing beam; **Tanks** are the reverse — no
armor at all, but +50% weak to Tesla. The in-game How to Play panel spells out
every enemy's exact HP/armor/resist numbers, plus a live-generated Scaling
section showing exactly how towers and enemies grow per level/wave.

## Project structure

```
index.html          HUD markup + canvas mount point
src/main.ts         entry point
src/config.ts       balance data: towers, upgrades, enemies, abilities, levels
src/rng.ts          seedable RNG helpers
src/waves.ts        procedural wave generation, modifiers, endless scaling
src/map.ts          random path + stream/bridge, foliage, crystal flash
src/enemy.ts        movement, armor/regen, health bars, boss labels
src/tower.ts        tower visuals, levels, targeting, firing
src/projectile.ts   homing projectiles
src/effects.ts      beams, explosions, damage numbers, meteors, muzzle flash, shatter bursts
src/audio.ts        Web Audio synthesized SFX + mute persistence
src/music.ts        procedural Web Audio soundtrack
src/quality.ts      graphics-quality modes (Qual/Perf) + localStorage persistence
src/leaderboard.ts  shared leaderboard client (falls back to localStorage offline)
src/ui.ts           DOM HUD: stats, palette, abilities, buttons, overlays
src/game.ts         orchestrator: scene, bloom, colour-grade, input, levels, VFX, loop
src/styles.css      HUD styling
```
