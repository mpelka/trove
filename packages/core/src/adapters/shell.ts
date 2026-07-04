/** POSIX single-quote a string for safe interpolation into a shell command. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
