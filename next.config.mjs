/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,

  /**
   * The engine is plain Node ESM and imports its own modules with explicit
   * `.js` extensions, which is what lets `npm run eval`, `npm run batch`
   * and the test runner execute it directly with no bundler at all.
   * Teaching the bundler to resolve those to their TypeScript sources keeps
   * one copy of the engine serving both worlds — the alternative is either
   * dropping the extensions and breaking the CLI, or maintaining a build
   * step nobody wants to debug at 2am.
   */
  webpack: (config) => {
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
      '.jsx': ['.tsx', '.jsx'],
    };
    return config;
  },

  /**
   * The ledger is read from .data/ at request time. Next's file tracing
   * only bundles files it can see being imported, and a path built at
   * runtime is invisible to it — so on a serverless deploy the functions
   * would ship without the data and every screen would render its empty
   * state. `npm run prebuild` generates .data before the build; this
   * includes it in the deployment.
   *
   * This is the seam that should become a real database. The file store
   * is honest for a local run and for a read-only demo deploy, and it is
   * the wrong answer the moment two instances need to see each other's
   * writes.
   */
  outputFileTracingIncludes: {
    '/**': ['./.data/**'],
  },

  turbopack: {
    resolveExtensions: ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.json'],
  },
};
