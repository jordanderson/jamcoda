import { ReactNode } from 'react'
import Sidebar from './Sidebar'

interface LayoutProps {
  children: ReactNode
  onStartSync: (full?: boolean) => Promise<void>
  isSyncStarting: boolean
}

export default function Layout({ children, onStartSync, isSyncStarting }: LayoutProps) {
  return (
    <div className="flex h-screen bg-gray-100">
      <Sidebar onStartSync={onStartSync} isSyncStarting={isSyncStarting} />
      <main className="flex-1 min-w-0 overflow-auto">
        {/* Timelines and the piano roll scale with the width they are given,
            so the cap is generous; it only stops text-heavy pages running on
            across a very wide display. */}
        <div className="mx-auto w-full max-w-[2400px] px-6 py-8">
          {children}
        </div>
      </main>
    </div>
  )
}
