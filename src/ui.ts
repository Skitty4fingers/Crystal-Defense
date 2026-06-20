import {
  ABILITIES, ABILITY_MAX_LEVEL, ENEMY_TYPES, MAX_LEVEL, SELL_REFUND, TOWER_TYPES, WAVES_PER_LEVEL,
  abilityCooldown, abilityUpgradeCost, frenzyMult, healAmount, meteorDamage,
} from './config';
import type { TowerSpec } from './config';
import { DAILY_CHALLENGES } from './mutators';
import type { Tower } from './tower';
import type { RunKind, ScoreEntry } from './leaderboard';

/** Daily challenge type shown by default in the leaderboard (today's rotation). */
const todayChallengeIndex = (): number =>
  Math.floor(Date.now() / 86_400_000) % DAILY_CHALLENGES.length;

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

function colorHex(c: number): string {
  return `#${c.toString(16).padStart(6, '0')}`;
}

export interface AbilityState {
  id: string;
  level: number;
  maxLevel: number;
  unlocked: boolean;
  unlockCost: number;
  upgradeCost: number | null;
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
  private abilitiesTitle = document.querySelector('.abilities-title') as HTMLElement;
  private bossWrap = byId('stat-boss-wrap');
  private bossVal = byId('stat-boss');
  private activeMutators = byId('active-mutators');
  private draft = byId('draft');
  private draftCards = byId('draft-cards');
  private statPopup = byId('stat-popup');
  private statPopupContent = byId('stat-popup-content');

  private cards = new Map<string, HTMLElement>();
  private abilityRows = new Map<string, HTMLElement>();
  private bannerTimer = 0;
  /** Entries currently shown in a board, for drill-in lookups. */
  private boardEntries: ScoreEntry[] = [];
  private boardKind: RunKind = 'arcade';
  private boardChallenge: number | null = null;

  constructor() {
    this.buildPalette();
    this.buildAbilities();
    this.btnWave.addEventListener('click', () => this.onWaveButton());
    this.btnUpgradeAll.addEventListener('click', () => this.onUpgradeAll());
    this.btnPause.addEventListener('click', () => this.onPause());
    this.btnSpeed.addEventListener('click', () => this.onSpeed());
    this.btnMute.addEventListener('click', () => this.onMute());
    this.btnMusic.addEventListener('click', () => this.onMusicToggle());
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
    // Sell/upgrade buttons are recreated when the info panel re-renders, so delegate.
    this.info.addEventListener('click', (e) => {
      const id = (e.target as HTMLElement).id;
      if (id === 'btn-sell') this.onSell();
      if (id === 'btn-upgrade') this.onUpgrade();
    });

    // Splash / front-door menu.
    byId('btn-start').addEventListener('click', () => this.startRun('arcade'));
    byId('btn-daily').addEventListener('click', () => this.startRun('daily'));
    byId('btn-instructions').addEventListener('click', () => this.showInstructions());
    byId('btn-leaderboard').addEventListener('click', () => this.openSplashBoard('arcade', null));
    byId('btn-splash-back').addEventListener('click', () => this.showSplashMenu());

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

  /** Re-opens the splash screen (used by a future menu button if needed). */
  showSplash(): void {
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

  /** Builds the How-to-Play content from the live config so it never drifts. */
  private instructionsHtml(): string {
    const towerRows = TOWER_TYPES.map((t) =>
      `<tr>` +
      `<td><span class="swatch" style="background:${colorHex(t.color)}"></span>${t.name}</td>` +
      `<td class="num">${t.cost}g</td>` +
      `<td>${t.role ?? ''}</td>` +
      `<td class="weak">${t.weakness ?? ''}</td>` +
      `</tr>`,
    ).join('');

    const enemyRows = Object.values(ENEMY_TYPES).map((e) =>
      `<tr>` +
      `<td><span class="swatch" style="background:${colorHex(e.color)}"></span>${e.name}</td>` +
      `<td>${e.trait ?? ''}</td>` +
      `<td>${e.counter ?? ''}</td>` +
      `</tr>`,
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

    const draftRows = `<li><b>Level 3 onward:</b> every level you <b>draft 1 of 3</b> mutators.</li>` +
      `<li>Each has <b>one buff and one nerf</b> (e.g. Glass Cannon: +100% damage / −5 lives), so they stay net-neutral and the leaderboard stays fair.</li>` +
      `<li>Picks <b>stack and compound</b> for the rest of the run — your build path is part of your score.</li>`;

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
      `<tr><th>Tower</th><th>Cost</th><th>Strength</th><th>Weakness</th></tr>${towerRows}</table>` +
      `<p class="fine">Click a built tower to upgrade it (up to Lv.${MAX_LEVEL}) or sell it.</p>` +

      `<h3>Enemies</h3>` +
      `<table class="info-table">` +
      `<tr><th>Enemy</th><th>Trait</th><th>Counter</th></tr>${enemyRows}</table>` +

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
      `<ul class="controls-list">${draftRows}</ul>` +

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
      `<li><b>M</b> toggle sound · click a tower to upgrade or sell</li>` +
      `<li><b>Right-drag</b> rotate · <b>Middle-drag</b> pan · <b>Scroll</b> zoom</li>` +
      `<li><b>Restart</b> returns to the menu to pick a mode.</li>` +
      `</ul>`
    );
  }

  private buildPalette(): void {
    TOWER_TYPES.forEach((spec, i) => {
      const card = document.createElement('div');
      card.className = 'tower-card';
      card.title =
        `${spec.description}\n` +
        `Damage ${spec.damage} · Range ${spec.range} · ${spec.fireRate}/s` +
        (spec.splashRadius ? ` · Splash ${spec.splashRadius}` : '') +
        (spec.slowFactor ? ` · Slows to ${spec.slowFactor * 100}%` : '');
      card.innerHTML =
        `<span class="tower-key">${i + 1}</span>` +
        `<div class="tower-icon" style="background:${colorHex(spec.color)}"></div>` +
        `<div class="tower-name">${spec.name}</div>` +
        `<div class="tower-cost">&#9679; ${spec.cost}</div>`;
      card.addEventListener('click', () => this.onSelectTower(spec.id));
      this.palette.appendChild(card);
      this.cards.set(spec.id, card);
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
    this.statGold.textContent = wholeGold.toLocaleString();
    this.statLives.textContent = String(lives);
    this.statMana.textContent = String(Math.floor(mana));
    this.statScore.textContent = Math.floor(score).toLocaleString();
    this.statLevel.textContent = String(level);
    this.statWave.textContent = `${wave} / ${WAVES_PER_LEVEL}`;
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
        btn.textContent = `Unlock ${s.unlockCost}g`;
        btn.className = 'ability-action btn buy';
        btn.disabled = !s.affordableUnlock;
      } else if (s.upgradeCost !== null) {
        btn.textContent = `▲ ${s.upgradeCost}g`;
        btn.className = 'ability-action btn upgrade';
        btn.disabled = !s.affordableUpgrade;
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
    window.clearTimeout(this.bannerTimer);
    this.bannerTimer = window.setTimeout(() => this.banner.classList.add('hidden'), seconds * 1000);
  }

  showPlacingInfo(spec: TowerSpec): void {
    this.info.innerHTML =
      `<b style="color:${colorHex(spec.color)}">${spec.name} Tower</b>` +
      `<span class="sep">|</span> Cost <b style="color:#ffc94d">${spec.cost}</b>` +
      `<span class="sep">|</span> Click a tile to build · Esc to cancel`;
    this.info.classList.remove('hidden');
  }

  showMeteorInfo(): void {
    this.info.innerHTML =
      `<b style="color:#ff7a3c">☄ Meteor Strike</b>` +
      `<span class="sep">|</span> Click the map to call it down · Esc to cancel`;
    this.info.classList.remove('hidden');
  }

  showTowerInfo(tower: Tower, refundMult = 1): void {
    const s = tower.spec;
    const refund = Math.floor(tower.invested * SELL_REFUND * refundMult);
    const up = tower.upgradePrice;
    this.info.innerHTML =
      `<b style="color:${colorHex(s.color)}">${s.name} <span class="lv">Lv.${tower.level}</span></b>` +
      `<span class="sep">|</span> DMG ${tower.damage}` +
      `<span class="sep">|</span> RNG ${tower.range.toFixed(1)}` +
      `<span class="sep">|</span> ${tower.fireRate.toFixed(2)}/s` +
      `<span class="sep">|</span> Kills ${tower.kills}` +
      (up !== null
        ? `<button id="btn-upgrade" class="btn upgrade">Upgrade ${up}g</button>`
        : `<span class="maxed">MAX Lv.${MAX_LEVEL}</span>`) +
      `<button id="btn-sell" class="btn danger">Sell +${refund}</button>`;
    this.info.classList.remove('hidden');
  }

  hideInfo(): void {
    this.info.classList.add('hidden');
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
      `<td class="score">${e.score.toLocaleString()}</td>` +
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
      `<h2>${e.initials} — ${e.score.toLocaleString()}</h2>` +
      `<p class="board-note">Reached Level ${e.level}, wave ${e.wave}` +
      `${e.kind === 'daily' ? ' · Daily' : ''}</p>` +
      `<h3>Mutator Path</h3>${path}` +
      `<h3>Towers</h3><table class="info-table"><tr><th>Tower</th><th>Built</th><th>Peak</th></tr>${towerRows}</table>` +
      `<h3>Run Summary</h3><ul class="controls-list">` +
      `<li>Enemies slain: <b>${s.enemiesKilled.toLocaleString()}</b> · Bosses: <b>${s.bossesKilled}</b> (max ×${s.maxBossMult.toFixed(1)})</li>` +
      `<li>Gold earned: <b>${s.goldEarned.toLocaleString()}</b> · spent: <b>${s.goldSpent.toLocaleString()}</b></li>` +
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
      .map((e) => `<span class="mut-fx">${e}</span>`)
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
