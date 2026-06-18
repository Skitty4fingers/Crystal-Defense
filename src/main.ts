import './styles.css';
import { Game } from './game';
import { injectSpeedInsights } from '@vercel/speed-insights';

injectSpeedInsights();

new Game(document.getElementById('app')!);
