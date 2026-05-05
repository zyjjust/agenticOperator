import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  serverExternalPackages: ['minio', 'pdf-parse'],
};

export default nextConfig;
