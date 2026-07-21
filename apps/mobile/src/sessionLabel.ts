// Display title precedence: manual rename > server-computed auto title
// (OSC 0/2 title, else cwd basename, else command) > raw session id.
export function sessionLabel(s: {
  id: string;
  name?: string | null;
  auto_title?: string | null;
}): string {
  return s.name || s.auto_title || s.id;
}
