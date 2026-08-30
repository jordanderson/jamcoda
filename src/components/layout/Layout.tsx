import { ReactNode } from 'react'
import Sidebar from './Sidebar'

interface LayoutProps {
  children: ReactNode
  onStartSync: (full?: boolean) => void
  isSyncStarting: boolean
}

export default function Layout({ children, onStartSync, isSyncStarting }: LayoutProps) {
  return (
    <div className="flex h-screen bg-gray-100">
      <Sidebar onStartSync={onStartSync} isSyncStarting={isSyncStarting} />
      <main className="flex-1 overflow-auto">
        <div className="container mx-auto p-8">
          {children}
        </div>
      </main>
    </div>
  )
}
