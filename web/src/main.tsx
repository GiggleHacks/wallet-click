import '@fontsource-variable/noto-sans';
import './styles/win98.css';
import './styles/themes.css';
import './styles/features.css';
import './styles/dark.css';
import './styles/motion.css';
import { MotionConfig } from 'motion/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installClientLog } from './lib/devlog';
import { applyMotionAttr, installVisibility, useCalm } from './lib/motion';
import { primeAudio, setSoundTheme } from './lib/sound';
import { applyThemeAttr, savedTheme } from './lib/themes';
import { APP_VERSION } from './version';

const theme = savedTheme();
applyThemeAttr(theme);
applyMotionAttr();
installVisibility();
setSoundTheme(theme.id);
primeAudio();
installClientLog(APP_VERSION);

/** Animations follow the app's own Full / Calm setting (Start menu), not the computer's "reduce motion". */
function Root() {
  const calm = useCalm();
  return (
    <MotionConfig reducedMotion={calm ? 'always' : 'never'}>
      <App />
    </MotionConfig>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
