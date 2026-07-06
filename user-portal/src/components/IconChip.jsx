import { twMerge } from 'tailwind-merge'

const TONES = {
  brand: 'from-brand/15 to-brand/5 text-brand',
  success: 'from-success/15 to-success/5 text-success',
  warning: 'from-warning/15 to-warning/5 text-warning',
  danger: 'from-danger/15 to-danger/5 text-danger',
  neutral: 'from-ink/10 to-ink/[0.03] text-ink-muted',
  solid: 'from-brand to-brand-dark text-white',
}

const SIZES = {
  sm: 'h-9 w-9 rounded-xl',
  md: 'h-10 w-10 rounded-2xl',
  lg: 'h-12 w-12 rounded-2xl',
}

export default function IconChip({ icon: Icon, tone = 'brand', size = 'md', iconSize, className = '' }) {
  return (
    <div
      className={twMerge(
        'flex shrink-0 items-center justify-center bg-gradient-to-br shadow-[inset_0_1px_0_rgba(255,255,255,0.4)]',
        SIZES[size],
        TONES[tone],
        className,
      )}
    >
      <Icon size={iconSize ?? (size === 'lg' ? 22 : size === 'sm' ? 16 : 18)} strokeWidth={1.75} />
    </div>
  )
}
