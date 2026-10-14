import { motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { AppMark, KeyIcon } from '../components/art';
import { PasswordField, type PasswordFieldHandle } from '../components/PasswordField';
import { Window } from '../components/Win98';
import { getPref, setPref } from '../lib/prefs';
import { sfx } from '../lib/sound';
import { useTheme } from '../lib/themes';
import type { Status } from '../types';

/** "Remember this device": a long-lived sign-in that renews itself, so this browser isn't asked again. */
function RememberBox({ checked, onChange }: { checked: boolean; onChange(v: boolean): void }) {
  return (
    <label className="check98">
      <input type="checkbox" checked={checked} onChange={(e) => (sfx.tap(), onChange(e.target.checked))} />
      <span className="check98-box" aria-hidden="true" />
      <span className="check98-text">Remember this device (don't ask again)</span>
    </label>
  );
}

/** Lets password managers save the password: they look for a username field next to it. */
const UsernameForManagers = () => (
  <input className="sr-only" type="text" name="username" autoComplete="username" value="Wallet Click" readOnly tabIndex={-1} aria-hidden="true" />
);

function useNow(active: boolean, every: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(t);
  }, [active, every]);
  return now;
}

export function Lock({ status, onUnlocked }: { status: Status; onUnlocked(): void }) {
  const theme = useTheme();
  const field = useRef<PasswordFieldHandle>(null);
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(() => getPref('remember'));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [lockedUntil, setLockedUntil] = useState(() => (status.retryAfterMs ? Date.now() + status.retryAfterMs : 0));
  // Ticks while the lock screen is up: drives the lockout countdown and the sign-in clock.
  const now = useNow(true, 500);
  const clockNow = now;

  const locked = lockedUntil > now;

  async function submit() {
    if (!password || busy || locked) return;
    setBusy(true);
    try {
      await api.login(password, remember);
      setPref('remember', remember); // the box starts the same way next time
      sfx.unlock();
      onUnlocked();
    } catch (e) {
      field.current?.shake();
      setPassword('');
      const body = e instanceof ApiError ? e.body : {};
      if (typeof body.retryAfterMs === 'number' && body.retryAfterMs > 0) {
        setLockedUntil(Date.now() + body.retryAfterMs);
        setMessage('');
      } else if (typeof body.triesLeft === 'number') {
        setMessage(`Wrong password. ${body.triesLeft} ${body.triesLeft === 1 ? 'try' : 'tries'} left before a timeout.`);
      } else {
        setMessage(e instanceof Error ? e.message : 'Something went wrong');
      }
    } finally {
      setBusy(false);
    }
  }

  const prompt = locked ? `Too many tries. Locked for ${Math.ceil((lockedUntil - now) / 1000)}s.` : message;

  if (theme.shell !== 'classic') {
    // Windows 10/11: the full-screen sign-in over a blurred desktop.
    const d = new Date(clockNow);
    return (
      <div className={`signin signin-${theme.shell}`}>
        <div className="signin-clock" aria-hidden="true">
          <span>{d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
          <small>{d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</small>
        </div>
        <motion.form
          className="signin-card"
          onSubmit={(e) => (e.preventDefault(), void submit())}
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: 'easeOut' }}
        >
          <span className="signin-avatar">
            <AppMark size={72} />
          </span>
          <h1 className="signin-name">Wallet Click</h1>
          {!status.ready && <p className="signin-msg">The server has no password yet. Set APP_PASSWORD in its .env.</p>}
          <UsernameForManagers />
          <div className="signin-row">
            <PasswordField ref={field} value={password} onChange={setPassword} onSubmit={() => void submit()} autoFocus disabled={locked} />
            <button type="submit" className="signin-go" disabled={busy || locked || !password} aria-label="Sign in">
              {busy ? '…' : '→'}
            </button>
          </div>
          <p className="signin-msg" role="status">
            {prompt || 'Password'}
          </p>
          <RememberBox checked={remember} onChange={setRemember} />
        </motion.form>
      </div>
    );
  }

  return (
    <Window title="Welcome to Wallet Click" className="win-login">
      <form className="login" onSubmit={(e) => (e.preventDefault(), void submit())}>
        <KeyIcon size={44} />
        <div className="login-main">
          <p role="status">{prompt || 'Type your password to log on.'}</p>
          {!status.ready && <p className="error-text">The server has no password yet. Set APP_PASSWORD in its .env.</p>}
          <UsernameForManagers />
          <PasswordField ref={field} value={password} onChange={setPassword} onSubmit={() => void submit()} label="Password:" autoFocus disabled={locked} />
          <RememberBox checked={remember} onChange={setRemember} />
          <div className="btn-row">
            <button type="submit" className="btn98 is-default" disabled={busy || locked || !password}>
              {busy ? 'Checking…' : 'OK'}
            </button>
          </div>
        </div>
      </form>
    </Window>
  );
}
