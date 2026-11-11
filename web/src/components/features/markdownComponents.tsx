import type { ComponentProps } from 'react'

/** Wide Markdown tables scroll inside their own box instead of widening the page (block formulas do the same through globals.css). */
export const scrollableTableComponents = {
  table: (props: ComponentProps<'table'>) => {
    // react-markdown also passes its syntax-tree `node`; it is not a DOM attribute
    const domProps: Record<string, unknown> = { ...props }
    delete domProps.node
    return (
      <div className="max-w-full overflow-x-auto" tabIndex={0} role="region" aria-label="Table, scrolls sideways">
        <table {...(domProps as ComponentProps<'table'>)} />
      </div>
    )
  },
}
