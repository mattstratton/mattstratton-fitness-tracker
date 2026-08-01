import type { ReactNode } from 'react'

export const metadata = {
  title: 'fitness',
  description: 'Personal training and nutrition data',
}

// Mobile first, deliberately: the question gets asked in the garage between
// sets, and the laptop is the fallback rather than the target.
export const viewport = { width: 'device-width', initialScale: 1 }

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
