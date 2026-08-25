export function sessionLabel(s: {
  id: string;
  name?: string | null;
  auto_title?: string | null;
}): string {
  return s.name || s.auto_title || s.id;
}
