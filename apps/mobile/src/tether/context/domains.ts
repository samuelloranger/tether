import { createDomainContext } from './createDomainContext';
import type { TetherParts } from './parts';
import type {
  buildChrome,
  buildConnection,
  buildGit,
  buildPresentation,
  buildSession,
  buildTranscript,
  buildUpdater,
} from './slices';

export type Chrome = ReturnType<typeof buildChrome>;
export type Ui = TetherParts['chrome']['ui'];
export type Updater = ReturnType<typeof buildUpdater>;
export type Connection = ReturnType<typeof buildConnection>;
export type Session = ReturnType<typeof buildSession>;
export type Git = ReturnType<typeof buildGit>;
export type FileView = TetherParts['workspace']['file'];
export type Presentation = ReturnType<typeof buildPresentation>;
export type Transcript = ReturnType<typeof buildTranscript>;

export const [ChromeProvider, useChrome] = createDomainContext<Chrome>('Chrome');
export const [UiProvider, useUi] = createDomainContext<Ui>('Ui');
export const [UpdaterProvider, useUpdater] = createDomainContext<Updater>('Updater');
export const [ConnectionProvider, useConnection] = createDomainContext<Connection>('Connection');
export const [SessionProvider, useSession] = createDomainContext<Session>('Session');
export const [GitProvider, useGit] = createDomainContext<Git>('Git');
export const [FileProvider, useFile] = createDomainContext<FileView>('File');
export const [PresentationProvider, usePresentation] =
  createDomainContext<Presentation>('Presentation');
export const [TranscriptProvider, useTranscript] = createDomainContext<Transcript>('Transcript');
