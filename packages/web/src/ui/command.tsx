import { Command as CommandPrimitive } from "cmdk";
import type { ComponentProps } from "react";
import { Search } from "lucide-react";
import { Dialog, DialogTitle } from "./dialog.tsx";
import { DialogContent } from "./dialog.tsx";
import { cn } from "./cn.ts";

// Vendored shadcn-style Command (cmdk). Colours resolve through the app tokens via
// the @theme inline mapping in styles.css (bg-popover, text-muted-foreground, …), so
// light/dark follow `data-mode` with no per-component work — same as the other ui files.

export function Command({ className, ...props }: ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      className={cn(
        "flex w-full flex-col overflow-hidden rounded-xl bg-popover text-popover-foreground",
        className,
      )}
      {...props}
    />
  );
}

/** Palette overlay: the vendored Radix Dialog wrapped around a Command, the way
 *  shadcn's command-dialog does it. `.palette-modal` (styles.css, unlayered so it
 *  beats the utility classes) repositions the dialog to the Raycast-style upper
 *  band and strips DialogContent's padding. */
export function CommandDialog({
  title = "Command palette",
  children,
  ...props
}: ComponentProps<typeof Dialog> & { title?: string }) {
  return (
    <Dialog {...props}>
      {/* No Description on purpose; drop the default aria-describedby so it can't dangle. */}
      <DialogContent className="palette-modal" aria-describedby={undefined}>
        <DialogTitle className="sr-only">{title}</DialogTitle>
        {children}
      </DialogContent>
    </Dialog>
  );
}

export function CommandInput({ className, ...props }: ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div className="flex items-center gap-2 border-b border-hairline px-3" cmdk-input-wrapper="">
      <Search size={15} className="shrink-0 text-muted-foreground" />
      <CommandPrimitive.Input
        className={cn(
          "h-11 w-full bg-transparent py-3 text-base text-foreground outline-none placeholder:text-muted-foreground",
          className,
        )}
        {...props}
      />
    </div>
  );
}

export function CommandList({ className, ...props }: ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      className={cn("max-h-[min(420px,50vh)] scroll-py-1 overflow-y-auto overflow-x-hidden", className)}
      {...props}
    />
  );
}

export function CommandEmpty(props: ComponentProps<typeof CommandPrimitive.Empty>) {
  return <CommandPrimitive.Empty className="py-6 text-center text-sm text-muted-foreground" {...props} />;
}

export function CommandGroup({ className, ...props }: ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      className={cn(
        "overflow-hidden p-1 text-foreground",
        "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function CommandSeparator({ className, ...props }: ComponentProps<typeof CommandPrimitive.Separator>) {
  return <CommandPrimitive.Separator className={cn("h-px bg-hairline", className)} {...props} />;
}

export function CommandItem({ className, ...props }: ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      className={cn(
        "relative flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none",
        "data-[selected=true]:bg-accent data-[selected=true]:text-foreground",
        "data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

/** Right-aligned hint (shortcut or meta text) inside an item. */
export function CommandShortcut({ className, ...props }: ComponentProps<"span">) {
  return <span className={cn("ml-auto shrink-0 text-xs text-muted-foreground", className)} {...props} />;
}
