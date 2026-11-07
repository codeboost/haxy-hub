const sizes = {
  sm: "size-5 text-[0.625rem]",
  md: "size-6 text-xs",
  lg: "size-8 text-sm",
}

/** Someone's initial in a circle, beside their name (which says who it is: the circle is hidden from assistive technology). */
export function Avatar({ name, size = "md", className = "" }: { name: string; size?: keyof typeof sizes; className?: string }) {
  return (
    <span aria-hidden className={`grid shrink-0 place-items-center rounded-full bg-accent font-semibold text-accent-foreground uppercase ${sizes[size]} ${className}`}>
      {name.slice(0, 1)}
    </span>
  )
}
