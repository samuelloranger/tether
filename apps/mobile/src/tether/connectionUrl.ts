import { httpBase } from '../address';

export function connectionRequestUrl(host: string, port: string, path: string): string {
  return `${httpBase(host, port)}${path}`;
}
