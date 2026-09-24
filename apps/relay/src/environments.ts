import type { ApnsResult, ApnsSendOptions } from './apnsClient';

export interface ApnsSender {
  send(opts: ApnsSendOptions): Promise<ApnsResult>;
}

// A device token belongs to one APNs environment: TestFlight and App Store builds get
// production tokens, a development-signed build gets sandbox ones, and the relay cannot
// tell which from the token. BadDeviceToken is APNs saying "not mine", so the other
// environment gets exactly one try.
export async function sendToEitherEnvironment(
  primary: ApnsSender,
  other: ApnsSender,
  opts: ApnsSendOptions,
): Promise<ApnsResult> {
  const first = await primary.send(opts);
  if (first.status !== 400 || first.reason !== 'BadDeviceToken') return first;
  return other.send(opts);
}
