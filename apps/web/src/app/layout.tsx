import type { Metadata } from 'next'
import './globals.css'
import AppShell from '@/components/app-shell'

export const metadata: Metadata = {
  title: 'L Harness',
  description: 'L Harness 管理画面',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL
  let apiOrigin: string | null = null
  try {
    apiOrigin = apiUrl ? new URL(apiUrl).origin : null
  } catch {
    apiOrigin = null
  }

  return (
    <html lang="ja">
      <head>
        {apiOrigin && <link rel="preconnect" href={apiOrigin} crossOrigin="use-credentials" />}
        {apiOrigin && <link rel="dns-prefetch" href={apiOrigin} />}
        <link rel="preconnect" href="https://sprofile.line-scdn.net" />
        <link rel="dns-prefetch" href="https://sprofile.line-scdn.net" />
      </head>
      <body className="bg-gray-50 text-gray-900 antialiased" style={{ fontFamily: "'Noto Sans JP', 'Hiragino Sans', 'Yu Gothic', system-ui, sans-serif" }}>
        <AppShell>
          {children}
        </AppShell>
      </body>
    </html>
  )
}
