/** Quotes a value for insertion into the interactive POSIX shell. */
export function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}
