/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  async rewrites() {
    if (process.env.NODE_ENV === 'production') return [];
    return [{
      source: '/api/:path*',
      destination: `${process.env.API_INTERNAL_URL ?? 'http://localhost:3001'}/:path*`,
    }];
  },
};

export default nextConfig;
