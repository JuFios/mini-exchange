/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // Термінал не потребує серверної оптимізації зображень.
  images: { unoptimized: true },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
