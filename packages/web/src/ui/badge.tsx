import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "./cn.ts";

// `neutral` is the only variant the app uses (the "gone" marker). It reads as a
// grey pill with white text; --badge-neutral is a dedicated token because the grey
// steps *down* in dark mode rather than up like --dim does.
const badgeVariants = cva(
  "inline-flex w-fit flex-none shrink-0 items-center justify-self-start whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium",
  {
    variants: {
      variant: {
        neutral: "bg-badge-neutral text-white",
      },
    },
    defaultVariants: { variant: "neutral" },
  },
);

export type BadgeProps = ComponentProps<"span"> & VariantProps<typeof badgeVariants>;

export function Badge({ className, variant = "neutral", ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
