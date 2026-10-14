import '@fontsource-variable/noto-sans';
import './styles/win98.css';
import './styles/themes.css';
import { MotionConfig } from 'motion/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { primeAudio, setSoundTheme } from './lib/sound';
import { applyThemeAttr, savedTheme } from './lib/themes';

const theme = savedTheme();
applyThemeAttr(theme);
setSoundTheme(theme.id);
primeAudio();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Honour the system "reduce motion" setting. */}
    <MotionConfig reducedMotion="user">
      <App />
    </MotionConfig>
  </StrictMode>,
);
