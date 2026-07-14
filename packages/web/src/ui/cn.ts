import clsx, { type ClassValue } from "clsx";

/** Join conditional class names.
 *
 * Deliberately clsx-only — NOT tailwind-merge. Our work registry doesn't carry
 * tailwind-merge, so `cn()` cannot dedupe conflicting Tailwind utilities the way
 * upstream shadcn does. Consequence for callers: a `className` prop does not
 * automatically beat a component's own utility of the same property — both are
 * emitted and the cascade decides. In practice every call site here passes plain
 * app classes (`.seg`, `.menu-panel`, `.gonebadge`) which live outside
 * `@layer utilities` and therefore win over Tailwind regardless.
 */
export const cn = (...a: ClassValue[]) => clsx(a);
