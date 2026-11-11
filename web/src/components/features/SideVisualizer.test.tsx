import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SideVisualizer } from './SideVisualizer'

describe('SideVisualizer', () => {
  it('has a close control with an accessible name that closes the viewer', () => {
    const onCloseFile = vi.fn()
    render(
      <SideVisualizer activeFile="/api/files/topic/t1" activeFileKind="text" activeFileTitle="Topic" activeFilePage={null} activeFileHighlight={null} platform="mac"
        fileLoading={false} fileContent="hello" onCloseFile={onCloseFile} onViewFile={vi.fn()} onToggleExpand={vi.fn()} onToggleFullWidth={vi.fn()} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Close file viewer' }))
    expect(onCloseFile).toHaveBeenCalled()
  })
})
