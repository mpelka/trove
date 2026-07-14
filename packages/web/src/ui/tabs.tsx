import * as TabsPrimitive from "@radix-ui/react-tabs";
import type { ComponentProps } from "react";
import { cn } from "./cn.ts";

// Segmented control only — the app uses Tabs purely as sort/view switches, never as
// tabbed panes, so there are no TabsContent panels and no size/variant knobs.

export function Tabs({ className, ...props }: ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      className={cn("relative isolate min-w-0 font-medium rounded-md ring ring-hairline/70", className)}
      {...props}
    />
  );
}

export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn("relative flex h-6.5 min-w-0 shrink items-stretch rounded-md bg-muted px-0.5", className)}
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      // The selected pill is painted on the trigger itself. The library this replaced
      // slid a separate absolutely-positioned indicator between triggers; Radix has no
      // indicator part, so the pill snaps instead of sliding — same resting look.
      className={cn(
        "relative my-0.5 flex cursor-pointer items-center whitespace-nowrap rounded-sm bg-transparent px-2 text-xs text-muted-foreground",
        "hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary",
        "data-[state=active]:bg-popover data-[state=active]:text-foreground data-[state=active]:shadow-sm data-[state=active]:ring data-[state=active]:ring-border",
        className,
      )}
      {...props}
    />
  );
}
