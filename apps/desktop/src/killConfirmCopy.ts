export function killConfirmCopy(memberLabels: string[]): { title: string; body: string } {
  if (memberLabels.length >= 2) {
    return {
      title: `Kill ${memberLabels.length} terminals in this group?`,
      body: memberLabels.join('\n'),
    };
  }
  const name = memberLabels[0] ?? '';
  return {
    title: 'Kill this terminal?',
    body: name
      ? `“${name}” — the process and saved output will be deleted.`
      : 'The process and saved output will be deleted.',
  };
}
