import { httpBase } from './address';

export interface Presentation {
  id: string;
  title: string;
  project: string;
  revision: number;
  url: string;
}

export function previewUrl(serverIp: string, port: string, url: string): string {
  return new URL(url, httpBase(serverIp, port)).toString();
}
