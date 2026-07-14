import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { ComponentProps } from "react";
import { cn } from "./cn.ts";

export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export function TooltipContent({
  className,
  sideOffset = 10,
  ...props
}: ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        sideOffset={sideOffset}
        // Fixed near-black chip in BOTH modes — a tooltip is transient chrome, so it
        // deliberately ignores the palette (this is what the app already looked like;
        // the previous theme's own light popup was overridden to exactly this).
        // No arrow: the old one rendered as a pale diamond that clashed with the chip.
        className={cn(
          "z-50 flex origin-(--radix-tooltip-content-transform-origin) flex-col rounded-md bg-[#23272f] px-2.5 py-1.5 text-[11px] text-white shadow-lg",
          "data-[state=delayed-open]:animate-pop-in data-[state=closed]:animate-pop-out",
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
}
