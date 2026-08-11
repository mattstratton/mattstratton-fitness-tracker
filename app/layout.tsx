import type { ReactNode } from 'react'
import './globals.css'

export const metadata = { title: 'fitness', description: 'Personal training and nutrition data' }
export const viewport = { width: 'device-width', initialScale: 1 }

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header>
          <h1>fitness</h1>
          <nav>
            <a href="/">today</a>
            <a href="/coach">coach</a>
            <a href="/ask">ask</a>
            <a href="/workouts">workouts</a>
            <a href="/trends">trends</a>
            <a href="/settings">settings</a>
          </nav>
        </header>
        {children}
      </body>
    </html>
  )
}
