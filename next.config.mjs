/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: false,
  },
  images: {
    unoptimized: true,
  },
  // Disable source maps in production to prevent JSON parse errors from .map files
  productionBrowserSourceMaps: false,
  
  // Enable deprecation tracing for debugging Buffer() deprecation warning
  // This will show full stack traces in logs, revealing the exact source of the warning
  webpack: (config, { isServer }) => {
    if (isServer) {
      // Add deprecation tracing node options
      process.env.NODE_OPTIONS = (process.env.NODE_OPTIONS || '') + ' --trace-deprecation'
    }
    return config
  },
  
  async headers() {
    return [
      {
        source: '/.well-known/:path*',
        headers: [
          {
            key: 'Content-Type',
            value: 'text/plain',
          },
          {
            key: 'Cache-Control',
            value: 'no-cache',
          },
        ],
      },
    ]
  },
}

export default nextConfig
