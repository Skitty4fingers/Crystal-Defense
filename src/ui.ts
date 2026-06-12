import { ABILITIES, MAX_LEVEL, SELL_REFUND, TOWER_TYPES, WAVES_PER_LEVEL } from './config';
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
  affordable: boolean;
  cooldownLeft: number;
  usable: boolean; // wave running etc.
}

/** All DOM/HUD handling. The Game assigns the on* callbacks. */
export class UI {
  onSelectTower: (id: string) => void = () => {};
  onAbility: (id: string) => void = () => {};
  onWaveButton: () => void = () => {};
  onUpgradeAll: () => void = () => {};
  onPause: () => void = () => {};
  onSpeed: () => void = () => {};
  onMute: () => void = () => {};
  onRestart: () => void = () => {};
  onSubmitScore: (initials: string) => void = () => {};
  onSell: () => void = () => {};
  onUpgrade: () => void = () => {};

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
      row.className = 'ability-row';
      row.title = `${a.description}\nHotkey: ${a.key} · Cooldown ${a.cooldown}s`;
      row.innerHTML =
        `<div class="ability-icon" style="background:${a.color}">${a.icon}</div>` +
        `<div class="ability-text"><b>${a.name}</b><span>${a.manaCost} mana</span></div>` +
        `<span class="ability-cd"></span>`;
      row.addEventListener('click', () => this.onAbility(a.id));
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
      row.classList.toggle('disabled', !s.usable || !s.affordable || onCd);
      const cd = row.querySelector('.ability-cd') as HTMLElement;
      cd.textContent = onCd ? `${Math.ceil(s.cooldownLeft)}s` : '';
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

  /** Renders the top-10 table; highlightIndex marks the freshly added entry. */
  renderScores(entries: ScoreEntry[], highlightIndex: number): void {
    const rows = entries.map((e, i) =>
      `<tr${i === highlightIndex ? ' class="you"' : ''}>` +
      `<td class="rank">${i + 1}.</td>` +
      `<td>${e.initials}</td>` +
      `<td class="score">${e.score.toLocaleString()}</td>` +
      `<td>L${e.level}</td>` +
      `</tr>`,
    ).join('');
    this.scoresBox.innerHTML =
      `<table><tr><th>RANK</th><th>NAME</th><th>SCORE</th><th>LVL</th></tr>${rows}</table>`;
    this.scoresBox.classList.remove('hidden');
  }

  hideOverlay(): void {
    this.overlay.classList.add('hidden');
    this.initialsEntry.classList.add('hidden');
    this.scoresBox.classList.add('hidden');
  }
}
