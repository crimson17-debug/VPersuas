'use client';

import { useEffect, useState } from 'react';

type Mode = 'light' | 'dark' | 'system';

/**
 * Theme control.
 *
 * "System" is a real third state, not a default that resolves to one of
 * the other two: it removes the attribute entirely so the CSS media query
 * takes over. Persisted per viewer in localStorage, which is exactly the
 * kind of lightweight per-browser convenience that storage is for.
 */
export function ThemeToggle() {
  const [mode, setMode] = useState<Mode>('system');

  useEffect(() => {
    try {
      const saved = localStorage.getItem('theme') as Mode | null;
      if (saved === 'light' || saved === 'dark') setMode(saved);
    } catch {
      // Private windows and blocked site data both throw here. The page
      // works fine on the system default.
    }
  }, []);

  const apply = (next: Mode) => {
    setMode(next);
    const root = document.documentElement;
    if (next === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', next);
    try {
      if (next === 'system') localStorage.removeItem('theme');
      else localStorage.setItem('theme', next);
    } catch {
      // Non-fatal; the choice simply will not survive a reload.
    }
  };

  return (
    <div className="theme-toggle" role="group" aria-label="Colour theme">
      {(['light', 'system', 'dark'] as const).map((m) => (
        <button
          key={m}
          type="button"
          className="btn"
          aria-pressed={mode === m}
          onClick={() => apply(m)}
        >
          {m === 'system' ? 'auto' : m}
        </button>
      ))}
    </div>
  );
}

/**
 * Applies the stored theme before first paint.
 *
 * Without this the page renders in the system theme and then snaps to the
 * stored one, which is the flash every themed site gets wrong.
 */
export const themeBootstrap = `
try {
  var t = localStorage.getItem('theme');
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
} catch (e) {}
`;
