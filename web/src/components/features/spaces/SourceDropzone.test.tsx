import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { SourceDropzone } from './SourceDropzone'
import { MAX_FILE_BYTES } from '@/lib/ingestLimits'

const fetchMock = vi.fn()
beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

const file = (name: string, size = 10) => {
  const f = new File(['x'], name, { type: 'application/octet-stream' })
  Object.defineProperty(f, 'size', { value: size })
  return f
}
const choose = (files: File[]) => fireEvent.change(screen.getByLabelText('Choose files to upload'), { target: { files } })
const ok = (name: string) => ({ status: 201, json: async () => ({ sources: [{ id: `id-${name}`, originalName: name, status: 'uploaded', sizeBytes: 10, nameAlreadyInSpace: false }] }) })

describe('SourceDropzone', () => {
  it('refuses .docx and files over the limit without sending anything', async () => {
    render(<SourceDropzone courseId="c1" bundle="initial" />)
    choose([file('notes.docx'), file('huge.pdf', MAX_FILE_BYTES + 1), file('empty.md', 0)])
    expect(await screen.findByText(/"notes\.docx" is not supported/)).toBeInTheDocument()
    expect(screen.getByText(/"huge\.pdf" is .* the limit is 50 MB per file/)).toBeInTheDocument()
    expect(screen.getByText(/"empty\.md" is empty/)).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends one request per file, one after the other, with the bundle', async () => {
    let release: (v: unknown) => void = () => {}
    fetchMock.mockImplementationOnce(() => new Promise((r) => { release = r }))
    fetchMock.mockResolvedValueOnce(ok('b.pdf'))
    const onUploaded = vi.fn()
    render(<SourceDropzone courseId="c 1" bundle="later" onUploaded={onUploaded} />)
    choose([file('a.md'), file('b.pdf')])
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(screen.getByText('Uploading')).toBeInTheDocument()
    expect(screen.getByText('Waiting')).toBeInTheDocument()
    release(ok('a.md'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(onUploaded).toHaveBeenCalledTimes(2))
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe('/api/spaces/c%201/sources')
      const body = init.body as FormData
      expect(body.getAll('files')).toHaveLength(1)
      expect(body.get('bundle')).toBe('later')
    }
    expect((fetchMock.mock.calls[0][1].body as FormData).get('files')).toHaveProperty('name', 'a.md')
    expect(screen.getAllByText('Accepted')).toHaveLength(2)
  })

  it("shows the server's per-file refusal and keeps going with the next file", async () => {
    fetchMock.mockResolvedValueOnce({ status: 415, json: async () => ({ error: 'bad', files: [{ name: 'a.pdf', error: 'a.pdf does not look like a PDF.' }] }) })
    fetchMock.mockResolvedValueOnce(ok('b.md'))
    render(<SourceDropzone courseId="c1" bundle="initial" />)
    choose([file('a.pdf'), file('b.md')])
    expect(await screen.findByText('a.pdf does not look like a PDF.')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('Accepted')).toBeInTheDocument())
  })

  it('reports a network failure and reports reaching busy false at the end', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    const busy = vi.fn()
    render(<SourceDropzone courseId="c1" bundle="initial" onBusyChange={busy} />)
    choose([file('a.md')])
    expect(await screen.findByText(/Could not reach the server/)).toBeInTheDocument()
    expect(busy).toHaveBeenCalledWith(true)
    expect(busy).toHaveBeenLastCalledWith(false)
  })

  it('accepts dropped files', async () => {
    fetchMock.mockResolvedValueOnce(ok('d.txt'))
    render(<SourceDropzone courseId="c1" bundle="initial" />)
    fireEvent.drop(screen.getByTestId('dropzone'), { dataTransfer: { files: [file('d.txt')] } })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  })

  it('drops the Accepted entry of a file that was removed from the studyspace', async () => {
    fetchMock.mockResolvedValueOnce(ok('a.md'))
    const { rerender } = render(<SourceDropzone courseId="c1" bundle="initial" removedSourceIds={[]} />)
    choose([file('a.md')])
    expect(await screen.findByText('Accepted')).toBeInTheDocument()
    rerender(<SourceDropzone courseId="c1" bundle="initial" removedSourceIds={['id-a.md']} />)
    expect(screen.queryByText('Accepted')).toBeNull()
  })
})
