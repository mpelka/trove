// Drag handle between panes. One variant drags `--sidebar-w` (measured from the LEFT
// edge, the original behavior); the other drags `--info-w` for the info panel, measured
// from the RIGHT edge. Both persist to localStorage and reset to default on double-click.
type Variant = "sidebar" | "info";

const CFG = {
  sidebar: { cssVar: "--sidebar-w", key: "trove-sidebar-w", min: 320, max: 820 },
  info: { cssVar: "--info-w", key: "trove-info-w", min: 260, max: 560 },
} as const satisfies Record<Variant, { cssVar: string; key: string; min: number; max: number }>;

export function Divider({ variant = "sidebar" }: { variant?: Variant }) {
  const cfg = CFG[variant];
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    el.classList.add("dragging");
    const move = (ev: PointerEvent) => {
      // sidebar grows to the right of the cursor; the info panel grows to its left,
      // so measure the info width from the window's right edge.
      const raw = variant === "info" ? window.innerWidth - ev.clientX : ev.clientX;
      const w = Math.min(cfg.max, Math.max(cfg.min, raw));
      document.documentElement.style.setProperty(cfg.cssVar, `${w}px`);
    };
    const up = () => {
      el.classList.remove("dragging");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const v = document.documentElement.style.getPropertyValue(cfg.cssVar);
      try {
        if (v) localStorage.setItem(cfg.key, v);
      } catch {}
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const reset = () => {
    document.documentElement.style.removeProperty(cfg.cssVar);
    try {
      localStorage.removeItem(cfg.key);
    } catch {}
  };
  return (
    <div
      className="divider"
      title="drag to resize — double-click to reset"
      onPointerDown={onPointerDown}
      onDoubleClick={reset}
    />
  );
}
