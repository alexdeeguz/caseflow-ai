import type { NextConfig } from 'next';
const config: NextConfig = {
  async headers() {
    return [
      {
        source: '/auth/callback',
        headers: [
          { key: 'Cache-Control', value: 'no-store' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
    ];
  },
};
export default config;
