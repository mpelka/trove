import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn.ts";

/** A checkbox, optionally wrapped in its own `<label>`.
 *
 * The `label` prop is not stock shadcn (which ships the bare control) — it's kept
 * because it makes the control self-labelling, which is the only way this app uses
 * it. `className` lands on the WRAPPER when labelled, so callers space the whole
 * row rather than the 16px box.
 */
export function Checkbox({
  className,
  label,
  ...props
}: ComponentProps<typeof CheckboxPrimitive.Root> & { label?: ReactNode }) {
  const control = (
    <CheckboxPrimitive.Root
      className={cn(
        "relative flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border-0 bg-popover ring ring-hairline focus:outline-none",
        // Grow the hit target well past the 16px box without disturbing layout.
        "after:absolute after:-inset-x-3 after:-inset-y-2",
        "hover:ring-hairline focus-visible:ring-2 focus-visible:ring-primary",
        "data-[state=checked]:bg-contrast data-[state=checked]:ring-contrast",
        "disabled:cursor-not-allowed disabled:opacity-50",
        // Nudge down onto the first line of a multi-line label.
        label ? "mt-0.5" : undefined,
        !label && className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center text-on-contrast">
        <Check size={12} strokeWidth={3} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
  if (!label) return control;
  return (
    <label className={cn("m-0 inline-flex cursor-pointer items-start gap-2 text-base", className)}>
      {control}
      <span className="inline-flex items-center gap-1">{label}</span>
    </label>
  );
}
