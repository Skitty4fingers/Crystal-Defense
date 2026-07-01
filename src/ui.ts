import {
  ABILITIES, ABILITY_MAX_LEVEL, ENEMY_TYPES, MAX_LEVEL, SELL_REFUND, TOWER_TYPES, WAVES_PER_LEVEL,
  abilityCooldown, abilityUpgradeCost, frenzyMult, healAmount, levelDamage, levelFireRate,
  levelRewardMult, meteorDamage, upgradeCost, waveBonus, waveHpMult, waveSpeedMult,
} from './config';
import type { TowerSpec } from './config';
import { DAILY_CHALLENGES, DRAFT_POOL, localDayNumber } from './mutators';
import type { Tower } from './tower';
import type { RunKind, ScoreEntry } from './leaderboard';
import type { QualityMode } from './quality';

/** Daily challenge type shown by default in the leaderboard (today's rotation,
 * keyed off the player's local day so it flips at their own midnight). */
const todayChallengeIndex = (): number =>
  localDayNumber() % DAILY_CHALLENGES.length;

export interface DraftOption {
  id: string;
  name: string;
  icon: string;
  buff: string;
  nerf: string;
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

/** Retrigger the pop animation on a stat number. `down` flags a loss (red). */
function popStat(el: HTMLElement, down = false): void {
  el.classList.remove('pop', 'pop-down');
  void el.offsetWidth; // reflow so the animation restarts
  el.classList.add(down ? 'pop-down' : 'pop');
}

function colorHex(c: number): string {
  return `#${c.toString(16).padStart(6, '0')}`;
}

function fmtNum(n: number, decimals = 1): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(decimals) + 'm';
  if (n >= 1_000) return (n / 1_000).toFixed(decimals) + 'k';
  return String(Math.floor(n));
}

export interface AbilityState {
  id: string;
  level: number;
  maxLevel: number;
  unlocked: boolean;
  unlockCost: number;
  upgradeCost: number | null;
  /** Game level required before the next upgrade unlocks; null if not gated. */
  gatedAtLevel: number | null;
  affordableUnlock: boolean;
  affordableUpgrade: boolean;
  affordableMana: boolean;
  cooldownLeft: number;
  usable: boolean; // wave running etc.
  /** Current effect summary, e.g. "1,920 dmg · 3.4 radius". */
  effect: string;
}

/** All DOM/HUD handling. The Game assigns the on* callbacks. */
export class UI {
  onSelectTower: (id: string) => void = () => {};
  onAbility: (id: string) => void = () => {};
  onUnlockAbility: (id: string) => void = () => {};
  onUpgradeAbility: (id: string) => void = () => {};
  onWaveButton: () => void = () => {};
  onUpgradeAll: () => void = () => {};
  onPause: () => void = () => {};
  onSpeed: () => void = () => {};
  onMute: () => void = () => {};
  onMusicToggle: () => void = () => {};
  onQuality: () => void = () => {};
  onSidebarToggle: () => void = () => {};
  onRestart: () => void = () => {};
  onSubmitScore: (initials: string) => void = () => {};
  onSell: () => void = () => {};
  onUpgrade: () => void = () => {};
  onStartRun: (kind: RunKind) => void = () => {};
  onDraftPick: (id: string) => void = () => {};
  onShowLeaderboard: (kind: RunKind, challenge: number | null) => void = () => {};
  /** Supplies today's daily challenge for the splash button + leaderboard label. */
  dailyChallenge: () => { name: string; icon: string; rule: string } = () =>
    ({ name: '', icon: '', rule: '' });

  private statLevel = byId('stat-level');
  private statWave = byId('stat-wave');
  private statLives = byId('stat-lives');
  private statGold = byId('stat-gold');
  private statMana = byId('stat-mana');
  private statScore = byId('stat-score');
  private palette = byId('palette');
  private abilitiesBox = byId('abilities');
  private nextHint = byId('next-hint');
  private info = byId('info');
  private towerInfo = byId('tower-info');
  private banner = byId('banner');
  private overlay = byId('overlay');
  private overlayTitle = byId('overlay-title');
  private overlaySub = byId('overlay-sub');
  private initialsEntry = byId('initials-entry');
  private initialsInput = byId<HTMLInputElement>('initials-input');
  private scoresBox = byId('scores');
  private splash = byId('splash');
  private splashMenu = byId('splash-menu');
  private splashPanel = byId('splash-panel');
  private splashPanelContent = byId('splash-panel-content');
  private btnWave = byId<HTMLButtonElement>('btn-wave');
  private btnUpgradeAll = byId<HTMLButtonElement>('btn-upgrade-all');
  private btnPause = byId<HTMLButtonElement>('btn-pause');
  private btnSpeed = byId<HTMLButtonElement>('btn-speed');
  private btnMute = byId<HTMLButtonElement>('btn-mute');
  private btnMusic = byId<HTMLButtonElement>('btn-music');
  private btnQuality = byId<HTMLButtonElement>('btn-quality');
  private btnSidebar = document.getElementById('btn-sidebar') as HTMLButtonElement | null;
  private abilitiesTitle = document.querySelector('.abilities-title') as HTMLElement;
  private bossWrap = byId('stat-boss-wrap');
  private bossVal = byId('stat-boss');
  private activeMutators = byId('active-mutators');
  private draft = byId('draft');
  private draftCards = byId('draft-cards');
  private statPopup = byId('stat-popup');
  private statPopupContent = byId('stat-popup-content');
  private levelCountdown = byId('level-countdown');
  private btnSplashBack = byId<HTMLButtonElement>('btn-splash-back');

  private cards = new Map<string, HTMLElement>();
  private abilityRows = new Map<string, HTMLElement>();
  private bannerTimer = 0;
  // Previous stat values, so setStats can pop only the numbers that changed.
  private prevGold = -1;
  private prevScore = -1;
  private prevLives = -1;
  /** Where the splash-panel "Back" button goes; overridden while How-to-Play is
   * shown mid-run via showInstructionsOverlay(), restored once it closes. */
  private splashBackAction: () => void = () => this.showSplashMenu();
  /** Entries currently shown in a board, for drill-in lookups. */
  private boardEntries: ScoreEntry[] = [];
  private boardKind: RunKind = 'arcade';
  private boardChallenge: number | null = null;

  constructor() {
    const versionLink = document.getElementById('version-link') as HTMLAnchorElement | null;
    if (versionLink) {
      versionLink.textContent = `v${__APP_VERSION__}`;
      versionLink.href = `https://github.com/Skitty4fingers/Crystal-Defense/releases/tag/v${__APP_VERSION__}`;
    }
    this.buildPalette();
    this.buildAbilities();
    this.btnWave.addEventListener('click', () => this.onWaveButton());
    this.btnUpgradeAll.addEventListener('click', () => this.onUpgradeAll());
    this.btnPause.addEventListener('click', () => this.onPause());
    this.btnSpeed.addEventListener('click', () => this.onSpeed());
    this.btnMute.addEventListener('click', () => this.onMute());
    this.btnMusic.addEventListener('click', () => this.onMusicToggle());
    this.btnQuality.addEventListener('click', () => this.onQuality());
    this.btnSidebar?.addEventListener('click', () => this.onSidebarToggle());
    byId('btn-restart').addEventListener('click', () => this.onRestart());
    byId('btn-overlay').addEventListener('click', () => this.onRestart());
    byId('btn-submit-score').addEventListener('click', () => this.submitInitials());
    this.initialsInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.submitInitials();
      e.stopPropagation(); // keep game hotkeys (1-6, m, space) out of typing
    });
    this.initialsInput.addEventListener('input', () => {
      this.initialsInput.value = this.initialsInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    });
    // Sell/upgrade buttons are recreated when the tower-info panel re-renders, so delegate.
    this.towerInfo.addEventListener('click', (e) => {
      const id = (e.target as HTMLElement).id;
      if (id === 'btn-sell') this.onSell();
      if (id === 'btn-upgrade') this.onUpgrade();
    });

    // Splash / front-door menu.
    byId('btn-start').addEventListener('click', () => this.startRun('arcade'));
    byId('btn-daily').addEventListener('click', () => this.startRun('daily'));
    byId('btn-instructions').addEventListener('click', () => this.showInstructions());
    byId('btn-leaderboard').addEventListener('click', () => this.openSplashBoard('arcade', null));
    this.btnSplashBack.addEventListener('click', () => this.splashBackAction());

    // Draft cards are recreated each level, so delegate the pick.
    this.draftCards.addEventListener('click', (e) => {
      const card = (e.target as HTMLElement).closest('.draft-card') as HTMLElement | null;
      if (card?.dataset.id) this.onDraftPick(card.dataset.id);
    });
    byId('btn-stat-close').addEventListener('click', () => this.statPopup.classList.add('hidden'));

  }

  /** Updates the daily-challenge button label; call once the provider is wired. */
  refreshDailyLabel(): void {
    const d = this.dailyChallenge();
    if (d.name) byId('btn-daily').innerHTML = `${d.icon} Daily: ${d.name}`;
  }

  private startRun(kind: RunKind): void {
    this.splash.classList.add('hidden');
    this.onStartRun(kind);
  }

  private openSplashBoard(kind: RunKind, challenge: number | null): void {
    this.showSplashPanel('<p class="splash-loading">Loading leaderboard&hellip;</p>');
    this.onShowLeaderboard(kind, challenge);
  }

  // ---------------------------------------------------------------- splash

  private showSplashPanel(html: string): void {
    this.splashPanelContent.innerHTML = html;
    this.splashMenu.classList.add('hidden');
    this.splashPanel.classList.remove('hidden');
  }

  private showSplashMenu(): void {
    this.splashPanel.classList.add('hidden');
    this.splashMenu.classList.remove('hidden');
  }

  /** Re-opens the splash screen (used when returning to the menu). Recomputes
   * the daily label so a run that spanned local midnight shows today's challenge. */
  showSplash(): void {
    this.refreshDailyLabel();
    this.showSplashMenu();
    this.splash.classList.remove('hidden');
  }

  /**
   * Renders the fetched shared leaderboard into the splash panel. Arcade is one
   * global board; Daily adds a selector for each of the rotating challenge types,
   * so you can browse the all-time best for Boss Rush, Storm Caller, etc.
   */
  showSplashLeaderboard(entries: ScoreEntry[], kind: RunKind, challenge: number | null = null): void {
    this.boardEntries = entries;
    this.boardKind = kind;
    this.boardChallenge = challenge;
    const tab = (k: RunKind, label: string): string =>
      `<button class="board-tab${k === kind ? ' active' : ''}" data-kind="${k}">${label}</button>`;
    const tabs = `<div class="board-tabs">${tab('arcade', 'Arcade')}${tab('daily', '★ Daily')}</div>`;

    let selector = '';
    if (kind === 'daily') {
      const sel = challenge ?? todayChallengeIndex();
      const today = todayChallengeIndex();
      const chips = DAILY_CHALLENGES.map((c, i) =>
        `<button class="daily-type${i === sel ? ' active' : ''}" data-chal="${i}" title="${c.buff}">` +
        `${c.icon} ${c.name}${i === today ? ' <span class="today-tag">TODAY</span>' : ''}</button>`,
      ).join('');
      const rule = DAILY_CHALLENGES[sel];
      selector = `<div class="daily-types">${chips}</div>` +
        `<p class="board-note">All-time best — <b>${rule.icon} ${rule.name}</b>: ${rule.buff}</p>`;
    }

    const body = entries.length
      ? this.scoreTableHtml(entries, -1)
      : '<p class="splash-loading">No scores yet — be the first!</p>';
    this.showSplashPanel(`<h2>Leaderboard</h2>${tabs}${selector}${body}`);

    this.splashPanelContent.querySelectorAll('.board-tab').forEach((b) =>
      b.addEventListener('click', () => {
        const k = (b as HTMLElement).dataset.kind as RunKind;
        this.openSplashBoard(k, k === 'daily' ? todayChallengeIndex() : null);
      }),
    );
    this.splashPanelContent.querySelectorAll('.daily-type').forEach((b) =>
      b.addEventListener('click', () => this.openSplashBoard('daily', Number((b as HTMLElement).dataset.chal))),
    );
    this.bindBoardDrillIn(this.splashPanelContent);
  }

  private showInstructions(): void {
    this.showSplashPanel(this.instructionsHtml());
  }

  /**
   * Opens How-to-Play as an overlay over an active run (opened by Pause) —
   * unlike the front-door version, its button reads "Resume" and returns to
   * the game (via onClose, which resumes) instead of the splash menu, so it
   * can't be used to sneak back into "Start Game" and discard the run.
   */
  showInstructionsOverlay(onClose: () => void): void {
    this.splashBackAction = () => {
      this.splash.classList.add('hidden');
      this.splashBackAction = () => this.showSplashMenu();
      this.btnSplashBack.innerHTML = '&#9664; Back';
      onClose();
    };
    this.btnSplashBack.innerHTML = '&#9654; Resume';
    this.showInstructions();
    this.splash.classList.remove('hidden');
  }

  /** Builds the How-to-Play content from the live config so it never drifts. */
  private instructionsHtml(): string {
    // Full combat-stats table (damage/fire rate/range/splash/cost/DPM/efficiency)
    // rather than prose Strength/Weakness — the same numbers already surface via
    // the build-palette hover tooltips, so this is the single source of truth.
    const towerRows = TOWER_TYPES.map((t) => {
      const dpm = t.damage * t.fireRate * 60;
      return `<tr>` +
        `<td><span class="swatch" style="background:${colorHex(t.color)}"></span>${t.name}</td>` +
        `<td class="num">${t.damage}</td>` +
        `<td class="num">${t.fireRate}/s</td>` +
        `<td class="num">${t.range}</td>` +
        `<td class="num">${t.splashRadius ?? '—'}</td>` +
        `<td class="num">${t.cost}g</td>` +
        `<td class="num">${fmtNum(dpm)}</td>` +
        `<td class="num">${(dpm / t.cost).toFixed(2)}</td>` +
        `</tr>`;
    }).join('');

    // Spells out the numeric armor/resist/weakness values that the vague trait
    // text used to hide, so "what does what" is answerable at a glance.
    const armorText = (e: (typeof ENEMY_TYPES)[string]): string => {
      const parts: string[] = [];
      if (e.armor) parts.push(`${e.armor} armor`);
      if (e.lightningResist) parts.push(`${Math.round(e.lightningResist * 100)}% Tesla resist`);
      if (e.sniperBonus) parts.push(`+${Math.round(e.sniperBonus * 100)}% vs Sniper`);
      if (e.lightningBonus) parts.push(`+${Math.round(e.lightningBonus * 100)}% vs Tesla`);
      return parts.length ? parts.join(' · ') : '—';
    };
    const enemyRows = Object.values(ENEMY_TYPES).map((e) =>
      `<tr>` +
      `<td><span class="swatch" style="background:${colorHex(e.color)}"></span>${e.name}</td>` +
      `<td class="num">${e.hp.toLocaleString()}</td>` +
      `<td class="fine">${armorText(e)}</td>` +
      `<td>${e.trait ?? ''}</td>` +
      `<td>${e.counter ?? ''}</td>` +
      `</tr>`,
    ).join('');

    // Scaling: sample values pulled from the live functions so the numbers can
    // never drift out of sync with the actual balance data in config.ts.
    const basic = TOWER_TYPES.find((t) => t.id === 'basic')!;
    const towerScaleRows = TOWER_TYPES.map((t) => {
      const dpmLo = levelDamage(t, 1) * levelFireRate(t, 1) * 60;
      const dpmHi = levelDamage(t, MAX_LEVEL) * levelFireRate(t, MAX_LEVEL) * 60;
      return `<tr><td>${t.name}</td><td class="num">${fmtNum(dpmLo)} → ${fmtNum(dpmHi)}</td></tr>`;
    }).join('');
    const waveScaleRows = [1, 10, 25, 50, 100].map((w) =>
      `<tr><td>${w}</td>` +
      `<td class="num">×${waveHpMult(w).toFixed(2)}</td>` +
      `<td class="num">×${waveSpeedMult(w).toFixed(2)}</td>` +
      `<td class="num">${waveBonus(w).toLocaleString()}g</td></tr>`,
    ).join('');

    // Abilities table built from the live scaling functions, so Lv.1 → Lv.5
    // values (and the shrinking cooldown / rising cost) never drift from config.
    const abilityScale = (id: string): string => {
      const lo = 1, hi = ABILITY_MAX_LEVEL;
      if (id === 'meteor') return `${meteorDamage(lo).toLocaleString()} → ${meteorDamage(hi).toLocaleString()} dmg`;
      if (id === 'heal') return `+${healAmount(lo)} → +${healAmount(hi)} crystal HP`;
      if (id === 'frenzy') return `×${frenzyMult(lo).toFixed(1)} → ×${frenzyMult(hi).toFixed(1)} fire rate`;
      return '';
    };
    const abilityRows = ABILITIES.map((a) =>
      `<tr>` +
      `<td><b style="color:${a.color}">${a.icon} ${a.name}</b><br><span class="fine">${a.key} · ${a.manaCost} mana</span></td>` +
      `<td>${abilityScale(a.id)}</td>` +
      `<td class="num">${a.unlockCost}g → ${abilityUpgradeCost(a, ABILITY_MAX_LEVEL - 1).toLocaleString()}g</td>` +
      `</tr>`,
    ).join('');

    const draftMutatorRows = DRAFT_POOL.map((m) =>
      `<tr>` +
      `<td>${m.icon} <b>${m.name}</b></td>` +
      `<td style="color:#3ecf6e">${m.buff}</td>` +
      `<td style="color:#ff9d8a">${m.nerf}</td>` +
      `</tr>`,
    ).join('');

    const dailyRows = DAILY_CHALLENGES.map((c) =>
      `<li><b>${c.icon} ${c.name}</b> — ${c.buff}</li>`,
    ).join('');

    return (
      `<h2>How to Play</h2>` +
      `<p>Build towers on the grass to stop monsters marching down the path. Every leak ` +
      `chips your crystal's health — lose all of it and the run ends. Survive ` +
      `${WAVES_PER_LEVEL} waves to clear a level: the map regenerates harder, your towers ` +
      `are salvaged for 60% gold, and the difficulty climbs forever. Earn gold from kills ` +
      `and wave bonuses; spend mana on special abilities.</p>` +

      `<h3>Towers</h3>` +
      `<table class="info-table">` +
      `<tr><th>Tower</th><th>Dmg</th><th>Rate</th><th>Range</th><th>Splash</th><th>Cost</th>` +
      `<th>DPM</th><th>DPM/g</th></tr>${towerRows}</table>` +
      `<p class="fine">Click a built tower to upgrade it (up to Lv.${MAX_LEVEL}) or sell it. ` +
      `DPM = damage-per-minute; DPM/g = DPM per gold invested (efficiency).</p>` +

      `<h3>Enemies</h3>` +
      `<p class="fine">Armor is a flat reduction applied per hit (a hit always deals at least 25% of ` +
      `its raw damage). Armor Pierce subtracts directly from armor before that reduction applies.</p>` +
      `<table class="info-table">` +
      `<tr><th>Enemy</th><th>HP</th><th>Armor</th><th>Trait</th><th>Counter</th></tr>${enemyRows}</table>` +

      `<h3>Scaling</h3>` +
      `<p class="fine">Tower upgrades: damage ×1.44/level, fire rate ×1.25/level, range +0.6/level. ` +
      `Each upgrade costs the tower's base price × the level you're upgrading from — a ` +
      `${basic.cost}g tower costs ${upgradeCost(basic, 1).toLocaleString()}g to reach Lv.2, ` +
      `${upgradeCost(basic, MAX_LEVEL - 1).toLocaleString()}g to reach Lv.${MAX_LEVEL} from Lv.${MAX_LEVEL - 1}.</p>` +
      `<table class="info-table">` +
      `<tr><th>Tower</th><th>DPM Lv.1 → Lv.${MAX_LEVEL}</th></tr>${towerScaleRows}</table>` +
      `<p class="fine">Enemies: HP and speed scale with the total wave count survived (speed caps ` +
      `at ×1.6). Kill-gold rewards scale per <b>level</b> (every ${WAVES_PER_LEVEL} waves) via ` +
      `<code>${levelRewardMult(1).toFixed(1)}× at Lv.1 → ${levelRewardMult(10).toFixed(1)}× at Lv.10</code>, ` +
      `uncapped — so funding new builds stays possible deep into a run.</p>` +
      `<table class="info-table">` +
      `<tr><th>Wave</th><th>Enemy HP</th><th>Enemy Speed</th><th>Clear Bonus</th></tr>${waveScaleRows}</table>` +

      `<h3>Special Abilities</h3>` +
      `<p>Abilities start <b>locked</b> — unlock each for just <b>100g</b>, then upgrade to ` +
      `Lv.${ABILITY_MAX_LEVEL}. Upgrades scale hard (the final tier costs ~100,000g) but so does ` +
      `the payoff, and the <b>cooldown drops from 45s to 25s</b> as you level. Casting costs mana.</p>` +
      `<table class="info-table">` +
      `<tr><th>Ability</th><th>Lv.1 → Lv.5</th><th>Unlock → Lv.5 cost</th></tr>${abilityRows}</table>` +

      `<h3>Boss Multiplier</h3>` +
      `<p>Bosses are the run's high-score moments: every boss you slay <b>raises a score ` +
      `multiplier</b> that boosts the points from each later boss. Survive deep, fell many ` +
      `bosses, climb the board.</p>` +

      `<h3>Mutators (Arcade Draft)</h3>` +
      `<p>From level 3 onward you <b>draft 1 of 3</b> mutators each level. Every pick has exactly one buff and one nerf, keeping the leaderboard fair. Picks stack and compound for the rest of the run.</p>` +
      `<p class="fine"><b>Note on "immediate gold" effects:</b> Treasury and Adrenaline change your gold right now — you receive or lose that gold the moment you pick the card, not at the start of a future run.</p>` +
      `<table class="info-table">` +
      `<tr><th>Mutator</th><th>Buff</th><th>Nerf</th></tr>` +
      `${draftMutatorRows}</table>` +

      `<h3>Daily Challenge</h3>` +
      `<p>One of ${DAILY_CHALLENGES.length} themed challenges rotates each day. Everyone gets the ` +
      `<b>same map, waves and rule</b> that day, and each challenge type keeps its own all-time ` +
      `leaderboard — switch to the <b>Daily</b> tab to browse them.</p>` +
      `<ul class="ability-list">${dailyRows}</ul>` +

      `<h3>Controls</h3>` +
      `<ul class="controls-list">` +
      `<li><b>1&ndash;6</b> select a tower to build · click a tile to place</li>` +
      `<li><b>Q / W / E</b> cast Meteor / Heal / Frenzy</li>` +
      `<li><b>Space</b> start the next wave · <b>Esc</b> cancel placement</li>` +
      `<li><b>M</b> toggle sound · <b>N</b> toggle music · click a tower to upgrade or sell</li>` +
      `<li><b>Right-drag</b> rotate · <b>Middle-drag</b> pan · <b>Scroll</b> zoom</li>` +
      `<li><b>Restart</b> returns to the menu to pick a mode.</li>` +
      `</ul>` +

      `<h3>Graphics</h3>` +
      `<p>The top-left buttons toggle <b>sound</b>, <b>music</b>, and <b>graphics quality</b>. ` +
      `The quality button switches between <b>Qual</b> (full visuals — bloom, shadows, ` +
      `particle effects, atmosphere) and <b>Perf</b> (a lighter mode that keeps full ` +
      `resolution but drops the heavy effects for smoother play on weaker devices). ` +
      `Your choice is remembered between sessions.</p>`
    );
  }

  private buildPalette(): void {
    TOWER_TYPES.forEach((spec, i) => {
      const card = document.createElement('div');
      card.className = 'tower-card';
      const baseDpm = spec.damage * spec.fireRate * 60;
      card.title =
        `${spec.description}\n` +
        `Damage ${spec.damage} · Range ${spec.range} · ${spec.fireRate}/s` +
        (spec.splashRadius ? ` · Splash ${spec.splashRadius}` : '') +
        (spec.slowFactor ? ` · Slows to ${spec.slowFactor * 100}%` : '') +
        `\nDPM ${fmtNum(baseDpm)} · DPM/gold ${(baseDpm / spec.cost).toFixed(2)}`;
      card.innerHTML =
        `<span class="tower-key">${i + 1}</span>` +
        `<div class="tower-icon" style="background:${colorHex(spec.color)}"></div>` +
        `<div class="tower-name">${spec.name}</div>` +
        `<div class="tower-cost">&#9679; ${fmtNum(spec.cost)}</div>`;
      card.addEventListener('click', () => this.onSelectTower(spec.id));
      this.palette.appendChild(card);
      this.cards.set(spec.id, card);
    });
  }

  updatePaletteCosts(costMult: number): void {
    TOWER_TYPES.forEach((spec) => {
      const el = this.cards.get(spec.id)?.querySelector('.tower-cost');
      if (el) el.textContent = `● ${fmtNum(Math.round(spec.cost * costMult))}`;
    });
  }

  private buildAbilities(): void {
    for (const a of ABILITIES) {
      const row = document.createElement('div');
      row.className = 'ability-row locked';
      row.title =
        `${a.description}\nHotkey: ${a.key} · Cooldown ${a.cooldown}s · ${a.manaCost} mana\n` +
        `Unlock for ${a.unlockCost}g, then upgrade with gold.`;
      row.innerHTML =
        `<div class="ability-icon" style="background:${a.color}">${a.icon}</div>` +
        `<div class="ability-main">` +
          `<div class="ability-top">` +
            `<b class="ability-name">${a.name}</b>` +
            `<span class="ability-lv"></span>` +
          `</div>` +
          `<span class="ability-effect"></span>` +
          `<div class="ability-bottom">` +
            `<span class="ability-sub">${a.manaCost} mana</span>` +
            `<span class="ability-cd"></span>` +
            `<button class="ability-action btn"></button>` +
          `</div>` +
        `</div>`;
      // Clicking the row casts; the action button buys/upgrades (don't also cast).
      row.addEventListener('click', () => this.onAbility(a.id));
      const btn = row.querySelector('.ability-action') as HTMLButtonElement;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (row.classList.contains('locked')) this.onUnlockAbility(a.id);
        else this.onUpgradeAbility(a.id);
      });
      this.abilitiesBox.appendChild(row);
      this.abilityRows.set(a.id, row);
    }
  }

  setStats(gold: number, lives: number, mana: number, score: number, wave: number, level: number): void {
    const wholeGold = Math.floor(gold);
    const wholeScore = Math.floor(score);
    this.statGold.textContent = fmtNum(wholeGold);
    this.statLives.textContent = String(lives);
    this.statMana.textContent = fmtNum(Math.floor(mana));
    this.statScore.textContent = fmtNum(wholeScore);
    this.statLevel.textContent = String(level);
    this.statWave.textContent = `${wave} / ${WAVES_PER_LEVEL}`;
    // Pop the numbers that changed (skip the very first call which seeds prevs).
    if (this.prevGold >= 0) {
      if (wholeGold !== this.prevGold) popStat(this.statGold);
      if (wholeScore !== this.prevScore) popStat(this.statScore);
      if (lives !== this.prevLives) popStat(this.statLives, lives < this.prevLives);
    }
    this.prevGold = wholeGold;
    this.prevScore = wholeScore;
    this.prevLives = lives;
    for (const spec of TOWER_TYPES) {
      this.cards.get(spec.id)!.classList.toggle('disabled', spec.cost > wholeGold);
    }
  }

  updateAbilities(states: AbilityState[]): void {
    for (const s of states) {
      const row = this.abilityRows.get(s.id)!;
      const onCd = s.cooldownLeft > 0;
      row.classList.toggle('locked', !s.unlocked);
      // The row body (cast) is dimmed when it can't be cast right now.
      row.classList.toggle('disabled', !s.unlocked || !s.usable || !s.affordableMana || onCd);

      const lv = row.querySelector('.ability-lv') as HTMLElement;
      lv.textContent = s.unlocked ? `Lv.${s.level}/${s.maxLevel}` : 'LOCKED';

      const effect = row.querySelector('.ability-effect') as HTMLElement;
      effect.textContent = s.effect;

      const cd = row.querySelector('.ability-cd') as HTMLElement;
      cd.textContent = onCd ? `${Math.ceil(s.cooldownLeft)}s` : '';

      const btn = row.querySelector('.ability-action') as HTMLButtonElement;
      if (!s.unlocked) {
        btn.textContent = `Unlock ${fmtNum(s.unlockCost)}g`;
        btn.className = 'ability-action btn buy';
        btn.disabled = !s.affordableUnlock;
      } else if (s.upgradeCost !== null) {
        btn.textContent = `▲ ${fmtNum(s.upgradeCost)}g`;
        btn.className = 'ability-action btn upgrade';
        btn.disabled = !s.affordableUpgrade;
      } else if (s.gatedAtLevel !== null) {
        btn.textContent = `Reach Lv.${s.gatedAtLevel}`;
        btn.className = 'ability-action btn maxed';
        btn.disabled = true;
      } else {
        btn.textContent = 'MAX';
        btn.className = 'ability-action btn maxed';
        btn.disabled = true;
      }
    }
  }

  setNextWaveHint(hint: string | null): void {
    this.nextHint.textContent = hint ?? '—';
  }

  setSelectedCard(id: string | null): void {
    for (const [cardId, card] of this.cards) {
      card.classList.toggle('selected', cardId === id);
    }
  }

  setWaveButton(label: string, enabled: boolean): void {
    this.btnWave.innerHTML = label;
    this.btnWave.disabled = !enabled;
  }

  setPauseLabel(paused: boolean): void {
    this.btnPause.textContent = paused ? 'Resume' : 'Pause';
  }

  /** Large transparent countdown shown during the once-per-level build window.
   * `seconds` null hides it. */
  setLevelCountdown(seconds: number | null): void {
    if (seconds === null) {
      this.levelCountdown.classList.add('hidden');
      return;
    }
    this.levelCountdown.textContent = String(seconds);
    this.levelCountdown.classList.remove('hidden');
  }

  setSpeedLabel(mult: number): void {
    this.btnSpeed.innerHTML = `${mult}&times; Speed`;
  }

  setMuteLabel(muted: boolean): void {
    this.btnMute.textContent = muted ? '🔇' : '🔊';
    this.btnMute.title = muted ? 'Sound off — click to unmute (M)' : 'Sound on — click to mute (M)';
  }

  setMusicLabel(muted: boolean): void {
    this.btnMusic.textContent = '🎵';
    this.btnMusic.classList.toggle('off', muted);
    this.btnMusic.title = muted ? 'Music off — click to play (N)' : 'Music on — click to mute (N)';
  }

  setQualityLabel(mode: QualityMode): void {
    const perf = mode === 'performance';
    this.btnQuality.textContent = perf ? 'Perf' : 'Qual';
    // A distinct amber tint for Performance (NOT the muted-style .off strikethrough,
    // which is semantically wrong here and mis-anchors across the button row).
    this.btnQuality.classList.toggle('perf-on', perf);
    this.btnQuality.title = perf
      ? 'Performance graphics — click for full Quality'
      : 'Quality graphics — click for Performance';
  }

  setSidebarOpen(open: boolean): void {
    document.body.classList.toggle('sidebar-hidden', !open);
    if (this.btnSidebar) {
      this.btnSidebar.innerHTML = open ? '&#10005; BUILD' : '&#9776; BUILD';
    }
  }

  /** Brief full-screen white flash — used for the crystal-death blast. */
  flashScreen(): void {
    const flash = byId('flash');
    flash.classList.remove('flash-anim');
    void flash.offsetWidth; // force reflow so the animation restarts
    flash.classList.add('flash-anim');
  }

  showBanner(text: string, kind: 'normal' | 'boss' = 'normal', seconds = 2.3): void {
    this.banner.textContent = text;
    this.banner.classList.toggle('boss', kind === 'boss');
    this.banner.classList.remove('hidden');
    // Retrigger the entrance flourish each time a banner is shown.
    this.banner.classList.remove('flourish');
    void this.banner.offsetWidth; // reflow so the animation restarts
    this.banner.classList.add('flourish');
    window.clearTimeout(this.bannerTimer);
    this.bannerTimer = window.setTimeout(() => this.banner.classList.add('hidden'), seconds * 1000);
  }

  showPlacingInfo(spec: TowerSpec): void {
    this.towerInfo.classList.add('hidden');
    this.info.innerHTML =
      `<b style="color:${colorHex(spec.color)}">${spec.name} Tower</b>` +
      `<span class="sep">|</span> Cost <b style="color:#ffc94d">${spec.cost}</b>` +
      `<span class="sep">|</span> Click a tile to build · Esc to cancel`;
    this.info.classList.remove('hidden');
  }

  showMeteorInfo(): void {
    this.towerInfo.classList.add('hidden');
    this.info.innerHTML =
      `<b style="color:#ff7a3c">☄ Meteor Strike</b>` +
      `<span class="sep">|</span> Click the map to call it down · Esc to cancel`;
    this.info.classList.remove('hidden');
  }

  showTowerInfo(tower: Tower, refundMult = 1): void {
    const s = tower.spec;
    const refund = Math.floor(tower.invested * SELL_REFUND * refundMult);
    const up = tower.upgradePrice;
    const dpm = tower.damage * tower.fireRate * 60;
    const dpmpg = tower.invested > 0 ? dpm / tower.invested : 0;
    const row = (label: string, value: string, id?: string): string =>
      `<div class="ti-row"><span class="ti-label">${label}</span>` +
      `<span class="ti-value"${id ? ` id="${id}"` : ''}>${value}</span></div>`;
    this.towerInfo.innerHTML =
      `<div class="ti-header"><b style="color:${colorHex(s.color)}">${s.name}</b><span class="lv">Lv.${tower.level}</span></div>` +
      row('Damage', String(tower.damage)) +
      row('Range', tower.range.toFixed(1)) +
      row('Fire rate', `${tower.fireRate.toFixed(2)}/s`) +
      row('Kills', fmtNum(tower.kills), 'ti-kills') +
      `<div class="ti-divider"></div>` +
      row('DPM', fmtNum(dpm)) +
      row('Invested', fmtNum(tower.invested)) +
      row('DPM/gold', dpmpg.toFixed(2)) +
      `<div class="ti-actions">` +
      (up !== null
        ? `<button id="btn-upgrade" class="btn upgrade">Upgrade ${fmtNum(up)}g</button>`
        : tower.gatedAtLevel !== null
          ? `<button id="btn-upgrade" class="btn upgrade" disabled>Reach Lv.${tower.gatedAtLevel}</button>`
          : `<button id="btn-upgrade" class="btn upgrade" disabled>MAX</button>`) +
      `<button id="btn-sell" class="btn danger">Sell +${fmtNum(refund)}</button>` +
      `</div>`;
    this.info.classList.add('hidden');
    this.towerInfo.classList.remove('hidden');
  }

  /**
   * Patches just the Kills figure on an already-rendered tower-info panel —
   * used by the periodic HUD pulse instead of showTowerInfo(), so the
   * Upgrade/Sell buttons are never torn down and rebuilt under the cursor
   * (that caused a hover flicker: losing/reacquiring :hover every tick).
   */
  updateTowerKills(kills: number): void {
    const el = this.towerInfo.querySelector('#ti-kills');
    if (el) el.textContent = fmtNum(kills);
  }

  hideInfo(): void {
    this.info.classList.add('hidden');
    this.towerInfo.classList.add('hidden');
  }

  showOverlay(title: string, sub: string, button: string): void {
    this.overlayTitle.textContent = title;
    this.overlaySub.innerHTML = sub;
    byId('btn-overlay').textContent = button;
    this.overlay.classList.remove('hidden');
  }

  /** Game-over flow: show the initials prompt when the score makes the board. */
  showGameOver(title: string, sub: string, canEnterScore: boolean): void {
    this.showOverlay(title, sub, 'Play Again');
    this.scoresBox.classList.add('hidden');
    if (canEnterScore) {
      this.initialsEntry.classList.remove('hidden');
      this.initialsInput.value = '';
      // Focus after the overlay transition so the keyboard goes to the input.
      window.setTimeout(() => this.initialsInput.focus(), 50);
    } else {
      this.initialsEntry.classList.add('hidden');
    }
  }

  private submitInitials(): void {
    const initials = (this.initialsInput.value || 'AAA').padEnd(3, 'A').slice(0, 3);
    this.initialsEntry.classList.add('hidden');
    this.onSubmitScore(initials);
  }

  private scoreTableHtml(entries: ScoreEntry[], highlightIndex: number): string {
    const rows = entries.map((e, i) =>
      `<tr class="board-row${i === highlightIndex ? ' you' : ''}${e.stats ? ' clickable' : ''}" data-idx="${i}">` +
      `<td class="rank">${i + 1}.</td>` +
      `<td>${e.initials}</td>` +
      `<td class="score">${fmtNum(e.score, 2)}</td>` +
      `<td>L${e.level}</td>` +
      `</tr>`,
    ).join('');
    return `<table><tr><th>RANK</th><th>NAME</th><th>SCORE</th><th>LVL</th></tr>${rows}</table>` +
      `<p class="board-hint">Click a row to inspect that run's build.</p>`;
  }

  /** Wires row clicks within a board container to the build drill-in popup. */
  private bindBoardDrillIn(container: HTMLElement): void {
    container.querySelectorAll('.board-row.clickable').forEach((row) =>
      row.addEventListener('click', () => {
        const idx = Number((row as HTMLElement).dataset.idx);
        const entry = this.boardEntries[idx];
        if (entry) this.showStatPopup(entry);
      }),
    );
  }

  /** Renders the leaderboard table; highlightIndex marks the freshly added entry. */
  renderScores(entries: ScoreEntry[], highlightIndex: number): void {
    this.boardEntries = entries;
    this.scoresBox.innerHTML = this.scoreTableHtml(entries, highlightIndex);
    this.scoresBox.classList.remove('hidden');
    this.bindBoardDrillIn(this.scoresBox);
  }

  /** Build-stats drill-in: tower mix, economy, abilities, and the mutator path. */
  private showStatPopup(e: ScoreEntry): void {
    const s = e.stats;
    if (!s) return;
    const towerRows = Object.entries(s.towers).map(([id, t]) => {
      const spec = TOWER_TYPES.find((x) => x.id === id);
      return `<tr><td><span class="swatch" style="background:${spec ? colorHex(spec.color) : '#888'}"></span>` +
        `${spec?.name ?? id}</td><td class="num">×${t.count}</td><td>max Lv.${t.maxLevel}</td></tr>`;
    }).join('') || '<tr><td colspan="3">No towers built</td></tr>';

    const abilities = Object.entries(s.abilities)
      .map(([id, lv]) => `${ABILITIES.find((a) => a.id === id)?.name ?? id} Lv.${lv}`).join(', ') || 'none';

    const path = s.mutatorPath.length
      ? `<ol class="mutator-path">${s.mutatorPath.map((m) => `<li><b>L${m.level}</b> ${m.name}</li>`).join('')}</ol>`
      : (s.challenge ? `<p class="board-note">Challenge: <b>${s.challenge.name}</b></p>`
        : '<p class="fine">No mutators drafted.</p>');

    this.statPopupContent.innerHTML =
      `<h2>${e.initials} — ${fmtNum(e.score, 2)}</h2>` +
      `<p class="board-note">Reached Level ${e.level}, wave ${e.wave}` +
      `${e.kind === 'daily' ? ' · Daily' : ''}` +
      `${e.version ? ` <span class="version-tag">v${e.version}</span>` : ''}</p>` +
      `<h3>Mutator Path</h3>${path}` +
      `<h3>Towers</h3><table class="info-table"><tr><th>Tower</th><th>Built</th><th>Peak</th></tr>${towerRows}</table>` +
      `<h3>Run Summary</h3><ul class="controls-list">` +
      `<li>Enemies slain: <b>${fmtNum(s.enemiesKilled)}</b> · Bosses: <b>${s.bossesKilled}</b> (max ×${s.maxBossMult.toFixed(1)})</li>` +
      `<li>Gold earned: <b>${fmtNum(s.goldEarned)}</b> · spent: <b>${fmtNum(s.goldSpent)}</b></li>` +
      `<li>Abilities: ${abilities}</li>` +
      `</ul>`;
    this.statPopup.classList.remove('hidden');
  }

  // ---------------------------------------------------------------- mutators / draft

  /** Shows the arcade draft modal with 3 net-neutral options. */
  showDraft(level: number, options: DraftOption[]): void {
    byId('draft-title').textContent = `LEVEL ${level} — CHOOSE A MUTATOR`;
    this.draftCards.innerHTML = options.map((o) =>
      `<div class="draft-card" data-id="${o.id}">` +
      `<div class="draft-icon">${o.icon}</div>` +
      `<div class="draft-name">${o.name}</div>` +
      `<div class="draft-buff">▲ ${o.buff}</div>` +
      `<div class="draft-nerf">▼ ${o.nerf}</div>` +
      `</div>`,
    ).join('');
    this.draft.classList.remove('hidden');
  }

  hideDraft(): void {
    this.draft.classList.add('hidden');
  }

  /**
   * Renders the active-mutator strip below the top bar: the drafted/challenge
   * icons plus the net aggregate effect of everything currently stacked.
   */
  setRunSummary(list: { icon: string; name: string }[], effects: string[]): void {
    const chips = list
      .map((m) => `<span class="mut-chip" title="${m.name}">${m.icon} ${m.name}</span>`)
      .join('');
    const fx = effects
      .map((e) => {
        const title = e.endsWith('pierce')
          ? 'Armor Pierce subtracts directly from enemy armor before damage reduction is applied.'
          : '';
        return `<span class="mut-fx"${title ? ` title="${title}"` : ''}>${e}</span>`;
      })
      .join('');
    this.activeMutators.innerHTML = chips + (fx ? `<span class="mut-sep">→</span>${fx}` : '');
    this.activeMutators.classList.toggle('hidden', list.length === 0 && effects.length === 0);
  }

  setBossMult(mult: number): void {
    this.bossVal.innerHTML = `&times;${mult.toFixed(1)}`;
    this.bossWrap.classList.toggle('hidden', mult <= 1.0001);
  }

  /** Restricts the build palette to the given tower ids (null = all allowed). */
  setAllowedTowers(allowed: string[] | null): void {
    for (const [id, card] of this.cards) {
      card.classList.toggle('forbidden', !!allowed && !allowed.includes(id));
    }
  }

  setAbilitiesDisabled(disabled: boolean): void {
    this.abilitiesTitle.classList.toggle('hidden', disabled);
    this.abilitiesBox.classList.toggle('hidden', disabled);
  }

  hideOverlay(): void {
    this.overlay.classList.add('hidden');
    this.initialsEntry.classList.add('hidden');
    this.scoresBox.classList.add('hidden');
  }
}
