/** Privacy Enhanced: how long the Monero waits before the second swap. A slider with a stop per choice. */
export function DelaySlider({ value, delays, onChange, disabled }: { value: number; delays: number[]; onChange(h: number): void; disabled?: boolean }) {
  const i = Math.max(0, delays.indexOf(value));
  return (
    <div className="delay98">
      <input
        type="range"
        className="delay-range"
        min={0}
        max={delays.length - 1}
        step={1}
        value={i}
        disabled={disabled}
        onChange={(e) => onChange(delays[Number(e.target.value)])}
        aria-label="Wait before the second swap"
        aria-valuetext={`${value} hours`}
      />
      <div className="delay-ticks">
        {delays.map((d, n) => (
          <button
            key={d}
            type="button"
            className={`delay-tick ${d === value ? 'is-on' : ''}`}
            style={{ left: `calc(8px + (100% - 16px) * ${n / Math.max(1, delays.length - 1)})` }}
            onClick={() => onChange(d)}
            disabled={disabled}
          >
            {d} h
          </button>
        ))}
      </div>
    </div>
  );
}

/** "3 h 12 min", "12 min", "less than a minute". */
export function untilText(ms: number): string {
  const min = Math.ceil(ms / 60_000);
  if (min <= 1) return 'less than a minute';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`;
}
