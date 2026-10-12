import type { NextConfig } from 'next'
import path from 'path'

const nextConfig: NextConfig = {
  output: 'standalone',
  // Carbon Design System requires transpilation in Next.js
  transpilePackages: ['@carbon/react', '@carbon/icons-react', 'carbon-components'],
  serverExternalPackages: ['busboy'],
  experimental: {
    serverActions: {
      // The dispatch server action receives the staged file list (one entry per
      // file). The 1 MB default is exceeded at roughly 5 000 files.
      bodySizeLimit: '50mb',
    },
  },
  // Resolve Carbon's ~@ibm/plex tilde imports in SCSS (Turbopack + Webpack)
  sassOptions: {
    includePaths: [path.join(process.cwd(), 'node_modules')],
  },
}

export default nextConfig
