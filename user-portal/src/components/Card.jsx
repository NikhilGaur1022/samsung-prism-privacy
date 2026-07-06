import { twMerge } from 'tailwind-merge'

export default function Card({ children, className = '', as: As = 'div', ...rest }) {
  return (
    <As
      className={twMerge('rounded-card bg-surface p-4 shadow-card', className)}
      {...rest}
    >
      {children}
    </As>
  )
}
