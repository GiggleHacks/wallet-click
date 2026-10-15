import '@fontsource-variable/noto-sans';
import './styles/win98.css';
import './styles/themes.css';
import './styles/features.css';
import './styles/dark.css';
import { MotionConfig } from 'motion/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installClientLog } from './lib/devlog';
import { primeAudio, setSoundTheme } from './lib/sound';
import { applyThemeAttr, savedTheme } from './lib/themes';
import { APP_VERSION } from './version';

const theme = savedTheme();
applyThemeAttr(theme);
setSoundTheme(theme.id);
primeAudio();
installClientLog(APP_VERSION);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Honour the system "reduce motion" setting. */}
    <MotionConfig reducedMotion="user">
      <App />
    </MotionConfig>
  </StrictMode>,
);
