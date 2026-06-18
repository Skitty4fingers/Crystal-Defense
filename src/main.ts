import './styles.css';
import { Game } from './game';
import { injectSpeedInsights } from '@vercel/speed-insights';
import { inject } from '@vercel/analytics';

injectSpeedInsights();
inject();

new Game(document.getElementById('app')!);
