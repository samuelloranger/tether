// What to do with a session's socket when the app comes back to the foreground.
//
// Nothing in the app used to react to foregrounding, so a socket that iOS killed
// while the app was suspended just waited out its exponential backoff — up to
// 30s of "Connecting…" on an app the user is actively looking at — and a socket
// that came back half-open (network changed while suspended) waited on the 15s
// keepalive sweep instead, up to 30s more. Both are the same defect: suspension
// invalidates the connection, and resume is the moment to re-establish it.
export const RESUME_STALE_MS = 15_000;

export type ResumeAction =
  // Closed (or never opened): reconnect now instead of waiting out the backoff.
  | 'reconnect'
  // Open but silent across the suspension: likely half-open, so force a close
  // and let the existing onClose path reconnect.
  | 'close'
  // Open and recently heard from — leave it alone, reconnecting would only
  // interrupt a healthy stream.
  | 'none';

export function resumeAction(
  state: { open: boolean; lastSeen: number },
  now: number,
  staleMs = RESUME_STALE_MS,
): ResumeAction {
  if (!state.open) return 'reconnect';
  return now - state.lastSeen > staleMs ? 'close' : 'none';
}
