import type { Metadata, Viewport } from 'next'
import './globals.scss'

export const metadata: Metadata = {
  title: 'Fleets Dispatcher — IBM Code Engine',
  description: 'Dispatch batch workloads to IBM Cloud Serverless Fleets',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
