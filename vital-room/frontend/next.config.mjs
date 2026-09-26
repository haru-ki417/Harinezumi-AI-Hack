import { PHASE_DEVELOPMENT_SERVER } from 'next/constants.js';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  typescript: { tsconfigPath: process.env.NEXT_TYPESCRIPT_CONFIG || 'tsconfig.json' },
  async rewrites() {
    const backend = (process.env.BACKEND_INTERNAL_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
    return [
      { source: '/api/hiring/:path*', destination: `${backend}/api/hiring/:path*` },
      { source: '/ws/hiring/:path*', destination: `${backend}/ws/hiring/:path*` },
      { source: '/api/health', destination: `${backend}/health` },
    ];
  },
};

export default (phase) => ({
  ...nextConfig,
  // Development must never overwrite the files served by a production server.
  distDir: process.env.NEXT_DIST_DIR || (phase === PHASE_DEVELOPMENT_SERVER ? '.next-dev' : '.next'),
});
