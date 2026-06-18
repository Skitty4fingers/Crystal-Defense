import {
  ABILITIES, ABILITY_MAX_LEVEL, ENEMY_TYPES, MAX_LEVEL, SELL_REFUND, TOWER_TYPES, WAVES_PER_LEVEL,
} from './config';
import type { TowerSpec } from './config';
import type { Tower } from './tower';
import type { ScoreEntry } from './leaderboard';

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
  onRestart: () => void = () => {};
  onSubmitScore: (initials: string) => void = () => {};
  onSell: () => void = () => {};
  onUpgrade: () => void = () => {};
  onStart: () => void = () => {};
  onShowLeaderboard: () => void = () => {};

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

  private cards = new Map<string, HTMLElement>();
  private abilityRows = new Map<string, HTMLElement>();
  private bannerTimer = 0;

  constructor() {
    this.buildPalette();
    this.buildAbilities();
    this.btnWave.addEventListener('click', () => this.onWaveButton());
    this.btnUpgradeAll.addEventListener('click', () => this.onUpgradeAll());
    this.btnPause.addEventListener('click', () => this.onPause());
    this.btnSpeed.addEventListener('click', () => this.onSpeed());
    this.btnMute.addEventListener('click', () => this.onMute());
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
    byId('btn-start').addEventListener('click', () => {
      this.splash.classList.add('hidden');
      this.onStart();
    });
    byId('btn-instructions').addEventListener('click', () => this.showInstructions());
    byId('btn-leaderboard').addEventListener('click', () => {
      this.showSplashPanel('<p class="splash-loading">Loading leaderboard&hellip;</p>');
      this.onShowLeaderboard();
    });
    byId('btn-splash-back').addEventListener('click', () => this.showSplashMenu());
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

  /** Renders the fetched shared leaderboard into the splash panel. */
  showSplashLeaderboard(entries: ScoreEntry[]): void {
    const body = entries.length
      ? this.scoreTableHtml(entries, -1)
      : '<p class="splash-loading">No scores yet — be the first!</p>';
    this.showSplashPanel(`<h2>Leaderboard</h2>${body}`);
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

    const abilityRows = ABILITIES.map((a) =>
      `<li><b style="color:${a.color}">${a.icon} ${a.name}</b> — ${a.description}</li>`,
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
      `<p>Abilities start <b>locked</b> — buy them with gold, then upgrade up to ` +
      `Lv.${ABILITY_MAX_LEVEL}. Casting costs mana and triggers a cooldown.</p>` +
      `<ul class="ability-list">${abilityRows}</ul>` +

      `<h3>Controls</h3>` +
      `<ul class="controls-list">` +
      `<li><b>1&ndash;6</b> select a tower to build · click a tile to place</li>` +
      `<li><b>Q / W / E</b> cast Meteor / Heal / Frenzy</li>` +
      `<li><b>Space</b> start the next wave · <b>Esc</b> cancel placement</li>` +
      `<li><b>M</b> toggle sound · click a tower to upgrade or sell</li>` +
      `<li><b>Right-drag</b> rotate · <b>Middle-drag</b> pan · <b>Scroll</b> zoom</li>` +
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
    this.statGold.textContent = String(gold);
    this.statLives.textContent = String(lives);
    this.statMana.textContent = String(Math.floor(mana));
    this.statScore.textContent = String(score);
    this.statLevel.textContent = String(level);
    this.statWave.textContent = `${wave} / ${WAVES_PER_LEVEL}`;
    for (const spec of TOWER_TYPES) {
      this.cards.get(spec.id)!.classList.toggle('disabled', spec.cost > gold);
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

  /** Brief full-screen white flash — used for the crystal-death blast. */
  flashScreen(): void {
    const flash = byId('flash');
    flash.classList.remove('flash-anim');
    void flash.offsetWidth; // force reflow so the animation restarts
    flash.classList.add('flash-anim');
  }

  showBanner(text: string, kind: 'normal' | 'boss' = 'normal'): void {
    this.banner.textContent = text;
    this.banner.classList.toggle('boss', kind === 'boss');
    this.banner.classList.remove('hidden');
    window.clearTimeout(this.bannerTimer);
    this.bannerTimer = window.setTimeout(() => this.banner.classList.add('hidden'), 2300);
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

  showTowerInfo(tower: Tower): void {
    const s = tower.spec;
    const refund = Math.floor(tower.invested * SELL_REFUND);
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
      `<tr${i === highlightIndex ? ' class="you"' : ''}>` +
      `<td class="rank">${i + 1}.</td>` +
      `<td>${e.initials}</td>` +
      `<td class="score">${e.score.toLocaleString()}</td>` +
      `<td>L${e.level}</td>` +
      `</tr>`,
    ).join('');
    return `<table><tr><th>RANK</th><th>NAME</th><th>SCORE</th><th>LVL</th></tr>${rows}</table>`;
  }

  /** Renders the leaderboard table; highlightIndex marks the freshly added entry. */
  renderScores(entries: ScoreEntry[], highlightIndex: number): void {
    this.scoresBox.innerHTML = this.scoreTableHtml(entries, highlightIndex);
    this.scoresBox.classList.remove('hidden');
  }

  hideOverlay(): void {
    this.overlay.classList.add('hidden');
    this.initialsEntry.classList.add('hidden');
    this.scoresBox.classList.add('hidden');
  }
}
