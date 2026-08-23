import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'

import PageHeader from './PageHeader'

// The one component behind the whole tablet tier.
//
// The overflow trace named the same chain on all six routes that broke at
// 820 px:
//
//   main.flex-1 px-10 py-8                       right=989
//   div.flex items-start justify-between gap-4   right=949
//   div.shrink-0                                 right=949
//
// A justify-between row with a shrink-0 action cluster and no flex-wrap. Fixing
// it here cleared most of the tier, so these assertions are on the two class
// changes that did it — crude, but they are the actual mechanism, and a jsdom
// test cannot measure a layout.

describe('PageHeader', () => {
  it('wraps rather than forcing the row wider than the viewport', () => {
    const { container } = render(<PageHeader title="Processed Data" action={<button>Export</button>} />)
    const row = container.firstElementChild

    expect(row.className).toMatch(/\bflex-wrap\b/)
  })

  it('does not pin the action cluster against shrinking', () => {
    const { container } = render(<PageHeader title="Sessions" action={<button>New</button>} />)

    // shrink-0 on the action cluster is what stopped the row ever fitting: with
    // neither column allowed to give, the row simply overflowed.
    const row = container.firstElementChild
    const actionWrapper = row.children[row.children.length - 1]
    expect(actionWrapper.className).not.toMatch(/\bshrink-0\b/)
  })

  it('lets the title column shrink so a long title cannot push the row out', () => {
    const { container } = render(<PageHeader title="A very long page title indeed" />)
    const titleColumn = container.firstElementChild.children[0]

    // Without min-w-0 a flex item refuses to shrink below its content width, so
    // an unbroken title overflows even with wrapping enabled.
    expect(titleColumn.className).toMatch(/\bmin-w-0\b/)
  })

  it('still renders what it is given', () => {
    render(<PageHeader title="Queue health" subtitle="What the pipeline is doing" action={<button>Sweep now</button>} />)

    expect(screen.getByRole('heading', { name: 'Queue health' })).toBeInTheDocument()
    expect(screen.getByText('What the pipeline is doing')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sweep now' })).toBeInTheDocument()
  })

  it('renders without an action', () => {
    const { container } = render(<PageHeader title="Audit Logs" />)
    // One direct child of the row — the title column, and no action cluster.
    expect(container.firstElementChild.children).toHaveLength(1)
  })
})
