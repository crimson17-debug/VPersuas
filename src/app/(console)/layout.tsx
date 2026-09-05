import Link from 'next/link';
import type { ReactNode } from 'react';

import { Nav } from '../nav.js';
import { ProvenanceBadge } from '../provenance.js';
import { ThemeToggle } from '../theme-toggle.js';

/** The console shell. The landing page deliberately does not use it. */
export default function ConsoleLayout({ children }: { children: ReactNode }) {
  return (
    <div className="shell">
      <aside className="sidebar">
        <Link href="/" className="brand">
          <div className="brand-mark">
            <span className="brand-glyph" aria-hidden="true" />
            Persuas
          </div>
          <div className="brand-tag">
            revenue recovery that only
            <br />
            counts what it caused
          </div>
        </Link>

        <Nav />

        <div className="rail-label">Source</div>
        <ProvenanceBadge />

        <div className="rail-foot">
          <div className="rail-label" style={{ padding: '0 0 9px' }}>
            Theme
          </div>
          <ThemeToggle />
        </div>
      </aside>

      <main className="main">
        <div className="main-inner">{children}</div>
      </main>
    </div>
  );
}
