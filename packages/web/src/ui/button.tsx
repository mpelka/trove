import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn.ts";

// Geometry/colour reproduce the button library this replaced, so the swap is invisible:
// secondary = panel face + hairline ring; destructive = a tinted fill under a
// top-to-bottom gradient sheen (see `emphasis` below).
const buttonVariants = cva(
  "group flex w-max shrink-0 cursor-pointer select-none items-center border-0 font-medium shadow-xs " +
    "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary " +
    "disabled:cursor-not-allowed disabled:text-muted-foreground",
  {
    variants: {
      variant: {
        secondary:
          "bg-popover text-foreground ring ring-border not-disabled:hover:bg-accent " +
          "disabled:bg-popover/50 disabled:text-foreground/70",
        destructive:
          "relative overflow-hidden bg-(--btn-emphasis-bg) text-white ring ring-(--btn-emphasis-ring) disabled:opacity-50",
      },
      size: {
        sm: "h-6.5 gap-1 rounded-md px-2 text-xs",
        base: "h-9 gap-1.5 rounded-lg px-3 text-base",
      },
    },
    defaultVariants: { variant: "secondary", size: "base" },
  },
);

// The destructive button paints a gradient sheen over its base fill rather than a flat
// colour. Deriving all four stops from --danger with color-mix keeps it correct in both
// modes off a single token (the previous library's recipe, kept verbatim).
const emphasis = {
  "--btn-emphasis-ring": "color-mix(in oklch, var(--danger), black 10%)",
  "--btn-emphasis-bg": "color-mix(in oklch, var(--danger), white 30%)",
  "--btn-emphasis-from": "color-mix(in oklch, var(--danger), white 15%)",
  "--btn-emphasis-to": "var(--danger)",
} as React.CSSProperties;

export type ButtonProps = ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    /** Leading glyph. Kept as a prop (not just a child) so it lands inside the
     *  content layer that sits above the destructive variant's gradient sheen. */
    icon?: ReactNode;
  };

export function Button({
  className,
  variant = "secondary",
  size = "base",
  icon,
  style,
  children,
  type = "button",
  ...props
}: ButtonProps) {
  const isEmphasis = variant === "destructive";
  return (
    <button
      className={cn(buttonVariants({ variant, size }), className)}
      style={isEmphasis ? { ...emphasis, ...style } : style}
      type={type}
      {...props}
    >
      {isEmphasis && (
        <span
          aria-hidden="true"
          className="absolute inset-0 translate-y-px rounded-[inherit] bg-linear-to-b from-(--btn-emphasis-from) to-(--btn-emphasis-to) group-hover:from-(--btn-emphasis-bg)"
        />
      )}
      {/* `relative` lifts the label above the destructive gradient; inert otherwise. */}
      <span className="relative flex items-center gap-1.5">
        {icon}
        {children != null && <span className="contents">{children}</span>}
      </span>
    </button>
  );
}
