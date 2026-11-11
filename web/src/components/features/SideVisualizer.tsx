'use client'

import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { X, Loader2, Maximize2, Minimize2, Maximize, Minimize } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { parseFileLink } from '@/lib/fileLinks'

export type ActiveFileKind = 'pdf' | 'markdown' | 'text'

interface SideVisualizerProps {
  /** URL of the file (or an `inline:` sentinel when the content is passed in fileContent). */
  activeFile: string;
  /** Decided by the response Content-Type; null while loading. */
  activeFileKind: ActiveFileKind | null;
  activeFileTitle: string;
  activeFilePage: number | null;
  activeFileHighlight: string | null;
  platform: string;
  fileLoading: boolean;
  fileContent: string;
  onCloseFile: () => void;
  onViewFile: (href: string, title?: string) => void;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
  isFullWidth?: boolean;
  onToggleFullWidth?: () => void;
}

const preprocessLaTeX = (text: string | null | undefined): string => {
  if (!text) return '';
  let processed = text.replace(/\\\[([\s\S]*?)\\\]/g, '$$$$$1$$$$');
  processed = processed.replace(/\\\(([\s\S]*?)\\\)/g, '$$$1$$');
  return processed;
}

const renderTranscriptWithHighlight = (text: string, highlight: string | null): React.ReactNode => {
  if (!highlight || !text) return text;
  
  const index = text.toLowerCase().indexOf(highlight.toLowerCase());
  if (index === -1) return text;

  const before = text.slice(0, index);
  const match = text.slice(index, index + highlight.length);
  const after = text.slice(index + highlight.length);

  return (
    <>
      {before}
      <mark 
        ref={(el) => {
          if (el) {
            // Smoothly scroll the highlighted section into view in the center of the scroll area
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }}
        className="bg-yellow-200 dark:bg-yellow-800 text-foreground px-1 rounded font-semibold animate-pulse"
      >
        {match}
      </mark>
      {after}
    </>
  );
};

export function SideVisualizer({
  activeFile,
  activeFileKind,
  activeFileTitle,
  activeFilePage,
  activeFileHighlight,
  platform,
  fileLoading,
  fileContent,
  onCloseFile,
  onViewFile,
  isExpanded = false,
  onToggleExpand,
  isFullWidth = false,
  onToggleFullWidth,
}: SideVisualizerProps) {
  return (
    <div className="w-full h-full flex flex-col relative z-40">
      <div className="p-4 border-b flex items-center justify-between bg-muted/20">
        <div className="flex flex-col gap-0.5 min-w-0 flex-1 mr-2">
          <h4 className="font-semibold text-sm truncate" title={activeFileTitle}>
            {activeFileTitle || 'Document Viewer'}
          </h4>
          {activeFileKind === 'pdf' && (
            <span className="text-[10px] text-muted-foreground font-medium select-none">
              Press <kbd className="bg-muted px-1 py-0.5 rounded border font-mono">{platform === 'mac' ? '⌘F' : 'Ctrl+F'}</kbd> to search PDF
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {onToggleExpand && !isFullWidth && (
            <Button 
              variant="ghost" 
              size="icon" 
              className="hidden xl:inline-flex h-8 w-8 text-muted-foreground hover:text-foreground shrink-0" 
              onClick={onToggleExpand}
              title={isExpanded ? "Minimize panel width" : "Maximize panel width"}
            >
              {isExpanded ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
            </Button>
          )}
          {onToggleFullWidth && (
            <Button 
              variant="ghost" 
              size="icon" 
              className="hidden xl:inline-flex h-8 w-8 text-muted-foreground hover:text-foreground shrink-0" 
              onClick={onToggleFullWidth}
              title={isFullWidth ? "Exit full screen" : "View full screen"}
            >
              {isFullWidth ? <Minimize className="w-4 h-4" /> : <Maximize className="w-4 h-4" />}
            </Button>
          )}
          <Button variant="ghost" size="icon" aria-label="Close file viewer" title="Close" className="h-10 w-10 xl:h-8 xl:w-8 text-muted-foreground hover:text-foreground shrink-0" onClick={onCloseFile}>
            <X className="w-4 h-4" />
          </Button>
        </div>
      </div>
      <div className="flex-1 overflow-hidden p-0 relative">
        {activeFileKind === 'pdf' ? (
          <iframe 
            src={`${activeFile}${activeFilePage ? `#page=${activeFilePage}` : ''}`} 
            className="w-full h-full border-0"
          />
        ) : (
          <ScrollArea className="h-full w-full p-4 bg-background scrollbar-thin">
            <div className="prose dark:prose-invert max-w-none text-sm leading-relaxed font-sans text-charcoal-graphite">
              {fileLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-6 h-6 animate-spin text-fountain-ink" />
                </div>
              ) : activeFileKind === 'markdown' ? (
                <div className="prose max-w-none text-charcoal-graphite/90 prose-p:leading-relaxed prose-headings:font-display prose-headings:italic prose-strong:text-charcoal-graphite">
                  <ReactMarkdown 
                    remarkPlugins={[remarkGfm, remarkMath]} 
                    rehypePlugins={[rehypeKatex]}
                    components={{
                      a: ({ href, children }: any) => {
                        if (href && parseFileLink(href, window.location.origin)) {
                          return (
                            <button 
                              onClick={() => onViewFile(href)} 
                              className="text-fountain-ink hover:underline font-semibold inline-flex items-center gap-1 bg-transparent border-0 p-0 align-baseline text-left cursor-pointer"
                            >
                              {children}
                            </button>
                          );
                        }
                        return <a href={href} target="_blank" rel="noopener noreferrer" className="text-fountain-ink hover:underline">{children}</a>;
                      }
                    }}
                  >
                    {preprocessLaTeX(fileContent)}
                  </ReactMarkdown>
                </div>
              ) : (
                <div className="whitespace-pre-wrap text-xs font-mono p-1">
                  {renderTranscriptWithHighlight(fileContent, activeFileHighlight)}
                </div>
              )}
            </div>
          </ScrollArea>
        )}
      </div>
    </div>
  )
}
