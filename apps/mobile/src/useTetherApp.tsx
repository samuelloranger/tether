import { FiraCode_400Regular } from '@expo-google-fonts/fira-code/400Regular';
import { useFonts } from '@expo-google-fonts/fira-code/useFonts';
import { JetBrainsMono_400Regular } from '@expo-google-fonts/jetbrains-mono/400Regular';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Linking, type TextInput } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppTheme } from './AppThemeProvider';
import { readClipboard, writeClipboard } from './clipboard';
import { createDeepLinkHandler, listenForDeepLinks } from './deepLink';
import { openExternalUrl } from './desktopUpdate';
import { confirmAction, notify } from './dialog';
import { isImagePath } from './diffModel';
import { fetchDiffImageUri, fetchOneReviewDiff, type ReviewDiffSlot } from './fetchReviewDiff';
import type { FileView } from './fileView';
import {
  mapWithConcurrency,
  reviewDiffKey,
  reviewFileEntries,
  summaryFingerprint,
} from './gitReviewModel';
import type { LinkTarget } from './links';
import { isDesktop, isTauri } from './platform';
import { sessionLabel } from './sessionLabel';
import { shellQuote } from './shell';
import { type RenderRow, setTheme } from './terminal';
import type { GitLogEntry } from './tether/types';
import { useAppPreferences } from './tether/useAppPreferences';
import { useConnectionConfig } from './tether/useConnectionConfig';
import { useDesktopEffects } from './tether/useDesktopEffects';
import { useDesktopUpdater } from './tether/useDesktopUpdater';
import { usePresentations } from './tether/usePresentations';
import { useTerminalInput } from './tether/useTerminalInput';
import { useTerminalSessions } from './tether/useTerminalSessions';
import { useTerminalUiState } from './tether/useTerminalUiState';
import { useTerminalViewport } from './tether/useTerminalViewport';

// Constants for async storage keys
const KEY_DIFF_SIDE_BY_SIDE = 'tether_diff_side_by_side';
const KEY_GIT_DRAWER_LEFT_WIDTH = 'tether_git_drawer_left_width';

export type { ReviewDiffSlot } from './fetchReviewDiff';
export type { GitLogEntry } from './tether/types';

export function useTetherApp() {
  // Proceed once fonts settle OR fail — never gate the whole app on a font fetch.
  // In the Tauri desktop build the webview serves assets over the `tauri://`
  // custom scheme, where FontFace.load() rejects; without the `|| fontError`
  // fallback the app rendered `null` forever (blank white window). On failure RN
  // Web falls back to a system monospace, which beats a white screen.
  const [fontsReady, fontError] = useFonts({ FiraCode_400Regular, JetBrainsMono_400Regular });
  const fontsLoaded = fontsReady || !!fontError;
  const insets = useSafeAreaInsets();
  const { theme } = useAppTheme();
  const connection = useConnectionConfig();
  const {
    serverIp,
    setServerIp,
    port,
    setPort,
    password,
    setPassword,
    passwordRef,
    setupMode,
    setSetupMode,
    confirmPassword,
    setConfirmPassword,
    testStatus,
    setTestStatus,
    isConfiguring,
    setIsConfiguring,
    ready,
    activeHostId: configuredActiveHostId,
    profiles,
    clientFor,
    storeError,
    loadProfiles,
    openAddHost,
    openEditHost,
    activateHost,
    removeHost: removeConfiguredHost,
    updateProfile,
    reorderHosts,
    updateIdentity,
    replaceStoredPassword,
    refreshIdentity,
    client: connectionClient,
    testConnection,
    saveConfig: saveConnectionConfig,
  } = connection;
  const {
    fontSize,
    setFontSize,
    fontFamily,
    changeFontFamily,
    lineHeight,
    changeFontSize,
    mouseEnabled,
    mouseEnabledRef,
    toggleMouseEnabled,
    notificationsEnabled,
    notificationsEnabledRef,
    toggleNotificationsEnabled,
    testNotification,
  } = useTerminalViewport();
  const {
    ctxMenu,
    setCtxMenu,
    utilityPage,
    setUtilityPage,
    selectionViewOpen,
    setSelectionViewOpen,
    menuOpen,
    setMenuOpen,
    renameModalOpen,
    setRenameModalOpen,
    renameText,
    setRenameText,
    appearanceModalOpen,
    setAppearanceModalOpen,
    searchQuery,
    setSearchQuery,
    searchInputRef,
    snippetsModalOpen,
    setSnippetsModalOpen,
    snippetDraft,
    setSnippetDraft,
    drawerOpen,
    setDrawerOpen,
  } = useTerminalUiState();
  const {
    updateInfo,
    setUpdateInfo,
    pendingUpdate,
    updateProgress,
    setUpdateProgress,
    updating,
    setUpdating,
    disposePending,
    checkForUpdatesManual,
    startUpdate,
    downloadUpdate,
    dismissUpdate,
  } = useDesktopUpdater();

  const [screen, setScreen] = useState<RenderRow[]>([]);
  const [deepLinkNotice, setDeepLinkNotice] = useState<string | null>(null);
  const [serverSettingsHostId, setServerSettingsHostId] = useState<string | null>(null);
  const serverSettingsHost =
    profiles?.find((profile) => profile.id === serverSettingsHostId) ?? null;
  const serverSettingsClient = serverSettingsHost ? clientFor(serverSettingsHost) : null;
  const profilesRef = useRef(profiles);
  profilesRef.current = profiles;

  const [fileView, setFileView] = useState<FileView | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const [diffSelectedPath, setDiffSelectedPath] = useState<string | null>(null);
  const [diffText, setDiffText] = useState<string | null>(null);
  const [diffTruncated, setDiffTruncated] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  // Which side of the index the selected file diff shows — drives which hunk
  // endpoint a hunk tap hits, and must match the mode the diff was read with.
  const [diffMode, setDiffMode] = useState<'staged' | 'unstaged' | null>(null);
  const diffModeRef = useRef<'staged' | 'unstaged' | null>(null);
  const diffSelectedPathRef = useRef<string | null>(null);
  const [historyEntries, setHistoryEntries] = useState<GitLogEntry[] | null>(null);
  const [historyCommit, setHistoryCommit] = useState<{
    entry: GitLogEntry;
    diff: string | null;
    truncated: boolean;
  } | null>(null);
  const [diffSideBySide, setDiffSideBySide] = useState(false);
  const [diffImage, setDiffImage] = useState<{ old: string | null; new: string | null } | null>(
    null,
  );
  const [reviewDiffs, setReviewDiffs] = useState<Record<string, ReviewDiffSlot>>({});
  const reviewLoadGenRef = useRef(0);

  const {
    activeId,
    activeHostId,
    activeClient,
    connectionStatus,
    hasConnected,
    drawerSessions,
    healthByHost,
    terminalViewRef,
    entryFor,
    getSessionEntry,
    getActiveSessionId,
    getTerminalSelection,
    wsSend,
    hydrateRenderer,
    onRendererResize,
    onRendererSelection,
    resetTerminal,
    switchTo: switchTerminal,
    newTerminal: createTerminal,
    killActiveOr,
    refreshSessions,
    refreshHost,
    resetHostHealth,
    removeHost: removeHostSessions,
    resetForEndpointChange,
    restartActiveSession,
    markAuthFailed,
    refreshSocketActivity,
    setWindowFocused,
    isWindowFocused,
  } = useTerminalSessions({
    client: connectionClient,
    profiles: profiles ?? [],
    clientFor,
    onReachable: refreshIdentity,
    ready,
    isConfiguring,
    theme,
    fontFamily,
    fontSize,
    notificationsEnabledRef,
    onClearView: () => setFileView(null),
    onClearPresentation: () => setActivePresentationId(null),
    onCloseDrawer: () => setDrawerOpen(false),
  });
  const {
    presentations,
    activePresentationId,
    setActivePresentationId,
    refreshPresentations,
    closePresentation,
  } = usePresentations({
    client: activeClient,
    isConfiguring,
    getActiveSessionId,
    markAuthFailed,
  });

  useEffect(() => {
    setTheme(theme.terminal);
  }, [theme]);

  const inputRef = useRef<TextInput | null>(null);
  const { ctrlArmed, setCtrlArmed, sendTyped, sendKey, sendPaste, sendProgram, cursorSeq } =
    useTerminalInput({ send: wsSend, mouseEnabledRef, getActiveSessionId, entryFor });
  const { snippets, setSnippets, persistSnippets } = useAppPreferences();
  const addSnippet = () => {
    const snippet = snippetDraft.trim();
    if (!snippet) return;
    persistSnippets([...snippets, snippet]);
    setSnippetDraft('');
  };
  const removeSnippet = (index: number) => {
    persistSnippets(snippets.filter((_, itemIndex) => itemIndex !== index));
  };
  const sendSnippet = (snippet: string) => {
    setSnippetsModalOpen(false);
    sendPaste(snippet);
  };

  const saveConfig = async () => {
    const { addressChanged, wasReady } = await saveConnectionConfig();
    if (addressChanged && wasReady) resetForEndpointChange();
    if (configuredActiveHostId) resetHostHealth(configuredActiveHostId);
  };
  const removeHost = async (hostId: string) => {
    removeHostSessions(hostId);
    await removeConfiguredHost(hostId);
  };
  const saveHostConnection = async (
    hostId: string,
    changes: { host: string; port: string },
    replacementPassword?: string,
  ) => {
    const current = profiles?.find((profile) => profile.id === hostId);
    if (!current) return;
    const endpointChanged = current.host !== changes.host || current.port !== changes.port;
    await updateProfile(hostId, changes);
    if (replacementPassword) await replaceStoredPassword(hostId, replacementPassword);
    if (endpointChanged || replacementPassword) {
      removeHostSessions(hostId);
      resetHostHealth(hostId);
    }
  };

  const switchTo = (hostId: string, id: string) => {
    closeDiff();
    void activateHost(hostId);
    switchTerminal(hostId, id);
  };
  const newTerminal = () => {
    setActivePresentationId(null);
    createTerminal();
  };

  const selectTerminal = (hostId: string, id: string) => {
    setActivePresentationId(null);
    switchTo(hostId, id);
  };

  const selectTerminalRef = useRef(selectTerminal);
  selectTerminalRef.current = selectTerminal;
  const deepLinkHandlerRef = useRef<ReturnType<typeof createDeepLinkHandler> | null>(null);
  if (!deepLinkHandlerRef.current)
    deepLinkHandlerRef.current = createDeepLinkHandler({
      getProfiles: () => profilesRef.current,
      onSession: (hostId, sessionId) => selectTerminalRef.current(hostId, sessionId),
    });
  const handleDeepLink = useCallback((url: string) => {
    const result = deepLinkHandlerRef.current?.handle(url);
    if (result?.kind === 'unknown-host')
      setDeepLinkNotice(`No saved host named “${result.identityName}”.`);
  }, []);
  const handleDeepLinkRef = useRef(handleDeepLink);
  handleDeepLinkRef.current = handleDeepLink;
  useEffect(() => {
    let disposed = false;
    let stopDesktopListener: (() => void) | undefined;
    const handleUrl = (url: string) => handleDeepLinkRef.current(url);
    void Linking.getInitialURL()
      .then((url) => {
        if (url) handleUrl(url);
      })
      .catch(() => {});
    const subscription = Linking.addEventListener('url', ({ url }) => handleUrl(url));
    if (isDesktop && isTauri())
      void import('@tauri-apps/plugin-deep-link')
        .then(({ getCurrent, onOpenUrl }) =>
          listenForDeepLinks({ getCurrent, onOpenUrl, onUrl: handleUrl }),
        )
        .then((stop) => {
          if (disposed) stop();
          else stopDesktopListener = stop;
        })
        .catch(() => {});
    return () => {
      disposed = true;
      subscription.remove();
      stopDesktopListener?.();
    };
  }, []);
  useEffect(() => {
    if (profiles === null) return;
    const result = deepLinkHandlerRef.current?.applyPending();
    if (result?.kind === 'unknown-host')
      setDeepLinkNotice(`No saved host named “${result.identityName}”.`);
  }, [profiles]);

  const selectPresentation = (id: string) => {
    setFileView(null);
    closeDiff();
    setActivePresentationId(id);
  };

  // Poll the session list and presentation metadata every 4s. The session
  // poll keeps running while the desktop window is hidden — it is the only
  // path that can surface a background session flipping to `waiting` when
  // minimized (uncached sessions have no socket), and it's one cheap SQLite
  // read per tick. Only the presentation poll pauses when hidden.
  useEffect(() => {
    if (isConfiguring) return;
    let iv: ReturnType<typeof setInterval> | null = null;
    let hidden = false;
    const tick = () => {
      if (!hidden) refreshPresentations();
    };
    const start = () => {
      if (iv) return;
      tick();
      iv = setInterval(tick, 4000);
    };
    const stop = () => {
      if (iv) {
        clearInterval(iv);
        iv = null;
      }
    };
    start();
    // Desktop: while hidden/minimized the interval keeps running (sessions
    // only, per `hidden` in tick) and an immediate full refresh fires on
    // return so the presentation list is never stale when the window comes back.
    let onVis: (() => void) | undefined;
    if (isDesktop && typeof document !== 'undefined') {
      onVis = () => {
        hidden = document.hidden;
        if (!hidden) tick();
      };
      document.addEventListener('visibilitychange', onVis);
    }
    return () => {
      stop();
      if (onVis) document.removeEventListener('visibilitychange', onVis);
    };
  }, [isConfiguring, serverIp, port]);

  // Connection configuration loads itself. This effect owns only the unrelated
  // diff preference and terminal-renderer cleanup.
  useEffect(() => {
    AsyncStorage.getItem(KEY_DIFF_SIDE_BY_SIDE)
      .then((value) => setDiffSideBySide(value === 'true'))
      .catch(() => {});
    return undefined;
  }, []);
  // Full plain-text transcript (visible screen + scrollback) for the
  // selectable view and the Copy All fallback.
  const snapshotText = (rows: RenderRow[]) =>
    rows
      .map((r) => r.runs.map((run) => run.text).join(''))
      .join('\n')
      .replace(/\n+$/, '');
  const getFullText = () => snapshotText(entryFor(getActiveSessionId()).term.getSnapshot());

  // Transcript filtered to lines matching the query — memoized: the previous
  // version re-split the whole scrollback on every keystroke and every render.
  const searchText = useMemo(() => {
    const full = snapshotText(screen);
    const q = searchQuery.trim().toLowerCase();
    if (!q) return full;
    return full
      .split('\n')
      .filter((line) => line.toLowerCase().includes(q))
      .join('\n');
  }, [screen, searchQuery]);

  // Scrolls xterm to the nearest prompt-start row in `dir`, using the
  // start/end of the currently-known scrollback as the search origin.
  const jumpPrompt = (dir: 1 | -1) => {
    const term = entryFor(getActiveSessionId()).term;
    const snapshot = term.getSnapshot();
    const from = dir === 1 ? 0 : snapshot.length - 1;
    const target = term.jumpToPrompt(from, dir);
    if (target === null) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    terminalViewRef.current?.scrollToLine(target);
  };

  // Open a frozen, natively selectable snapshot of the current transcript.
  const openSelectionView = async () => {
    setMenuOpen(false);
    setSearchQuery('');
    const snapshot = await entryFor(getActiveSessionId()).term.getSettledSnapshot();
    if (!snapshotText(snapshot)) return;
    setScreen(snapshot);
    setSelectionViewOpen(true);
  };

  // Desktop context-menu actions.
  const copySelection = async () => {
    const sel = getTerminalSelection();
    // Fall back to the whole displayed transcript when nothing is selected.
    const text = sel || getFullText();
    if (text) await writeClipboard(text);
  };

  const selectAllTerminal = () => {
    terminalViewRef.current?.selectAll();
  };

  // Uploads bytes into a per-session upload dir under ~/.tether/uploads on
  // the server (collision-suffixed, keeps uploads out of whatever project
  // the user happens to be working in), then types the resulting path into
  // the terminal — shared by the image picker, iOS/iPadOS native drag-drop,
  // and desktop drag-drop.
  //
  // Native callers (picker, iOS/iPadOS drag-drop) must pass a {uri, name,
  // type} descriptor, not a Blob, and it's uploaded via expo-file-system's
  // File.upload() rather than fetch()+FormData. Both of RN's own file-upload
  // primitives are broken for local asset/content URIs under this app's setup:
  // fetch(uri).then(r => r.blob()) throws under Hermes ("Creating blobs from
  // 'ArrayBuffer' ... are not supported"), and FormData.append(key, {uri,
  // name, type}) — RN's own documented pattern for this — throws natively
  // ("Unsupported FormDataPart implementation"), a known New Architecture
  // regression. expo-file-system's native upload sidesteps both. The desktop
  // web drag-drop path already has a real browser Blob/File from the DOM drop
  // event (no local URI involved), so it keeps using fetch()+FormData.
  const uploadFile = async (
    file: Blob | { uri: string; name: string; type?: string },
    filename: string,
  ) => {
    const path = `/api/sessions/${getActiveSessionId()}/upload`;
    const url = activeClient.url(path);
    try {
      let data: { ok: boolean; path?: string; error?: string };
      if (file instanceof Blob) {
        const form = new FormData();
        form.append('file', file, filename);
        const res = await activeClient.post(path, { body: form });
        data = (await res.json()) as { ok: boolean; path?: string; error?: string };
      } else {
        const { File, Paths, UploadType } = await import('expo-file-system');
        const source = new File(file.uri);
        // Unique per call regardless of the (possibly colliding, possibly
        // shared-across-a-multi-drop) display filename, so concurrent
        // uploads never race on the same staged cache file.
        const staged = new File(
          Paths.cache,
          `${Date.now()}-${Math.random().toString(36).slice(2)}-${filename}`,
        );
        try {
          await source.copy(staged, { overwrite: true });
          const result = await staged.upload(url, {
            uploadType: UploadType.MULTIPART,
            fieldName: 'file',
            mimeType: file.type,
            // The multipart part's own filename is the unique staged name
            // above (needed to dedupe concurrent uploads) — override it back
            // to the real display name the server should save under.
            parameters: { filename },
            headers: activeClient.authHeader,
          });
          data = JSON.parse(result.body);
        } finally {
          try {
            staged.delete();
          } catch {}
        }
      }
      if (!data.ok || !data.path) throw new Error(data.error || 'upload failed');
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      sendPaste(shellQuote(data.path));
    } catch (err) {
      void notify(
        'Upload failed',
        `Could not upload the file to the server: ${String(err)}`,
        'error',
      );
    }
  };

  const pickAndUploadImage = async () => {
    try {
      const ImagePicker = await import('expo-image-picker');
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        void notify(
          'Permission needed',
          'Allow photo library access in Settings to attach images.',
          'error',
        );
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({ quality: 1 });
      if (result.canceled || !result.assets[0]) return;
      const asset = result.assets[0];
      const filename = asset.fileName || `image-${Date.now()}.jpg`;
      await uploadFile({ uri: asset.uri, name: filename, type: asset.mimeType }, filename);
    } catch (err) {
      void notify('Upload failed', `Could not read the selected image: ${String(err)}`, 'error');
    }
  };

  const handlePaste = async () => {
    let text = '';
    try {
      text = await readClipboard();
    } catch {
      void notify('Paste failed', 'Could not read the clipboard.', 'error');
      return;
    }
    if (!text) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const e = getSessionEntry(getActiveSessionId());
    sendPaste(e?.term.bracketedPaste ? `\x1b[200~${text}\x1b[201~` : text);
  };

  const activeSession = drawerSessions.find((s) => s.id === activeId);
  const activeName = activeSession ? sessionLabel(activeSession) : activeId;
  const activePresentation =
    presentations.find((preview) => preview.id === activePresentationId) || null;
  const closeFile = useCallback(() => setFileView(null), []);
  const openFile = useCallback(
    async (target: LinkTarget) => {
      if (target.kind === 'external') {
        try {
          if (isDesktop) await openExternalUrl(target.url);
          else await Linking.openURL(target.url);
        } catch (error) {
          void notify('Could not open link', String(error), 'error');
        }
        return;
      }
      setFileLoading(true);
      try {
        const sessionId = getActiveSessionId();
        const query = new URLSearchParams({ path: target.path });
        const res = await activeClient.get(`/api/sessions/${sessionId}/file?${query}`);
        const body = (await res.json().catch(() => ({}))) as {
          path?: string;
          content?: string;
          error?: string;
        };
        if (!res.ok || typeof body.path !== 'string' || typeof body.content !== 'string') {
          throw new Error(body.error || `Request failed (${res.status})`);
        }
        if (getActiveSessionId() === sessionId) {
          setFileView({
            path: body.path,
            content: body.content,
            line: target.line,
            column: target.column,
          });
        }
      } catch (error) {
        void notify('Could not open file', String(error), 'error');
      } finally {
        setFileLoading(false);
      }
    },
    [activeClient],
  );
  const closeDiff = useCallback(() => {
    reviewLoadGenRef.current += 1;
    setDiffOpen(false);
    setDiffSelectedPath(null);
    diffSelectedPathRef.current = null;
    setDiffMode(null);
    diffModeRef.current = null;
    setDiffText(null);
    setDiffTruncated(false);
    setDiffImage(null);
    setHistoryCommit(null);
    setReviewDiffs({});
  }, []);
  const deselectDiffFile = useCallback(() => {
    setDiffSelectedPath(null);
    diffSelectedPathRef.current = null;
    setDiffMode(null);
    diffModeRef.current = null;
    setDiffText(null);
    setDiffTruncated(false);
    setDiffImage(null);
  }, []);
  const selectDiffFile = useCallback(
    async (filePath: string, mode?: 'staged' | 'unstaged') => {
      setDiffSelectedPath(filePath);
      diffSelectedPathRef.current = filePath;
      setDiffMode(mode ?? null);
      diffModeRef.current = mode ?? null;
      setDiffText(null);
      setDiffTruncated(false);
      setDiffImage(null);
      setDiffLoading(true);
      try {
        const sessionId = getActiveSessionId();
        const file = entryFor(sessionId).diffSummary.files.find((f) => f.path === filePath);
        if (file?.binary && isImagePath(filePath)) {
          const query = new URLSearchParams({ path: filePath });
          const [oldUri, newUri] = await Promise.all([
            fetchDiffImageUri(
              activeClient,
              `/api/sessions/${sessionId}/diff/file?${query}&side=old`,
            ),
            fetchDiffImageUri(
              activeClient,
              `/api/sessions/${sessionId}/diff/file?${query}&side=new`,
            ),
          ]);
          setDiffImage({ old: oldUri, new: newUri });
          return;
        }
        const query = new URLSearchParams({ path: filePath });
        if (mode) query.set('mode', mode);
        const res = await activeClient.get(`/api/sessions/${sessionId}/diff?${query}`);
        const body = (await res.json().catch(() => ({}))) as {
          diff?: string;
          truncated?: boolean;
          error?: string;
        };
        if (!res.ok || typeof body.diff !== 'string') {
          throw new Error(body.error || `Request failed (${res.status})`);
        }
        setDiffText(body.diff);
        setDiffTruncated(body.truncated === true);
      } catch (error) {
        void notify('Could not load diff', String(error), 'error');
      } finally {
        setDiffLoading(false);
      }
    },
    [activeClient],
  );
  const loadReviewDiffs = useCallback(() => {
    const sessionId = getActiveSessionId();
    const entries = reviewFileEntries(entryFor(sessionId).diffSummary);
    const gen = ++reviewLoadGenRef.current;
    // Replace the cache to match the live summary — drop paths that left, and
    // force a reload so staged/unstaged moves after a WS push aren't sticky.
    setReviewDiffs(() => {
      const next: Record<string, ReviewDiffSlot> = {};
      for (const e of entries) next[reviewDiffKey(e.mode, e.path)] = { status: 'loading' };
      return next;
    });
    void mapWithConcurrency(entries, 5, async (e) => {
      const key = reviewDiffKey(e.mode, e.path);
      const slot = await fetchOneReviewDiff({
        client: activeClient,
        sessionId,
        path: e.path,
        mode: e.mode,
        file: e.file,
      });
      if (reviewLoadGenRef.current !== gen) return slot;
      setReviewDiffs((prev) => ({ ...prev, [key]: slot }));
      return slot;
    });
  }, [activeClient, entryFor, getActiveSessionId]);

  const retryReviewDiff = useCallback(
    (mode: 'staged' | 'unstaged', path: string) => {
      const sessionId = getActiveSessionId();
      const file = entryFor(sessionId).diffSummary.files.find((f) => f.path === path);
      if (!file) return;
      const key = reviewDiffKey(mode, path);
      const gen = reviewLoadGenRef.current;
      setReviewDiffs((prev) => ({ ...prev, [key]: { status: 'loading' } }));
      void fetchOneReviewDiff({
        client: activeClient,
        sessionId,
        path,
        mode,
        file: { ...file, staged: mode === 'staged' },
      }).then((slot) => {
        if (reviewLoadGenRef.current !== gen) return;
        setReviewDiffs((prev) => ({ ...prev, [key]: slot }));
      });
    },
    [activeClient, entryFor, getActiveSessionId],
  );

  const openDiff = useCallback(() => {
    setDiffOpen(true);
    setDiffSelectedPath(null);
    diffSelectedPathRef.current = null;
    setDiffMode(null);
    diffModeRef.current = null;
    setDiffText(null);
    setDiffTruncated(false);
    setDiffImage(null);
    setHistoryCommit(null);
  }, []);

  // --- Git write ops + history (diff view v2) ---

  const gitFetch = useCallback(
    async (route: string, init?: RequestInit) => {
      const sessionId = getActiveSessionId();
      const res = await activeClient.get(`/api/sessions/${sessionId}/git/${route}`, {
        ...init,
        headers: { 'Content-Type': 'application/json', ...init?.headers },
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        throw new Error(
          typeof body.error === 'string' ? body.error : `Request failed (${res.status})`,
        );
      }
      return body;
    },
    [activeClient],
  );

  const gitPost = useCallback(
    (route: string, payload: unknown) =>
      gitFetch(route, { method: 'POST', body: JSON.stringify(payload) }),
    [gitFetch],
  );

  // Reload the open file diff after a staging op so hunk indices stay in sync
  // with the server's view. The summary itself refreshes via the diff frame.
  const refreshOpenDiff = useCallback(() => {
    const path = diffSelectedPathRef.current;
    const mode = diffModeRef.current;
    if (path) void selectDiffFile(path, mode ?? undefined);
  }, [selectDiffFile]);

  const stageFile = useCallback(
    async (path: string) => {
      try {
        await gitPost('stage', { path });
        // Summary + review cache refresh via the live WS `diff` effect.
      } catch (error) {
        void notify('Stage failed', String(error), 'error');
      }
    },
    [gitPost],
  );

  const unstageFile = useCallback(
    async (path: string) => {
      try {
        await gitPost('unstage', { path });
      } catch (error) {
        void notify('Unstage failed', String(error), 'error');
      }
    },
    [gitPost],
  );

  const discardFile = useCallback(
    async (path: string) => {
      const ok = await confirmAction(
        `Discard changes to ${path}?`,
        "Uncommitted changes to this file will be lost. This can't be undone.",
        { confirmLabel: 'Discard', destructive: true },
      );
      if (!ok) return;
      try {
        await gitPost('discard', { path });
        if (diffSelectedPathRef.current === path) deselectDiffFile();
      } catch (error) {
        void notify('Discard failed', String(error), 'error');
      }
    },
    [gitPost, deselectDiffFile],
  );

  const stageAllFiles = useCallback(async () => {
    try {
      await gitPost('stage-all', {});
    } catch (error) {
      void notify('Stage all failed', String(error), 'error');
    }
  }, [gitPost]);

  const unstageAllFiles = useCallback(async () => {
    try {
      await gitPost('unstage-all', {});
    } catch (error) {
      void notify('Unstage all failed', String(error), 'error');
    }
  }, [gitPost]);

  const discardAllFiles = useCallback(async () => {
    const ok = await confirmAction(
      'Discard all unstaged changes?',
      "Every unstaged file will be restored or deleted. This can't be undone.",
      { confirmLabel: 'Discard all', destructive: true },
    );
    if (!ok) return;
    try {
      await gitPost('discard-all', {});
      deselectDiffFile();
    } catch (error) {
      void notify('Discard all failed', String(error), 'error');
    }
  }, [gitPost, deselectDiffFile]);

  const toggleHunk = useCallback(
    async (path: string, hunkIndex: number, staged: boolean) => {
      try {
        await gitPost(staged ? 'unstage-hunk' : 'stage-hunk', { path, hunkIndex });
      } catch (error) {
        void notify(staged ? 'Unstage hunk failed' : 'Stage hunk failed', String(error), 'error');
      }
      // 409-stale or success: wait for the WS summary so we don't rebuild from
      // a pre-op staged/unstaged split.
    },
    [gitPost],
  );

  const commitStagedChanges = useCallback(
    async (message: string, amend = false) => {
      try {
        await gitPost('commit', { message, ...(amend ? { amend: true } : {}) });
        return true;
      } catch (error) {
        void notify(amend ? 'Amend failed' : 'Commit failed', String(error), 'error');
        return false;
      }
    },
    [gitPost],
  );

  const undoLastCommit = useCallback(async () => {
    const ok = await confirmAction(
      'Undo last commit?',
      'HEAD will move back one commit. Changes stay staged.',
      { confirmLabel: 'Undo commit' },
    );
    if (!ok) return;
    try {
      await gitPost('undo-commit', {});
    } catch (error) {
      void notify('Undo commit failed', String(error), 'error');
    }
  }, [gitPost]);

  const pushChanges = useCallback(async () => {
    try {
      await gitPost('push', {});
    } catch (error) {
      void notify('Push failed', String(error), 'error');
    }
  }, [gitPost]);

  const openDiffFileLine = useCallback(
    (path: string, line: number) => {
      void openFile({ kind: 'file', path, line });
    },
    [openFile],
  );

  const loadGitLog = useCallback(async () => {
    try {
      const entries = (await gitFetch('log')) as unknown as GitLogEntry[];
      setHistoryEntries(entries);
    } catch (error) {
      setHistoryEntries([]);
      void notify('Could not load history', String(error), 'error');
    }
  }, [gitFetch]);

  const selectCommit = useCallback(
    async (entry: GitLogEntry | null) => {
      if (!entry) {
        setHistoryCommit(null);
        return;
      }
      setHistoryCommit({ entry, diff: null, truncated: false });
      try {
        const body = (await gitFetch(`commit/${entry.sha}/diff`)) as {
          diff?: string;
          truncated?: boolean;
        };
        setHistoryCommit({
          entry,
          diff: typeof body.diff === 'string' ? body.diff : '',
          truncated: body.truncated === true,
        });
      } catch (error) {
        setHistoryCommit(null);
        void notify('Could not load commit', String(error), 'error');
      }
    },
    [gitFetch],
  );

  const toggleDiffSideBySide = useCallback(() => {
    setDiffSideBySide((prev) => {
      AsyncStorage.setItem(KEY_DIFF_SIDE_BY_SIDE, String(!prev));
      return !prev;
    });
  }, []);
  // Peek (non-touching) so render stays pure — the active entry is already
  // MRU-resident from connect/switchTo; only the very first render (before any
  // touch) falls back to entryFor, which creates it.
  const activeEntry = getSessionEntry(activeId) ?? entryFor(activeId);
  const changeSummary = activeEntry.diffSummary;
  const repoStatus = activeEntry.repoStatus;
  const changeSummaryFp = summaryFingerprint(changeSummary);
  const loadReviewDiffsRef = useRef(loadReviewDiffs);
  loadReviewDiffsRef.current = loadReviewDiffs;
  const refreshOpenDiffRef = useRef(refreshOpenDiff);
  refreshOpenDiffRef.current = refreshOpenDiff;
  const selectDiffFileRef = useRef(selectDiffFile);
  selectDiffFileRef.current = selectDiffFile;
  const deselectDiffFileRef = useRef(deselectDiffFile);
  deselectDiffFileRef.current = deselectDiffFile;
  // Only re-run when the drawer opens or the live summary fingerprint changes —
  // not when loadReviewDiffs' identity churns (entryFor is recreated each render).
  // biome-ignore lint/correctness/useExhaustiveDependencies: loaders via refs; summary via fingerprint
  useEffect(() => {
    if (!diffOpen) return;
    loadReviewDiffsRef.current();
    const path = diffSelectedPathRef.current;
    const mode = diffModeRef.current;
    if (!path) return;
    const entries = reviewFileEntries(changeSummary);
    if (entries.some((e) => e.path === path && e.mode === mode)) {
      refreshOpenDiffRef.current();
      return;
    }
    const moved = entries.find((e) => e.path === path);
    if (moved) {
      void selectDiffFileRef.current(moved.path, moved.mode);
      return;
    }
    deselectDiffFileRef.current();
  }, [diffOpen, changeSummaryFp]);
  // Read live off the mutable emulator field — re-derives every render.
  // activeBellCount drives TerminalScreen's on-screen visual bell flash; the
  // OS notification path lives in maybeNotify (per-session, in the ws handler).
  const activeBellCount = activeEntry.term.bellCount;
  const activePromptReturnCount = activeEntry.term.promptReturnCount;
  useDesktopEffects({
    isConfiguring,
    presentations,
    activePresentationId,
    fileViewOpen: !!fileView,
    // Desktop GitDrawer keeps the terminal live; only mobile GitReview is a takeover.
    diffOpen: diffOpen && !isDesktop,
    getSessionEntry,
    getActiveSessionId,
    getTerminalSelection,
    inputRef,
    sendKey,
    sendPaste,
    handlePaste,
    selectAllTerminal,
    newTerminal,
    changeFontSize,
    setContextMenu: setCtxMenu,
    setWindowFocused,
    isWindowFocused,
    refreshSocketActivity,
    activePromptReturnCount,
  });

  // Update-modal progress display.
  const upPct =
    updateProgress && updateProgress.total > 0
      ? Math.min(100, Math.round((updateProgress.done / updateProgress.total) * 100))
      : 0;
  const upLabel =
    !updateProgress || updateProgress.total === 0
      ? 'Preparing…'
      : upPct >= 100
        ? 'Restarting…'
        : `${upPct}%  ${(updateProgress.done / 1e6).toFixed(1)}/${(updateProgress.total / 1e6).toFixed(1)} MB`;

  const openRename = () => {
    setRenameText(drawerSessions.find((s) => s.id === activeId)?.name || '');
    setMenuOpen(false);
    setRenameModalOpen(true);
  };

  const submitRename = async () => {
    const id = activeId;
    const name = renameText.trim();
    setRenameModalOpen(false);
    try {
      await activeClient.post('/api/sessions/rename', {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, name }),
      });
      await refreshSessions();
    } catch (err) {
      void notify('Rename failed', String(err), 'error');
    }
  };

  const hardResetSession = async () => {
    const ok = await confirmAction(
      'Restart terminal',
      "This restarts the shell process and clears this terminal's scrollback history on the server. This can't be undone.",
      { confirmLabel: 'Restart', destructive: true },
    );
    if (!ok) return;
    resetTerminal();
    try {
      await activeClient.post('/api/sessions/kill', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: activeId }),
      });
      restartActiveSession();
    } catch {
      void notify('Error', 'Failed to kill session on the server', 'error');
    }
  };

  // Map the connection state to the TitleBar's status union ('disconnected' → 'offline').
  const titleBarStatus: 'connected' | 'connecting' | 'auth-failed' | 'offline' =
    connectionStatus === 'connected'
      ? 'connected'
      : connectionStatus === 'connecting'
        ? 'connecting'
        : connectionStatus === 'auth-failed'
          ? 'auth-failed'
          : 'offline';

  return {
    fontsLoaded,
    insets,
    client: activeClient,
    serverIp,
    setServerIp,
    port,
    setPort,
    password,
    setPassword,
    passwordRef,
    setupMode,
    setSetupMode,
    confirmPassword,
    setConfirmPassword,
    testStatus,
    setTestStatus,
    isConfiguring,
    setIsConfiguring,
    profiles,
    storeError,
    loadProfiles,
    openAddHost,
    openEditHost,
    removeHost,
    saveHostConnection,
    updateProfile,
    reorderHosts,
    clientFor,
    serverSettingsHost,
    serverSettingsClient,
    serverSettingsOpen: serverSettingsHostId !== null && !isConfiguring,
    openServerSettings: (hostId: string) => {
      setServerSettingsHostId(hostId);
      setIsConfiguring(true);
    },
    closeServerSettings: () => setServerSettingsHostId(null),
    saveServerIdentity: (identity: { name: string; color: string }) =>
      serverSettingsHostId ? updateIdentity(serverSettingsHostId, identity) : Promise.resolve(),
    saveHostIdentity: updateIdentity,
    replaceStoredPassword,
    connectionStatus,
    hasConnected,
    mouseEnabled,
    toggleMouseEnabled,
    notificationsEnabled,
    toggleNotificationsEnabled,
    testNotification,
    ctxMenu,
    setCtxMenu,
    updateInfo,
    setUpdateInfo,
    pendingUpdate,
    updateProgress,
    setUpdateProgress,
    updating,
    setUpdating,
    ctrlArmed,
    setCtrlArmed,
    utilityPage,
    setUtilityPage,
    selectionViewOpen,
    setSelectionViewOpen,
    menuOpen,
    setMenuOpen,
    renameModalOpen,
    setRenameModalOpen,
    renameText,
    setRenameText,
    appearanceModalOpen,
    setAppearanceModalOpen,
    searchQuery,
    setSearchQuery,
    searchInputRef,
    snippets,
    setSnippets,
    snippetsModalOpen,
    setSnippetsModalOpen,
    snippetDraft,
    setSnippetDraft,
    activeId,
    activeHostId,
    drawerOpen,
    setDrawerOpen,
    drawerSessions,
    healthByHost,
    deepLinkNotice,
    dismissDeepLinkNotice: () => setDeepLinkNotice(null),
    presentations,
    activePresentation,
    activePresentationId,
    fileView,
    fileLoading,
    openFile,
    closeFile,
    openDiffFileLine,
    diffOpen,
    changeSummary,
    repoStatus,
    diffSelectedPath,
    diffText,
    diffTruncated,
    diffLoading,
    diffImage,
    openDiff,
    closeDiff,
    selectDiffFile,
    deselectDiffFile,
    diffMode,
    stageFile,
    unstageFile,
    discardFile,
    stageAllFiles,
    unstageAllFiles,
    discardAllFiles,
    toggleHunk,
    commitStagedChanges,
    undoLastCommit,
    pushChanges,
    historyEntries,
    historyCommit,
    loadGitLog,
    selectCommit,
    diffSideBySide,
    toggleDiffSideBySide,
    gitDrawerLeftWidthKey: KEY_GIT_DRAWER_LEFT_WIDTH,
    reviewDiffs,
    loadReviewDiffs,
    retryReviewDiff,
    selectTerminal,
    selectPresentation,
    closePresentation,
    refreshPresentations,
    refreshHost,
    inputRef,
    fontSize,
    setFontSize,
    lineHeight,
    entryFor,
    terminalViewRef,
    hydrateRenderer,
    onRendererResize,
    onRendererSelection,
    wsSend,
    resetTerminal,
    switchTo,
    newTerminal,
    killActiveOr,
    changeFontSize,
    persistSnippets,
    addSnippet,
    removeSnippet,
    sendSnippet,
    refreshSessions,
    testConnection,
    saveConfig,
    sendTyped,
    sendKey,
    sendPaste,
    sendProgram,
    cursorSeq,
    getFullText,
    searchText,
    openSelectionView,
    copySelection,
    selectAllTerminal,
    handlePaste,
    disposePending,
    checkForUpdatesManual,
    startUpdate,
    downloadUpdate,
    dismissUpdate,
    activeName,
    activeBellCount,
    upPct,
    upLabel,
    openRename,
    submitRename,
    hardResetSession,
    titleBarStatus,
    jumpPrompt,
    uploadFile,
    pickAndUploadImage,
    fontFamily,
    changeFontFamily,
  };
}
