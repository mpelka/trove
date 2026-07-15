import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "./ui/command.tsx";
import { trpc } from "./trpc.ts";
import { fmtRel } from "./lib.ts";
import { AgentBadge } from "./rows.tsx";
import {
  filterActions,
  fuzzyFilterSessions,
  PALETTE_GROUPS,
  type PaletteCtx,
  type PaletteHandlers,
} from "./palette-actions.ts";

/** ⌘K palette: fuzzy session jump + a pinned full-text search action + app commands.
 *  It COMPLEMENTS the left-pane search — the pinned action just writes the same ?q
 *  state the old header input drove, so snippets/highlights/deep links are untouched. */
export function CommandPalette({
  open,
  onOpenChange,
  ctx,
  handlers,
  onJump,
  onSearch,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  ctx: PaletteCtx;
  handlers: PaletteHandlers;
  onJump(sessionId: string): void;
  onSearch(query: string): void;
}) {
  const [value, setValue] = useState("");
  // Fresh slate on every open (Raycast behaviour) — the left-pane query is separate state.
  useEffect(() => {
    if (open) setValue("");
  }, [open]);

  // Unfiltered recent list for the jump rows — the same tRPC procedure the sidebar
  // uses, but WITHOUT the sidebar's filters, so jumps work across everything. Only
  // fetched while the palette is open; no server-side fuzzy anything.
  const listQ = useQuery({
    queryKey: ["palette-list"],
    queryFn: () => trpc.list.query({ limit: 500 }),
    enabled: open,
  });

  const q = value.trim();
  const sessionHits = fuzzyFilterSessions(listQ.data ?? [], q);
  const actions = filterActions(ctx, q);

  const close = () => onOpenChange(false);

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      {/* We rank/filter ourselves (fuzzy sessions + registry predicates), so cmdk's
          own filtering is off; it still owns arrow/Enter selection. */}
      <Command shouldFilter={false} loop>
        <CommandInput
          value={value}
          onValueChange={setValue}
          placeholder="Jump to a session, search, or run a command…"
          aria-label="Search every session"
        />
        <CommandList>
          <CommandEmpty>Nothing matches.</CommandEmpty>
          {sessionHits.length > 0 && (
            <CommandGroup heading="Jump to session">
              {sessionHits.map((s) => (
                <CommandItem
                  key={s.id}
                  value={`s:${s.id}`}
                  onSelect={() => {
                    onJump(s.id);
                    close();
                  }}
                >
                  <AgentBadge agent={s.agent} />
                  <span className="truncate">{s.name || "(untitled)"}</span>
                  <CommandShortcut>{fmtRel(s.updatedAt)}</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {q && (
            /* Pinned: always present while typing, regardless of fuzzy hits. */
            <CommandGroup heading="Search">
              <CommandItem
                value="search-conversations"
                onSelect={() => {
                  onSearch(q);
                  close();
                }}
              >
                <Search size={14} className="shrink-0 text-muted-foreground" />
                <span className="truncate">Search conversations for “{q}”</span>
              </CommandItem>
            </CommandGroup>
          )}
          {PALETTE_GROUPS.map((g) => {
            const items = actions.filter((a) => a.group === g.id);
            if (items.length === 0) return null;
            return (
              <CommandGroup key={g.id} heading={g.heading}>
                {items.map((a) => (
                  <CommandItem
                    key={a.id}
                    value={a.id}
                    onSelect={() => {
                      a.run(ctx, handlers);
                      close();
                    }}
                  >
                    {a.label(ctx)}
                  </CommandItem>
                ))}
              </CommandGroup>
            );
          })}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
