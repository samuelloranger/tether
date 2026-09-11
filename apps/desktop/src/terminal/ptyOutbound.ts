/** Same gate as TerminalPane's onData path: suppress ONLY auto-replies during
 *  replay. User keystrokes and mouse reports always pass. */
export function shouldSendOutbound(isAutoReply: boolean, replaying: boolean): boolean {
  return !(isAutoReply && replaying);
}
