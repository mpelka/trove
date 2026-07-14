import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { ComponentProps } from "react";
import { cn } from "./cn.ts";

export const Dialog = DialogPrimitive.Root;
export const DialogClose = DialogPrimitive.Close;
export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;

/** Dialog body. Portalled to <body>, so it escapes `.app`'s isolated stacking context
 *  and paints over the sticky pane headers.
 *
 *  `alert` marks a destructive confirm: it swaps the ARIA role and makes the dialog
 *  refuse outside-click dismissal, so the choice has to be explicit. Radix ships no
 *  separate alert-dialog here — it's the same primitive with those two behaviours. */
export function DialogContent({
  className,
  alert = false,
  children,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & { alert?: boolean }) {
  return (
    <DialogPrimitive.Portal>
      {/* A light scrim, not the usual black: it's the recessed surface at 80%. */}
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-muted opacity-80 data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out" />
      <DialogPrimitive.Content
        role={alert ? "alertdialog" : undefined}
        onPointerDownOutside={alert ? (e) => e.preventDefault() : undefined}
        className={cn(
          "fixed left-1/2 top-1/2 z-50 w-full min-w-72 max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2",
          "overflow-hidden rounded-xl bg-popover p-6 text-popover-foreground shadow-lg ring ring-border sm:w-auto",
          "data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out",
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
