import { PresentationRegistry } from './registry';

// Single shared instance: the control app (unix socket) creates/resets previews;
// the network app lists them (/api/presentations) and serves them (/preview).
export const presentations = new PresentationRegistry();
