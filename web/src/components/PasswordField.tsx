import { useAnimate } from 'motion/react';
import { useImperativeHandle, useState, type Ref } from 'react';
import { sfx } from '../lib/sound';

export interface PasswordFieldHandle {
  shake(): void;
  clear(): void;
}

interface Props {
  value: string;
  onChange(v: string): void;
  onSubmit?(): void;
  label?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  ref?: Ref<PasswordFieldHandle>;
}

/** Plain password input: pasting is allowed, with a show/hide toggle. */
export function PasswordField({ value, onChange, onSubmit, label, autoFocus, disabled, ref }: Props) {
  const [shown, setShown] = useState(false);
  const [scope, animate] = useAnimate();

  useImperativeHandle(ref, () => ({
    shake() {
      sfx.error();
      void animate(scope.current, { x: [0, -10, 8, -6, 4, -2, 0] }, { duration: 0.4 });
    },
    clear: () => onChange(''),
  }));

  return (
    <label className="field">
      {label && <span className="lbl">{label}</span>}
      <div ref={scope} className="pw-box">
        <input
          className="input98 pw-input"
          aria-label={label ? undefined : 'Password'}
          type={shown ? 'text' : 'password'}
          value={value}
          autoFocus={autoFocus}
          disabled={disabled}
          autoComplete="current-password"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && onSubmit) {
              e.preventDefault();
              onSubmit();
            }
          }}
        />
        <button type="button" className="btn98 pw-toggle" onClick={() => (setShown((s) => !s), sfx.tap())} aria-label={shown ? 'Hide password' : 'Show password'} tabIndex={-1}>
          {shown ? 'Hide' : 'Show'}
        </button>
      </div>
    </label>
  );
}
