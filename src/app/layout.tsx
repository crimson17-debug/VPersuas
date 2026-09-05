import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';
import { themeBootstrap } from './theme-toggle.js';

export const metadata: Metadata = {
  title: 'Persuas — revenue recovery that only counts what it caused',
  description:
    'An agent that finds at-risk revenue, decides whether intervening is worth it at all, ' +
    'acts through Razorpay, and measures how much of the recovery it actually caused.',
};

/**
 * Root layout: document, fonts, theme. No chrome.
 *
 * The console shell lives in the (console) route group so the landing page
 * can own the full viewport without a sidebar cutting into it.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/*
          Loaded by stylesheet link rather than next/font: next/font fetches
          at BUILD time, which fails on any machine without network access to
          Google, and a build that only works online fails at the worst
          possible moment. Every stack in globals.css degrades to a real
          fallback if the request never lands.
        */}
        <link
          rel="stylesheet"
          href={
            'https://fonts.googleapis.com/css2?' +
            'family=IBM+Plex+Mono:wght@400;500;600&' +
            'family=IBM+Plex+Serif:ital,wght@0,400;0,600;1,400&' +
            'family=Outfit:wght@400;500;600;700&display=swap'
          }
        />
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
