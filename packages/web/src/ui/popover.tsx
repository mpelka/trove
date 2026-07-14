import * as PopoverPrimitive from "@radix-ui/react-popover";
import type { ComponentProps } from "react";
import { cn } from "./cn.ts";

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;

export function PopoverContent({
  className,
  align = "center",
  sideOffset = 8,
  ...props
}: ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        // z-50 also lands on Radix's positioner (it mirrors the content's computed
        // z-index onto the wrapper), which is what floats the panel over the sticky
        // filter bar and detail head.
        className={cn(
          "z-50 flex origin-(--radix-popover-content-transform-origin) flex-col rounded-lg bg-popover px-4 py-3 text-sm text-popover-foreground shadow-lg outline outline-fill",
          "data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}
