import { useState } from 'react';

/** Pure submit step shared by commit and amend. Returns whether to clear the message. */
export async function submitGitMessage(
  message: string,
  committing: boolean,
  submit: (message: string) => Promise<boolean>,
): Promise<boolean> {
  if (!message.trim() || committing) return false;
  return submit(message.trim());
}

/** Shared commit/amend form state for GitDrawer and GitReview. */
export function useGitCommitForm(
  onCommit: (message: string) => Promise<boolean>,
  onAmend: (message: string) => Promise<boolean>,
) {
  const [commitMessage, setCommitMessage] = useState('');
  const [committing, setCommitting] = useState(false);

  const run = async (submit: (message: string) => Promise<boolean>) => {
    if (!commitMessage.trim() || committing) return;
    setCommitting(true);
    const ok = await submitGitMessage(commitMessage, false, submit);
    setCommitting(false);
    if (ok) setCommitMessage('');
  };

  return {
    commitMessage,
    setCommitMessage,
    committing,
    submitCommit: () => run(onCommit),
    submitAmend: () => run(onAmend),
  };
}
