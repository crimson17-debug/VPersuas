'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/batch', label: 'Batch run' },
  { href: '/incidents', label: 'Incidents' },
  { href: '/incrementality', label: 'Incrementality' },
  { href: '/ledger', label: 'Evidence ledger' },
  { href: '/evaluation', label: 'Evaluation' },
  { href: '/network', label: 'Rail network' },
];

export function Nav() {
  const path = usePathname();
  return (
    <nav className="nav">
      {LINKS.map((l, i) => {
        const active = path.startsWith(l.href);
        return (
          <Link
            key={l.href}
            href={l.href}
            className="nav-item"
            {...(active ? { 'aria-current': 'page' as const } : {})}
          >
            <span className="nav-num">{i + 1}</span>
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
