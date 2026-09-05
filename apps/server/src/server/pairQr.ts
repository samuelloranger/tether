import QRCode from 'qrcode';
import { groupPairCode } from './pairCli';

export function pairQrPayload(code: string, hostUrl: string): string {
  const grouped = groupPairCode(code);
  return `tether://pair?code=${grouped}&host=${encodeURIComponent(hostUrl)}`;
}

export async function renderPairQr(payload: string): Promise<string> {
  return QRCode.toString(payload, { type: 'terminal', small: true });
}
