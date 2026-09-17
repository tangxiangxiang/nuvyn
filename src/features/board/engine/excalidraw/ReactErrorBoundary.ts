import * as React from 'react'

interface BoardReactErrorBoundaryProps {
  children?: React.ReactNode
  onError?: (error: unknown) => void
}

interface BoardReactErrorBoundaryState {
  hasError: boolean
}

export class BoardReactErrorBoundary extends React.Component<
  BoardReactErrorBoundaryProps,
  BoardReactErrorBoundaryState
> {
  state: BoardReactErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError(): BoardReactErrorBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: unknown): void {
    this.props.onError?.(error)
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      return React.createElement(
        'div',
        { className: 'board-react-error', role: 'alert' },
        'Excalidraw failed to render',
      )
    }

    return this.props.children
  }
}
