// The overflow trace named this one component on all six routes that broke at
// 820 px:
//
//   main.flex-1 px-10 py-8                       right=989
//   div.flex items-start justify-between gap-4   right=949
//   div.shrink-0                                 right=949
//
// A justify-between row with a shrink-0 action cluster and no flex-wrap: below a
// certain width the title and the actions cannot both fit, neither is allowed to
// shrink, and the row pushes past the viewport. Adding wrap and dropping shrink-0
// clears most of the tablet tier in one file.
//
// 820 px is not an exotic phone width. It is a small laptop, a browser at
// half-screen, and an iPad in portrait — widths a collection agent on a laptop
// will actually hit. Phones are out of scope (see UnsupportedViewport); this
// tier is not.
export default function PageHeader({ title, subtitle, action }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
      {/* min-w-0 lets the title column shrink rather than forcing the row wider
          than its container — without it, a long unbroken title overflows even
          with wrapping enabled. */}
      <div className="min-w-0 flex-1 basis-80">
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">{title}</h1>
        {subtitle && <p className="mt-1 text-sm font-medium text-ink-muted">{subtitle}</p>}
      </div>
      {action && <div className="flex flex-wrap items-center gap-2">{action}</div>}
    </div>
  )
}
