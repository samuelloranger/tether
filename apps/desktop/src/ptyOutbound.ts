/**
 * Same gate as TerminalPane's onData path: suppress ONLY auto-replies while
 * replayed scrollback is being applied. User keystrokes and mouse reports
 * always pass — they are not auto-replies.
 */
export function shouldSendOutbound(isAutoReply: boolean, replaying: boolean): boolean {
  return !(isAutoReply && replaying);
}
