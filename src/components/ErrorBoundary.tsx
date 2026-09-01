import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, Home, RotateCcw } from 'lucide-react'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

/**
 * Catches unhandled render/lifecycle errors anywhere in the app and replaces
 * the tree with a generic error view instead of a blank or broken screen.
 *
 * Per-component pages already surface their own loading/error states for
 * fetch failures. This boundary handles the cases that slip through, such as
 * a render-time exception. It does not catch errors in event handlers, async
 * callbacks, or the boundary's own render.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Unhandled render error:', error, info.componentStack)
  }

  private handleReset = (): void => {
    // Clear the error so the subtree renders again. Hash routing re-renders
    // whatever the current route is. Navigating to browse first means a
    // route-specific crash leaves the user with a usable screen.
    window.location.hash = '/browse'
    this.setState({ error: null })
  }

  render() {
    if (this.state.error === null) {
      return this.props.children
    }

    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-6">
        <div className="max-w-lg w-full bg-white rounded-xl shadow-sm border border-red-200 p-8 text-center">
          <AlertTriangle className="w-10 h-10 text-red-600 mx-auto mb-4" />
          <h1 className="text-xl font-bold text-gray-900">Something went wrong</h1>
          <p className="mt-2 text-sm text-gray-600">
            An unexpected error occurred while rendering this page. Your data is safe.
          </p>

          <details className="mt-4 text-left">
            <summary className="cursor-pointer text-xs text-gray-500 select-none">
              Error details
            </summary>
            <pre className="mt-2 p-3 bg-gray-100 rounded text-xs text-red-700 overflow-x-auto whitespace-pre-wrap">
              {this.state.error.message}
              {this.state.error.stack ? `\n\n${this.state.error.stack}` : ''}
            </pre>
          </details>

          <div className="mt-6 flex justify-center gap-3">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Reload
            </button>
            <button
              type="button"
              onClick={this.handleReset}
              className="inline-flex items-center gap-1.5 rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200"
            >
              <Home className="w-3.5 h-3.5" />
              Back to library
            </button>
          </div>
        </div>
      </div>
    )
  }
}