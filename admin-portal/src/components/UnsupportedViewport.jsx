import { Monitor } from 'lucide-react'

// The declared supported floor, and the notice below it.
//
// Phones are out of scope for the admin portal — collection agents work on
// laptops, and the off-canvas drawer shell that a real phone layout needs was
// cut from the plan. But "out of scope" has to mean a notice, not a broken
// render. Measured at 390 px, /dsar/:requestId drew at scrollWidth 1316 against
// a 390 px viewport — 3.4x the screen, with content clipped mid-word. That is a
// defect. A sentence saying "this needs a desktop" is a decision.
//
// The numbers are declared here, in one place, because the CI overflow assertion
// needs something to test against. Without a stated floor, "desktop only"
// quietly becomes "whatever the last developer's monitor was".

/** Below this, the portal is not supported and says so. */
export const SUPPORTED_MIN_WIDTH = 1024

/** What the layouts are actually designed against. */
export const DESIGN_TARGET_WIDTH = 1280

export default function UnsupportedViewport() {
  return (
    <div
      // Tailwind's `lg` breakpoint is 1024 px, which is the floor — so this is
      // shown below lg and hidden at and above it. One breakpoint, one number,
      // matching SUPPORTED_MIN_WIDTH above.
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-canvas px-6 text-center lg:hidden"
      role="alert"
    >
      <Monitor size={40} strokeWidth={1.5} className="text-ink-faint" aria-hidden="true" />
      <div className="max-w-sm">
        <h1 className="text-lg font-extrabold tracking-tight text-ink">
          PRISM admin needs a wider screen
        </h1>
        <p className="mt-2 text-sm font-medium leading-relaxed text-ink-muted">
          This console is built for a desktop or laptop — {SUPPORTED_MIN_WIDTH}px wide at minimum.
          The consent workspace, the DSAR grid and the tagging review all need the room, and a
          narrower layout would hide controls rather than shrink them.
        </p>
        <p className="mt-3 text-xs font-medium text-ink-faint">
          Rotate to landscape, widen the window, or open this on a laptop.
        </p>
      </div>
    </div>
  )
}
