'use client'

import { useEffect, useState, type ReactNode, type RefObject } from 'react'
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import { Dialog, DialogOverlay, DialogPortal, DialogTitle } from '@/components/ui/dialog'

interface TutorSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The element that opened the sheet; focus goes back to it when the sheet closes. */
  returnFocusRef?: RefObject<HTMLElement | null>
  children: ReactNode
}

/**
 * The tutor as a bottom sheet (below the xl breakpoint). A modal dialog anchored to the bottom, about 65% of the
 * viewport high, so the top of the question stays visible above it. Escape, a tap on the area above it and the Close
 * button inside the content close it; focus moves into it when it opens and returns to the opening button; the page behind
 * does not scroll (the dialog primitive locks it and keeps focus inside).
 *
 * The content (the VoiceHub) is mounted only while the sheet is open. The tutor connection, the chat and the chat mode live
 * in the parent, so opening and closing the sheet never touches them.
 */
/** How long after the sheet closes a transparent layer keeps taps away from the page underneath. */
export const TAP_GUARD_MS = 400

export function TutorSheet({ open, onOpenChange, returnFocusRef, children }: TutorSheetProps) {
  // A tap that dismisses the sheet (or a second tap a moment later, or the click a touch browser synthesizes after the
  // touch) must never reach the card under the spot. The dialog closes on the click of its backdrop, but the backdrop is
  // gone as soon as it has closed, so for a short time a transparent layer takes its place and swallows those events.
  const [wasOpen, setWasOpen] = useState(open)
  const [guard, setGuard] = useState(false)
  if (wasOpen !== open) {
    setWasOpen(open)
    if (!open) setGuard(true)
  }
  useEffect(() => {
    if (!guard) return
    const timer = setTimeout(() => setGuard(false), TAP_GUARD_MS)
    return () => clearTimeout(timer)
  }, [guard])
  const swallow = (e: { preventDefault: () => void; stopPropagation: () => void }) => {
    e.preventDefault()
    e.stopPropagation()
  }

  return (
    <>
    {guard && !open && (
      <div
        data-testid="tap-guard"
        aria-hidden="true"
        className="fixed inset-0 z-50"
        onPointerDown={swallow}
        onPointerUp={swallow}
        onMouseDown={swallow}
        onTouchStart={swallow}
        onClick={swallow}
      />
    )}
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay className="bg-black/25" />
        <DialogPrimitive.Popup
          data-testid="tutor-sheet"
          finalFocus={returnFocusRef}
          className="fixed inset-x-0 bottom-0 z-50 flex h-[65dvh] max-h-[65dvh] flex-col overflow-hidden rounded-t-2xl bg-card text-card-foreground shadow-2xl ring-1 ring-foreground/10 outline-none pb-[env(safe-area-inset-bottom)] duration-200 data-open:animate-in data-open:slide-in-from-bottom data-closed:animate-out data-closed:slide-out-to-bottom"
        >
          <DialogTitle className="sr-only">Tutor</DialogTitle>
          <div className="flex min-h-0 flex-1 flex-col">{children}</div>
          {/* Lets a screen reader dismiss the dialog; sighted users have the Close button in the content, Escape and a tap outside */}
          <DialogPrimitive.Close className="sr-only">Close tutor panel</DialogPrimitive.Close>
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
    </>
  )
}
