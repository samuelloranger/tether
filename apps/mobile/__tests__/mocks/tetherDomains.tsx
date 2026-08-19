import type { ReactNode } from 'react';
import {
  ChromeProvider,
  ConnectionProvider,
  FileProvider,
  GitProvider,
  PresentationProvider,
  SessionProvider,
  TranscriptProvider,
  UiProvider,
  UpdaterProvider,
} from '../../src/tether/context/domains';

// Component tests drive the screen through one flat fixture (a Proxy that hands
// back a jest.fn() for anything it does not define). Feeding the same object to
// every domain provider keeps those fixtures working without reviving the
// god-object in application code — this shim exists only for tests.
export function DomainFixture({ value, children }: { value: unknown; children: ReactNode }) {
  const v = value as never;
  return (
    <ChromeProvider value={v}>
      <UiProvider value={v}>
        <UpdaterProvider value={v}>
          <ConnectionProvider value={v}>
            <SessionProvider value={v}>
              <GitProvider value={v}>
                <FileProvider value={v}>
                  <PresentationProvider value={v}>
                    <TranscriptProvider value={v}>{children}</TranscriptProvider>
                  </PresentationProvider>
                </FileProvider>
              </GitProvider>
            </SessionProvider>
          </ConnectionProvider>
        </UpdaterProvider>
      </UiProvider>
    </ChromeProvider>
  );
}
