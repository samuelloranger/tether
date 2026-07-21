import Feather from '@expo/vector-icons/Feather';
import { FiraCode_400Regular } from '@expo-google-fonts/fira-code/400Regular';
import { useFonts } from '@expo-google-fonts/fira-code/useFonts';
import { JetBrainsMono_400Regular } from '@expo-google-fonts/jetbrains-mono/400Regular';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  Text,
  type TextInput,
  type TextStyle,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppTheme } from './AppThemeProvider';
import { httpBase, validateAddress, wsUrl } from './address';
import { ConfigScreen } from './ConfigScreen';
import { ConnectionBanner } from './ConnectionBanner';
import { ContextMenu } from './ContextMenu';
import { ArrowCluster } from './Dpad';
import { shouldForwardToTerminal } from './desktopFocusGuard';
import { COPY, keyToBytes, PASTE } from './desktopKeys';
import {
  DEFAULT_DESKTOP_NAVIGATION_MODE,
  DESKTOP_NAVIGATION_STORAGE_KEY,
  type DesktopNavigationMode,
  parseDesktopNavigationMode,
  reservedNavigationWidth,
} from './desktopNavigation';
import { ensureNotificationPermission, notify as sendNativeNotification } from './desktopNotify';
import {
  fetchUpdate,
  installUpdate,
  openExternalUrl,
  openReleasesPage,
  type PendingUpdate,
} from './desktopUpdate';
import { confirmAction, notify } from './dialog';
import { isImagePath } from './diffModel';
import { injectDragRegionStyles } from './dragRegion';
import type { FileView } from './fileView';
import { applyFieldChange, SENT } from './input';
import type { LinkTarget } from './links';
import { mouseSeq } from './mouseSeq';
import { OverflowMenu } from './OverflowMenu';
import { isDesktop, isMacDesktop } from './platform';
import { type Presentation, pickAutoSelectPreview } from './presentations';
import { SelectionView } from './SelectionView';
import type { DrawerSession } from './SessionDrawer';
import { RenameModal, SnippetsModal } from './SessionModals';
import { authHeaders, getPassword, setPassword as persistPassword } from './secureConfig';
import { nextTermId, SessionCache, type SessionEntry } from './sessionCache';
import { shellQuote } from './shell';
import { createStyles } from './styles';
import { TermRow } from './TermRow';
import TitleBar from './TitleBar';
import { type CellStyle, type RenderRow, setTheme, TerminalEmulator } from './terminal';
import { UpdateModal } from './UpdateModal';
import { UtilityBar } from './UtilityBar';
import { openTerminalSocket, type TerminalSocket } from './wsTransport';

// Constants for async storage keys
const KEY_SERVER_IP = 'tether_server_ip';
const KEY_PORT = 'tether_port';
const KEY_SESSION_ID = 'tether_session_id';
const KEY_FONT = 'tether_font_size';
const KEY_SNIPPETS = 'tether_snippets';
const KEY_MONO_FONT = 'tether_mono_font';

// Fetches raw image bytes with the auth header <Image> can't attach itself,
// and hands back a data URI so the same code path works native and web.
async function fetchDiffImageUri(
  url: string,
  headers: Record<string, string>,
): Promise<string | null> {
  const res = await fetch(url, { headers });
  if (!res.ok) return null;
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('failed to read image'));
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(blob);
  });
}

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
  const styles = useMemo(() => createStyles(theme.colors), [theme.colors]);

  // Connection states
  const [serverIp, setServerIp] = useState('192.168.50.30');
  const [port, setPort] = useState('8085');
  const [password, setPassword] = useState('');
  const passwordRef = useRef('');
  useEffect(() => {
    passwordRef.current = password;
  }, [password]);
  // First-run pairing: 'unknown' until we probe /api/status; 'create' = server has
  // no password yet (TOFU set); 'enter' = server already paired.
  const [setupMode, setSetupMode] = useState<'unknown' | 'create' | 'enter'>('unknown');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [testStatus, setTestStatus] = useState<
    { kind: 'idle' } | { kind: 'testing' } | { kind: 'ok' } | { kind: 'error'; msg: string }
  >({ kind: 'idle' });

  // UI states
  const [isConfiguring, setIsConfiguring] = useState(true);
  // Tracks whether we've ever connected — reopening Settings must not tear the
  // socket down; only an actual address/port change (in saveConfig) reconnects it.
  const [ready, setReady] = useState(false);
  const readyRef = useRef(false);
  const lastConnectedRef = useRef({ ip: serverIp, port });
  const [connectionStatus, setConnectionStatus] = useState<
    'connecting' | 'connected' | 'disconnected' | 'auth-failed'
  >('disconnected');
  // Mirror for use inside long-lived WS handlers (onClose) that would otherwise
  // capture a stale connectionStatus and clobber an auth-failed verdict.
  const connectionStatusRef = useRef(connectionStatus);
  connectionStatusRef.current = connectionStatus;
  // Distinguishes a first-ever connect ("Connecting…") from a dropped-and-retrying
  // socket ("Reconnecting…") so the banner never overclaims on the very first try.
  const hasConnectedRef = useRef(false);
  const [screen, setScreen] = useState<RenderRow[]>([]);
  const [inputText, setInputText] = useState(SENT);
  // Mirrors the field's last value so onChangeText can diff against it.
  const prevValueRef = useRef(SENT);
  // Set when handleKeyPress has already emitted a Ctrl-combo byte, so the
  // following onChangeText absorbs that char without re-sending it.
  const skipNextChangeRef = useRef(false);
  const [termHeight, setTermHeight] = useState(0);
  const [mouseOn, setMouseOn] = useState(false);
  // Desktop right-click menu anchor (null when closed).
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  // Desktop self-update modal: version info when an update is pending, live
  // download progress while installing.
  const [updateInfo, setUpdateInfo] = useState<{
    version: string;
    current: string;
    canSelfInstall: boolean;
  } | null>(null);
  const pendingUpdate = useRef<PendingUpdate | null>(null);
  const [updateProgress, setUpdateProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  const [updating, setUpdating] = useState(false);
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const [selectionViewOpen, setSelectionViewOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renameModalOpen, setRenameModalOpen] = useState(false);
  const [renameText, setRenameText] = useState('');
  const [appearanceModalOpen, setAppearanceModalOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<TextInput | null>(null);
  const [snippets, setSnippets] = useState<string[]>([]);
  const [snippetsModalOpen, setSnippetsModalOpen] = useState(false);
  const [snippetDraft, setSnippetDraft] = useState('');

  // Multi-session state
  const disconnectRef = useRef<(id: string) => void>(() => {});
  const cache = useRef(new SessionCache(3, (id) => disconnectRef.current(id))).current;
  const [activeId, setActiveId] = useState('term-1');
  const activeIdRef = useRef('term-1'); // for stale-closure-free access in ws handlers
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerSessions, setDrawerSessions] = useState<DrawerSession[]>([]);
  const [presentations, setPresentations] = useState<Presentation[]>([]);
  const [activePresentationId, setActivePresentationId] = useState<string | null>(null);
  const [fileView, setFileView] = useState<FileView | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const [, setGitSummaryVersion] = useState(0);
  const [diffSelectedPath, setDiffSelectedPath] = useState<string | null>(null);
  const [diffText, setDiffText] = useState<string | null>(null);
  const [diffTruncated, setDiffTruncated] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffImage, setDiffImage] = useState<{ old: string | null; new: string | null } | null>(
    null,
  );
  const seenPresentationIds = useRef(new Set<string>());
  const presentationsPrimed = useRef(false);
  const [desktopNavigationMode, setDesktopNavigationMode] = useState<DesktopNavigationMode>(
    DEFAULT_DESKTOP_NAVIGATION_MODE,
  );

  useEffect(() => {
    setTheme(theme.terminal);
    const active = cache.get(activeIdRef.current);
    if (active) setScreen(active.term.getSnapshot());
  }, [theme, cache]);

  // References
  // Per-session terminal sockets, abstracted over platform (RN WebSocket on
  // mobile, Tauri Rust bridge on desktop — see wsTransport). Each cached
  // session (cap 3, LRU) keeps its own entry so background tabs can stay live;
  // `gen` invalidates the handlers of a superseded connection for that id,
  // `open` gates sends to that id's socket.
  type ConnState = {
    sock: TerminalSocket | null;
    gen: number;
    open: boolean;
    reconnectTimeout: any;
    retry: number;
    ping: any;
    lastSeen: number;
  };
  const connections = useRef(new Map<string, ConnState>()).current;
  const connState = (id: string): ConnState => {
    let s = connections.get(id);
    if (!s) {
      s = {
        sock: null,
        gen: 0,
        open: false,
        reconnectTimeout: null,
        retry: 0,
        ping: null,
        lastSeen: 0,
      };
      connections.set(id, s);
    }
    return s;
  };

  // Exponential backoff, capped, with jitter — so N tabs don't retry in lockstep
  // and a downed server isn't hit at a steady rate per tab forever.
  const backoffDelay = (attempt: number): number => {
    const base = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
    return base / 2 + Math.floor(Math.random() * (base / 2));
  };
  const listRef = useRef<FlatList<RenderRow> | null>(null);
  const inputRef = useRef<TextInput | null>(null);
  const autoScroll = useRef(true);
  // True while the current touch has scrolled the list, so a scroll-release
  // isn't misread as a tap that focuses the input and pops the keyboard.
  const scrolledRef = useRef(false);
  const lastContentHeight = useRef(0);
  const [blinkOn, setBlinkOn] = useState(true);
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled().then((v) => {
      if (mounted) setReduceMotion(v);
    });
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (v) =>
      setReduceMotion(v),
    );
    return () => {
      mounted = false;
      sub.remove();
    };
  }, []);
  useEffect(() => {
    if (reduceMotion) {
      setBlinkOn(true); // steady caret, no interval
      return;
    }
    const iv = setInterval(() => setBlinkOn((v) => !v), 530);
    return () => clearInterval(iv);
  }, [reduceMotion]);
  const renderScheduled = useRef(false);
  const renderTimer = useRef<any>(null);
  const mouseOnRef = useRef(false); // stable mirror of mouseOn for the pan handler
  const wheelAccum = useRef(0);
  const lastDy = useRef(0);

  // --- Terminal sizing ---
  // Auto-fit BOTH cols and rows to the screen at a readable font so the shell/TUI
  // fills the viewport with no wrapping and no horizontal scroll. The remote PTY
  // is resized to match. CHAR_RATIO ~ monospace advance width / font size.
  const { width: winWidth } = useWindowDimensions();
  const CHAR_RATIO = 0.6;
  const [fontSize, setFontSize] = useState(11);
  const [fontFamily, setFontFamily] = useState('FiraCode_400Regular');
  const lineHeight = Math.round(fontSize * 1.3);
  // Desktop docks a fixed-width sidebar, so the terminal pane is narrower than
  // the window — fit the grid (and the PTY resize) to the pane, not the window,
  // or the rightmost columns overflow off-screen.
  const paneWidth = isDesktop
    ? Math.max(120, winWidth - reservedNavigationWidth(desktopNavigationMode))
    : winWidth;
  const gridWidth = paneWidth - 12;
  const numCols = Math.max(20, Math.floor(gridWidth / (fontSize * CHAR_RATIO)));
  const numRows = termHeight ? Math.max(6, Math.floor((termHeight - 12) / lineHeight)) : 24;

  // Helper to get/create the cache entry for a given id, sized to the current grid.
  const entryFor = (id: string): SessionEntry =>
    cache.touch(id, () => {
      const term = new TerminalEmulator(numCols || 80, numRows || 24);
      // Backgrounded sessions do hold a live socket now, but only the active
      // tab is allowed to send input — route everyone else's replies nowhere.
      term.onReply = (text) => {
        if (id === activeIdRef.current) wsSend({ type: 'input', text });
      };
      term.onClipboardWrite = (text) => {
        // Guard like onReply: now that background tabs stay live, an OSC 52
        // sequence arriving in a backgrounded tab must not silently overwrite
        // the device clipboard while the user is looking at a different tab.
        if (id === activeIdRef.current) void Clipboard.setStringAsync(text).catch(() => {});
      };
      return { term, sinceId: 0, lastAppliedId: 0, diffSummary: { files: [] } };
    });

  // Send only when the socket is actually OPEN. `connectionStatus` (React state)
  // lags the real socket state — e.g. mid-switch the new socket is CONNECTING —
  // so guarding on it throws INVALID_STATE_ERR. readyState is the source of truth.
  const wsSend = (obj: unknown) => {
    const st = connections.get(activeIdRef.current);
    if (st?.open && st.sock) st.sock.send(JSON.stringify(obj));
  };

  // When the remote enables mouse reporting (TUIs like Claude Code), translate
  // vertical swipes into scroll-wheel events so the app scrolls its own history.
  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) =>
        mouseOnRef.current && Math.abs(g.dy) > Math.abs(g.dx) && Math.abs(g.dy) > 4,
      onMoveShouldSetPanResponderCapture: (_, g) =>
        mouseOnRef.current && Math.abs(g.dy) > Math.abs(g.dx) && Math.abs(g.dy) > 4,
      onPanResponderGrant: () => {
        lastDy.current = 0;
        wheelAccum.current = 0;
      },
      onPanResponderMove: (_, g) => {
        const STEP = 22;
        const delta = g.dy - lastDy.current;
        lastDy.current = g.dy;
        wheelAccum.current += delta;
        const e = cache.get(activeIdRef.current);
        const wheel = (btn: number) => {
          const col = Math.max(1, Math.floor((e?.term.cols ?? 80) / 2));
          const row = Math.max(1, Math.floor((e?.term.rows ?? 24) / 2));
          wsSend({ type: 'input', text: mouseSeq(btn, col, row, e?.term.mouseSgr ?? false) });
        };
        while (wheelAccum.current >= STEP) {
          wheel(64);
          wheelAccum.current -= STEP;
        } // drag down → older
        while (wheelAccum.current <= -STEP) {
          wheel(65);
          wheelAccum.current += STEP;
        } // drag up → newer
      },
    }),
  ).current;

  // Coalesce many PTY chunks into one render per frame.
  const scheduleRender = () => {
    if (renderScheduled.current) return;
    renderScheduled.current = true;
    renderTimer.current = setTimeout(
      () => {
        renderScheduled.current = false;
        const e = cache.get(activeIdRef.current);
        if (!e) return;
        setScreen(e.term.getSnapshot());
        if (e.term.mouseOn !== mouseOnRef.current) {
          mouseOnRef.current = e.term.mouseOn;
          setMouseOn(e.term.mouseOn);
        }
      },
      isDesktop ? 16 : 33,
    ); // 60fps on desktop (no battery cost); 30fps on mobile halves render load
  };

  const resetTerminal = () => {
    const e = cache.get(activeIdRef.current);
    if (e) {
      e.term.reset();
      e.sinceId = 0;
      e.lastAppliedId = 0;
      setScreen(e.term.getSnapshot());
      lastContentHeight.current = 0;
    }
  };

  // Parse one server frame into the session's emulator. Shared by both transports.
  const applyWsMessage = (id: string, data: string) => {
    try {
      const msg = JSON.parse(data);
      const ent = cache.get(id);
      if (!ent) return;
      if (msg.type === 'diff' && Array.isArray(msg.summary?.files)) {
        ent.diffSummary = { files: msg.summary.files };
        if (id === activeIdRef.current) setGitSummaryVersion((version) => version + 1);
      } else if (msg.type === 'output') {
        // Dedup: the server replays logs with ids > sinceId on (re)connect.
        // Every output frame carries an id; a frame without one is malformed and
        // must be dropped, else it would re-write verbatim on every replay.
        if (typeof msg.id !== 'number') return;
        if (msg.id <= ent.lastAppliedId) return;
        ent.lastAppliedId = msg.id;
        ent.sinceId = msg.id;
        ent.term.write(msg.chunk);
        if (id === activeIdRef.current) scheduleRender();
      } else if (msg.type === 'exit') {
        const code = typeof msg.exitCode === 'number' ? ` with code ${msg.exitCode}` : '';
        ent.term.write(`\r\n\x1b[31m[Process exited${code}]\x1b[0m\r\n`);
        if (id === activeIdRef.current) scheduleRender();
      } else if (msg.type === 'reset') {
        // Server pruned past our sinceId — replay would have a hole. Wipe and
        // let the full replay that follows rebuild the screen from scratch.
        ent.term.reset();
        ent.sinceId = 0;
        ent.lastAppliedId = 0;
        if (id === activeIdRef.current) scheduleRender();
      }
    } catch (err) {
      console.error('ws message error:', err);
    }
  };

  // Each cached session (cap 3, LRU) keeps its own live socket instead of the
  // app owning one global connection torn down on every tab switch. Only the
  // active tab's connectionStatus surfaces in the titlebar; background tabs
  // reconnect on their own (gated on still being cache-resident, not on being
  // active) so they keep receiving output while backgrounded.
  const connect = (id: string) => {
    disconnect(id); // clean slate: tear down any stale entry for this id first
    lastConnectedRef.current = { ip: serverIp, port };
    const e = entryFor(id);
    const st = connState(id);
    if (id === activeIdRef.current) setConnectionStatus('connecting');
    const url = wsUrl(serverIp, port, {
      sessionId: id,
      sinceId: e.sinceId,
      cols: numCols,
      rows: numRows,
    });

    // Each connect bumps this id's generation; a superseded socket's late
    // callbacks are ignored (replaces the old `ws.current !== socket` check).
    const myGen = ++st.gen;
    const fresh = () => myGen === st.gen;

    st.sock = openTerminalSocket(url, passwordRef.current, {
      onOpen: () => {
        if (!fresh()) return;
        st.open = true;
        st.retry = 0; // success resets backoff
        if (id === activeIdRef.current) {
          hasConnectedRef.current = true;
          setConnectionStatus('connected');
        }
        // Keepalive: if no frame arrives for a while the socket is likely
        // half-open — force a close so the reconnect path runs instead of
        // silently dropping keystrokes into a dead pipe.
        st.lastSeen = Date.now();
        if (st.ping) clearInterval(st.ping);
        st.ping = setInterval(() => {
          if (Date.now() - st.lastSeen > 30_000) {
            try {
              st.sock?.close();
            } catch {}
          }
        }, 15_000);
      },
      onMessage: (data) => {
        st.lastSeen = Date.now();
        if (fresh()) applyWsMessage(id, data);
      },
      onClose: () => {
        if (!fresh()) return;
        st.open = false;
        if (st.ping) {
          clearInterval(st.ping);
          st.ping = null;
        }
        // The 4s HTTP poll is the auth authority. If it already declared the
        // password wrong, don't overwrite that verdict and don't reconnect —
        // reconnecting every few seconds would hammer the server forever and
        // never succeed until the user changes the password.
        if (connectionStatusRef.current === 'auth-failed') {
          st.retry = 0;
          return;
        }
        if (id === activeIdRef.current) setConnectionStatus('disconnected');
        if (readyRef.current && cache.has(id)) {
          st.reconnectTimeout = setTimeout(() => connect(id), backoffDelay(st.retry++));
        }
      },
    });
  };

  const disconnect = (id: string) => {
    const st = connections.get(id);
    if (!st) return;
    if (st.reconnectTimeout) {
      clearTimeout(st.reconnectTimeout);
      st.reconnectTimeout = null;
    }
    if (st.ping) {
      clearInterval(st.ping);
      st.ping = null;
    }
    st.gen++; // invalidate any in-flight handlers
    st.open = false;
    st.sock?.close();
    connections.delete(id);
    if (id === activeIdRef.current) setConnectionStatus('disconnected');
  };

  const disconnectAll = () => {
    for (const id of Array.from(connections.keys())) disconnect(id);
  };

  disconnectRef.current = disconnect;

  // Switch to a different session. Does NOT disconnect the tab being left —
  // it keeps streaming in the background as long as it's cache-resident.
  const switchTo = (id: string) => {
    setDrawerOpen(false);
    setFileView(null);
    closeDiff();
    if (id === activeIdRef.current) return;
    activeIdRef.current = id;
    setActiveId(id);
    AsyncStorage.setItem(KEY_SESSION_ID, id);
    const e = entryFor(id); // creates fresh if uncached; resizes handled by effect
    setScreen(e.term.getSnapshot()); // instant paint of last-known screen
    autoScroll.current = true;
    lastContentHeight.current = 0;
    const st = connections.get(id);
    if (st?.open) {
      setConnectionStatus('connected'); // already live — no reconnect flicker
    } else {
      connect(id);
    }
  };

  const newTerminal = () => {
    const existing = drawerSessions.map((s) => s.id);
    setActivePresentationId(null);
    switchTo(nextTermId(existing.length ? existing : cache.ids()));
  };

  const killActiveOr = async (id: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      await fetch(`${httpBase(serverIp, port)}/api/sessions/kill`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(passwordRef.current) },
        body: JSON.stringify({ id }),
      });
    } catch {}
    cache.delete(id);
    disconnect(id);
    const remaining = drawerSessions.filter((s) => s.id !== id).map((s) => s.id);
    await refreshSessions();
    if (id === activeIdRef.current) {
      setActivePresentationId(null);
      switchTo(remaining[0] ?? 'term-1');
    }
  };

  // Keep activeIdRef synced when activeId changes (belt-and-suspenders)
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  const changeFontSize = (delta: number) => {
    setFontSize((prev) => {
      const next = Math.min(24, Math.max(8, prev + delta));
      AsyncStorage.setItem(KEY_FONT, String(next));
      return next;
    });
  };

  useEffect(() => {
    if (!isDesktop) return;
    AsyncStorage.getItem(KEY_MONO_FONT)
      .then((font) => {
        if (font === 'FiraCode_400Regular' || font === 'JetBrainsMono_400Regular')
          setFontFamily(font);
      })
      .catch(() => {});
  }, []);

  const changeFontFamily = (font: string) => {
    if (!isDesktop || (font !== 'FiraCode_400Regular' && font !== 'JetBrainsMono_400Regular'))
      return;
    setFontFamily(font);
    AsyncStorage.setItem(KEY_MONO_FONT, font);
  };

  useEffect(() => {
    if (!isDesktop) return;
    AsyncStorage.getItem(DESKTOP_NAVIGATION_STORAGE_KEY)
      .then((value) => setDesktopNavigationMode(parseDesktopNavigationMode(value)))
      .catch(() => {});
  }, []);

  const selectDesktopNavigationMode = (mode: DesktopNavigationMode) => {
    setDesktopNavigationMode(mode);
    if (isDesktop) {
      AsyncStorage.setItem(DESKTOP_NAVIGATION_STORAGE_KEY, mode).catch(() => {});
    }
  };

  // Load persisted snippets once on mount.
  useEffect(() => {
    AsyncStorage.getItem(KEY_SNIPPETS)
      .then((v) => {
        if (!v) return;
        try {
          const parsed = JSON.parse(v);
          if (Array.isArray(parsed)) setSnippets(parsed.filter((s) => typeof s === 'string'));
        } catch {
          // ignore malformed storage
        }
      })
      .catch(() => {});
  }, []);

  const persistSnippets = (next: string[]) => {
    setSnippets(next);
    AsyncStorage.setItem(KEY_SNIPPETS, JSON.stringify(next));
  };

  const addSnippet = () => {
    const s = snippetDraft.trim();
    if (!s) return;
    persistSnippets([...snippets, s]);
    setSnippetDraft('');
  };

  const removeSnippet = (index: number) => {
    persistSnippets(snippets.filter((_, i) => i !== index));
  };

  const sendSnippet = (s: string) => {
    setSnippetsModalOpen(false);
    sendInput(s);
  };

  const refreshSessions = async () => {
    try {
      const res = await fetch(`${httpBase(serverIp, port)}/api/sessions`, {
        headers: authHeaders(passwordRef.current),
      });
      // The 4s poll doubles as auth surveillance: a 401 (e.g. server password
      // changed) flips the UI to a distinct "Wrong password." state.
      if (res.status === 401) {
        setConnectionStatus('auth-failed');
        return;
      }
      const rows = (await res.json()) as DrawerSession[];
      setDrawerSessions(rows);
    } catch {}
  };

  const refreshPresentations = async () => {
    try {
      const res = await fetch(`${httpBase(serverIp, port)}/api/presentations`, {
        headers: authHeaders(passwordRef.current),
      });
      if (res.status === 401) {
        setConnectionStatus('auth-failed');
        return;
      }
      if (!res.ok) return;
      const rows = (await res.json()) as Presentation[];
      // The first successful poll after mount/reconnect just primes the seen
      // set from whatever's already on the server — it must not treat every
      // pre-existing preview as newly-created and hijack the active view.
      if (!presentationsPrimed.current) {
        presentationsPrimed.current = true;
        seenPresentationIds.current = new Set(rows.map((preview) => preview.id));
        setPresentations(rows);
        return;
      }
      const newPreview = pickAutoSelectPreview(
        rows,
        seenPresentationIds.current,
        activeIdRef.current,
      );
      seenPresentationIds.current = new Set(rows.map((preview) => preview.id));
      setPresentations(rows);
      if (newPreview) setActivePresentationId(newPreview.id);
      else {
        setActivePresentationId((current) =>
          current && !rows.some((preview) => preview.id === current) ? null : current,
        );
      }
    } catch {}
  };

  const selectTerminal = (id: string) => {
    setActivePresentationId(null);
    switchTo(id);
  };

  const selectPresentation = (id: string) => {
    setFileView(null);
    closeDiff();
    setActivePresentationId(id);
  };

  const closePresentation = async (id: string) => {
    try {
      const res = await fetch(`${httpBase(serverIp, port)}/api/presentations/${id}`, {
        method: 'DELETE',
        headers: authHeaders(passwordRef.current),
      });
      if (!res.ok) return;
      if (activePresentationId === id) setActivePresentationId(null);
      await refreshPresentations();
    } catch {}
  };

  // Poll the session list and presentation metadata every 4s while foregrounded.
  useEffect(() => {
    if (isConfiguring) return;
    let iv: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (iv) return;
      refreshSessions();
      refreshPresentations();
      iv = setInterval(() => {
        refreshSessions();
        refreshPresentations();
      }, 4000);
    };
    const stop = () => {
      if (iv) {
        clearInterval(iv);
        iv = null;
      }
    };
    start();
    // Desktop: pause polling while the window is hidden/minimized and resume with
    // an immediate refresh on return, so we don't hammer the server in the tray
    // and the list is never stale when the window comes back.
    let onVis: (() => void) | undefined;
    if (isDesktop && typeof document !== 'undefined') {
      onVis = () => (document.hidden ? stop() : start());
      document.addEventListener('visibilitychange', onVis);
    }
    return () => {
      stop();
      if (onVis) document.removeEventListener('visibilitychange', onVis);
    };
  }, [isConfiguring, serverIp, port]);

  // Desktop: get notification permission out of the way at startup (eager,
  // not lazy on first trigger — product decision), independent of connection
  // state.
  useEffect(() => {
    if (isDesktop) void ensureNotificationPermission();
  }, []);

  // 1. Load saved config on mount
  useEffect(() => {
    async function loadConfig() {
      try {
        const [savedIp, savedPort, savedSession, savedPw, savedFont] = await Promise.all([
          AsyncStorage.getItem(KEY_SERVER_IP),
          AsyncStorage.getItem(KEY_PORT),
          AsyncStorage.getItem(KEY_SESSION_ID),
          getPassword(),
          AsyncStorage.getItem(KEY_FONT).catch(() => null),
        ]);

        if (savedIp) setServerIp(savedIp);
        if (savedPort) setPort(savedPort);
        if (savedSession) {
          setActiveId(savedSession);
          activeIdRef.current = savedSession;
        }
        if (savedPw) {
          setPassword(savedPw);
          passwordRef.current = savedPw;
        }
        const fontSize = Number(savedFont);
        if (Number.isFinite(fontSize) && fontSize >= 8 && fontSize <= 24) setFontSize(fontSize);
        // Auto-connect only when BOTH an address AND a password are stored. An
        // upgrading user with an address but no password stays on setup to enter
        // the now-required password (migration path).
        if (savedIp && savedPw) {
          lastConnectedRef.current = { ip: savedIp, port: savedPort || port };
          readyRef.current = true;
          setIsConfiguring(false);
          setReady(true);
        }
      } catch (e) {
        console.error('Failed to load configuration:', e);
      }
    }

    loadConfig();
    return () => {
      disconnectAll();
      if (renderTimer.current) clearTimeout(renderTimer.current);
    };
  }, []);

  // Size the emulator (and the remote PTY) to the on-screen grid so the shell
  // fills the viewport. Re-runs when the fit changes or the socket connects.
  useEffect(() => {
    cache.get(activeIdRef.current)?.term.resize(numCols, numRows);
    wsSend({ type: 'resize', cols: numCols, rows: numRows });
    scheduleRender();
  }, [numCols, numRows, connectionStatus, activeId]);

  // 2. Open the initial connection once the app becomes ready. Tab switches no
  // longer touch this effect — switchTo() connects the newly-active tab itself
  // if it isn't already live, and leaves every other resident tab's socket
  // alone. Only unmount or an address/port change (saveConfig) tears sockets
  // down wholesale.
  useEffect(() => {
    if (!ready) return;
    connect(activeIdRef.current);
    return () => disconnectAll();
  }, [ready]);

  // Stick to the bottom when the keyboard opens (view shrinks, no new content).
  useEffect(() => {
    const sub = Keyboard.addListener('keyboardDidShow', () => {
      autoScroll.current = true;
      listRef.current?.scrollToEnd({ animated: true });
    });
    return () => sub.remove();
  }, []);

  // Probe the server, then either create the first password (TOFU) or validate an
  // existing one — driving the setup screen to a testable "Reachable ✓" state.
  const testConnection = async () => {
    const v = validateAddress(serverIp, port);
    if (!v.ok) {
      setTestStatus({ kind: 'error', msg: v.reason });
      return;
    }
    setTestStatus({ kind: 'testing' });

    // 1. Does this server need a first-run password?
    let needsSetup: boolean;
    try {
      const res = await fetch(`${httpBase(serverIp, port)}/api/status`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error('status');
      needsSetup = Boolean((await res.json()).needsSetup);
    } catch {
      setTestStatus({ kind: 'error', msg: 'Unreachable — check the host and port.' });
      return;
    }
    setSetupMode(needsSetup ? 'create' : 'enter');

    if (!password) {
      setTestStatus({
        kind: 'error',
        msg: needsSetup ? 'Choose a password for this server.' : 'Enter the server password.',
      });
      return;
    }

    if (needsSetup) {
      // 2a. Create the password (one-time TOFU set).
      if (password !== confirmPassword) {
        setTestStatus({ kind: 'error', msg: 'Passwords do not match.' });
        return;
      }
      try {
        const res = await fetch(`${httpBase(serverIp, port)}/api/setup`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password }),
          signal: AbortSignal.timeout(5000),
        });
        if (res.status === 409) {
          setSetupMode('enter');
          setTestStatus({ kind: 'error', msg: 'Already set up. Enter the existing password.' });
          return;
        }
        if (!res.ok) throw new Error('setup');
        setTestStatus({ kind: 'ok' });
      } catch {
        setTestStatus({ kind: 'error', msg: 'Setup failed — try again.' });
      }
      return;
    }

    // 2b. Validate an existing password against the authed health probe.
    try {
      const res = await fetch(`${httpBase(serverIp, port)}/api/health`, {
        headers: authHeaders(password),
        signal: AbortSignal.timeout(5000),
      });
      if (res.status === 401) {
        setTestStatus({ kind: 'error', msg: 'Wrong password.' });
        return;
      }
      if (!res.ok) {
        setTestStatus({ kind: 'error', msg: `Server error (${res.status}).` });
        return;
      }
      setTestStatus({ kind: 'ok' });
    } catch {
      setTestStatus({ kind: 'error', msg: 'Unreachable — check the host and port.' });
    }
  };

  // 3. Command interactions
  const saveConfig = async () => {
    try {
      await AsyncStorage.multiSet([
        [KEY_SERVER_IP, serverIp],
        [KEY_PORT, port],
        [KEY_SESSION_ID, activeId],
      ]);
      await persistPassword(password);
      const addressChanged =
        serverIp !== lastConnectedRef.current.ip || port !== lastConnectedRef.current.port;
      // A different server has never been connected to — reset so its first
      // attempt shows the honest "Connecting…" (not "Reconnecting… session kept").
      if (addressChanged) hasConnectedRef.current = false;
      setIsConfiguring(false);
      if (!readyRef.current) {
        readyRef.current = true;
        setReady(true);
      } else if (addressChanged) {
        // The server address changed — every resident tab's socket points at
        // the old host. Drop them all; only the active tab reconnects
        // immediately, the rest reconnect lazily on next visit (switchTo's
        // connect-if-not-open fallback).
        disconnectAll();
        resetTerminal();
        connect(activeIdRef.current);
      }
    } catch (e) {
      void notify('Error', 'Failed to save configuration', 'error');
    }
  };

  const sendInput = (text: string) => {
    wsSend({ type: 'input', text });
  };

  // Cursor keys (arrows/Home/End) encode as SS3 (ESC O x) when the active app has
  // DECCKM on, else CSI (ESC [ x). Used by the mobile key bar and shared with the
  // desktop keyboard mapper so both honour application-cursor mode.
  const cursorSeq = (final: string) =>
    `\x1b${cache.get(activeIdRef.current)?.term.applicationCursor ? 'O' : '['}${final}`;

  // Full plain-text transcript (visible screen + scrollback) for the
  // selectable view and the Copy All fallback.
  const getFullText = () =>
    screen
      .map((r) => r.runs.map((run) => run.text).join(''))
      .join('\n')
      .replace(/\n+$/, '');

  // Transcript filtered to lines matching the query — memoized: the previous
  // version re-split the whole scrollback on every keystroke and every render.
  const searchText = useMemo(() => {
    const full = getFullText();
    const q = searchQuery.trim().toLowerCase();
    if (!q) return full;
    return full
      .split('\n')
      .filter((line) => line.toLowerCase().includes(q))
      .join('\n');
  }, [screen, searchQuery]);

  // Scrolls the FlatList to the nearest prompt-start row in `dir`, using the
  // start/end of the currently-known scrollback as the search origin.
  const jumpPrompt = (dir: 1 | -1) => {
    const term = entryFor(activeIdRef.current).term;
    const snapshot = term.getSnapshot();
    const from = dir === 1 ? 0 : snapshot.length - 1;
    const target = term.jumpToPrompt(from, dir);
    if (target === null) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    listRef.current?.scrollToIndex({ index: target, animated: true });
  };

  const openSearch = () => {
    setMenuOpen(false);
    setSearchQuery('');
    setSelectionViewOpen(true);
    setTimeout(() => searchInputRef.current?.focus(), 250);
  };

  // Long-press the terminal to open a fullscreen, natively-selectable view
  // of everything currently visible + scrollback, instead of copying
  // straight to the clipboard.
  const openSelectionView = () => {
    if (!getFullText()) return;
    setSelectionViewOpen(true);
  };

  // Desktop context-menu actions.
  const copySelection = async () => {
    const sel = typeof window !== 'undefined' ? window.getSelection()?.toString() : '';
    // Fall back to the whole displayed transcript when nothing is selected.
    const text = sel || getFullText();
    if (text) await Clipboard.setStringAsync(text);
  };

  const selectAllTerminal = () => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    const el = document.getElementById('tether-terminal');
    const sel = window.getSelection();
    if (!el || !sel) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
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
    const url = `${httpBase(serverIp, port)}/api/sessions/${activeIdRef.current}/upload`;
    try {
      let data: { ok: boolean; path?: string; error?: string };
      if (file instanceof Blob) {
        const form = new FormData();
        form.append('file', file, filename);
        const res = await fetch(url, {
          method: 'POST',
          headers: authHeaders(passwordRef.current),
          body: form,
        });
        data = await res.json();
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
            headers: authHeaders(passwordRef.current),
          });
          data = JSON.parse(result.body);
        } finally {
          try {
            staged.delete();
          } catch {}
        }
      }
      if (!data.ok) throw new Error(data.error || 'upload failed');
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      sendInput(shellQuote(data.path!));
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
      text = await Clipboard.getStringAsync();
    } catch {
      void notify('Paste failed', 'Could not read the clipboard.', 'error');
      return;
    }
    if (!text) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const e = cache.get(activeIdRef.current);
    sendInput(e?.term.bracketedPaste ? `\x1b[200~${text}\x1b[201~` : text);
  };

  // Type straight into the terminal: forward each keystroke to the PTY as it is
  // pressed (the shell echoes it back for display). The capture field is pinned
  // to a zero-width sentinel so nothing accumulates locally and Backspace keeps
  // firing on iOS even before anything is typed.
  const handleKeyPress = (e: { nativeEvent: { key: string } }) => {
    const key = e.nativeEvent.key;
    // Only Ctrl-combos are handled here now; all printable text and Backspace
    // are handled by the onChangeText delta (see handleChangeText).
    if (ctrlArmed) {
      setCtrlArmed(false);
      if (/^[a-zA-Z]$/.test(key)) {
        sendInput(String.fromCharCode(key.toUpperCase().charCodeAt(0) - 64));
        autoScroll.current = true;
        // The printed letter still lands in the field and will fire
        // onChangeText next — swallow it there instead of sending it literally.
        skipNextChangeRef.current = true;
      }
      // Non-letter while armed: fall through, modifier dropped.
    }
  };

  const resetField = () => {
    setInputText(SENT);
    prevValueRef.current = SENT;
  };

  // Every field mutation (typing, dictation, swipe, autocorrect, Backspace)
  // arrives here. Diff against the previous value and forward the delta.
  const handleChangeText = (next: string) => {
    if (skipNextChangeRef.current) {
      // A Ctrl-combo already emitted its byte; discard the trailing char and
      // re-anchor so the controlled value doesn't drift out of sync.
      skipNextChangeRef.current = false;
      resetField();
      return;
    }
    const { bytes, value } = applyFieldChange(prevValueRef.current, next);
    if (bytes) {
      sendInput(bytes);
      autoScroll.current = true;
    }
    // Keep the controlled value AND the diff baseline in lockstep — otherwise
    // React Native reverts the field to the old value and the next diff runs
    // against a stale prev (corrupting typing/dictation).
    setInputText(value);
    prevValueRef.current = value;
  };

  // Return key: send carriage return (raw-mode TUIs like Claude Code expect \r).
  const handleSend = () => {
    autoScroll.current = true;
    sendInput('\r');
    resetField();
  };

  // Desktop: install the window drag-region CSS once (custom title bar).
  useEffect(() => {
    if (isDesktop) injectDragRegionStyles();
  }, []);

  // Desktop: capture the physical keyboard globally and forward keystrokes to
  // the PTY (replacing the mobile utility bar). Skipped while a text field is
  // focused (config form, rename/snippet/search modals) so those still type
  // normally. Ctrl/Cmd+C copies an active selection or sends SIGINT; Ctrl/Cmd+V
  // pastes from the clipboard.
  useEffect(() => {
    if (
      !isDesktop ||
      isConfiguring ||
      presentations.some((preview) => preview.id === activePresentationId)
    )
      return;
    // True while an IME/dead-key composition is in progress (accented Latin
    // chars like é/ñ/ö on many layouts, or CJK candidate windows). Composition
    // is driven by compositionstart/end, not keydown — forwarding the raw
    // intermediate keydowns here would leak partial composition bytes to the
    // PTY. keydown is suppressed while composing; the final composed text is
    // sent once, from compositionend.
    //
    // Composition needs an actual focused, editable DOM element to attach to —
    // the terminal surface itself is a plain non-focusable View (see the
    // isDesktop branch in TerminalScreen.tsx), so these window-level listeners
    // alone would never fire for the real "click terminal, type" path. A
    // hidden TextInput (ref: inputRef) is rendered inside #tether-terminal on
    // desktop specifically as that composition target, focused on click
    // (TerminalScreen.tsx). Composition events bubble to window regardless of
    // which element they originate on, so listening here still works once that
    // target exists and has focus.
    let composing = false;

    const focused = () =>
      shouldForwardToTerminal(
        document.activeElement as (HTMLElement & { isContentEditable?: boolean }) | null,
        document.activeElement === document.body,
        !fileView && !diffOpen,
      );

    const onCompositionStart = () => {
      if (focused()) composing = true;
    };
    const onCompositionEnd = (e: CompositionEvent) => {
      if (!composing) return;
      composing = false;
      if (!focused()) return;
      if (e.data) {
        const ent = cache.get(activeIdRef.current);
        sendInput(ent?.term.bracketedPaste ? `\x1b[200~${e.data}\x1b[201~` : e.data);
        autoScroll.current = true;
      }
      // The composed text landed in the hidden desktop composition-target
      // input's own DOM value (composition was never preventDefault()'d so the
      // browser could compose into it) — clear it so the next composition
      // starts clean instead of accumulating.
      inputRef.current?.clear();
    };

    const onKey = (e: KeyboardEvent) => {
      // keyCode 229 is the legacy composing signal (older Safari/Firefox).
      if (composing || e.isComposing || e.keyCode === 229) return;
      if (!focused()) return;
      const appCursor = cache.get(activeIdRef.current)?.term.applicationCursor ?? false;
      const bytes = keyToBytes(e, appCursor, isMacDesktop);
      if (bytes == null) return;
      if (bytes === COPY) return; // let the browser copy the selection
      e.preventDefault();
      if (bytes === PASTE) {
        void handlePaste();
        return;
      }
      sendInput(bytes);
      autoScroll.current = true;
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('compositionstart', onCompositionStart);
    window.addEventListener('compositionend', onCompositionEnd);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('compositionstart', onCompositionStart);
      window.removeEventListener('compositionend', onCompositionEnd);
    };
    // sendInput/handlePaste delegate to refs, so a stable listener is fine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConfiguring, activePresentationId, presentations, fileView, diffOpen]);

  // Desktop: when the remote app enables mouse reporting (Claude Code, vim,
  // less…), the FlatList is frozen (scrollEnabled=false), so forward the wheel
  // as SGR mouse-wheel events and the app scrolls its own history. Outside mouse
  // mode we don't intercept, so the list scrolls natively.
  useEffect(() => {
    if (
      !isDesktop ||
      isConfiguring ||
      presentations.some((preview) => preview.id === activePresentationId)
    )
      return;
    let accum = 0;
    const onWheel = (e: WheelEvent) => {
      const el = document.getElementById('tether-terminal');
      if (!el || !(e.target instanceof Node) || !el.contains(e.target)) return;
      const term = cache.get(activeIdRef.current)?.term;
      if (!term?.mouseOn) return; // let the list scroll natively
      e.preventDefault();
      const STEP = 40;
      accum += e.deltaY;
      // Report the cell under the pointer (not the grid centre) so split-pane
      // TUIs (tmux, vim) route the scroll to the right pane. Derive the cell
      // from the element's rendered size — accurate regardless of font metrics.
      const cols = term.cols || 80;
      const rows = term.rows || 24;
      const rect = el.getBoundingClientRect();
      const col = Math.min(
        cols,
        Math.max(1, Math.floor((e.clientX - rect.left) / (rect.width / cols)) + 1),
      );
      const row = Math.min(
        rows,
        Math.max(1, Math.floor((e.clientY - rect.top) / (rect.height / rows)) + 1),
      );
      const send = (btn: number) =>
        wsSend({ type: 'input', text: mouseSeq(btn, col, row, term.mouseSgr) });
      while (accum >= STEP) {
        send(65); // wheel down → forward/newer
        accum -= STEP;
      }
      while (accum <= -STEP) {
        send(64); // wheel up → back/older
        accum += STEP;
      }
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => window.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConfiguring, activePresentationId, presentations]);

  // Desktop: check for a newer signed build once on launch. If one exists, open
  // the update modal; stay silent on "up to date" or an unreachable feed.
  useEffect(() => {
    if (!isDesktop) return;
    fetchUpdate()
      .then((u) => {
        if (u) {
          pendingUpdate.current = u;
          setUpdateInfo({
            version: u.version,
            current: u.current,
            canSelfInstall: u.canSelfInstall,
          });
        }
      })
      .catch(() => {});
  }, []);

  // Free the native Update resource behind a pending update (Rust resource-table
  // entries aren't GC'd, so an un-closed check leaks until exit).
  const disposePending = () => {
    pendingUpdate.current?.update.close().catch(() => {});
    pendingUpdate.current = null;
  };

  // Manual "Check for updates" (overflow menu): surface every outcome.
  const checkForUpdatesManual = async () => {
    try {
      disposePending(); // release any earlier pending update before replacing it
      const u = await fetchUpdate();
      if (u) {
        pendingUpdate.current = u;
        setUpdateInfo({ version: u.version, current: u.current, canSelfInstall: u.canSelfInstall });
      } else {
        void notify('Up to date', "You're running the latest version of Tether.");
      }
    } catch {
      void notify('Update check failed', 'Could not reach the update server.', 'error');
    }
  };

  const startUpdate = () => {
    const pending = pendingUpdate.current;
    if (!pending) return;
    setUpdating(true);
    setUpdateProgress({ done: 0, total: 0 });
    installUpdate(pending, (done, total) => setUpdateProgress({ done, total })).catch(() => {
      setUpdating(false);
      setUpdateInfo(null);
      disposePending();
      void notify('Update failed', 'The update could not be downloaded or installed.', 'error');
    });
  };

  // Package-managed installs (.deb/.rpm) can't self-install: open the releases
  // page so the user downloads the new package and reinstalls.
  const downloadUpdate = () => {
    void openReleasesPage();
    disposePending();
    setUpdateInfo(null);
  };

  const dismissUpdate = () => {
    if (updating) return; // don't let it close mid-install
    disposePending();
    setUpdateInfo(null);
    setUpdateProgress(null);
  };

  // Desktop: right-click the terminal for a Copy / Paste / Select All menu.
  useEffect(() => {
    if (
      !isDesktop ||
      isConfiguring ||
      presentations.some((preview) => preview.id === activePresentationId)
    )
      return;
    const onCtx = (e: MouseEvent) => {
      const el = document.getElementById('tether-terminal');
      if (!el || !(e.target instanceof Node) || !el.contains(e.target)) return;
      e.preventDefault();
      setCtxMenu({ x: e.clientX, y: e.clientY });
    };
    document.addEventListener('contextmenu', onCtx);
    return () => document.removeEventListener('contextmenu', onCtx);
  }, [isConfiguring, activePresentationId, presentations]);

  const activeName = drawerSessions.find((s) => s.id === activeId)?.name || activeId;
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
        const sessionId = activeIdRef.current;
        const query = new URLSearchParams({ path: target.path });
        const res = await fetch(
          `${httpBase(serverIp, port)}/api/sessions/${sessionId}/file?${query}`,
          {
            headers: authHeaders(passwordRef.current),
          },
        );
        const body = (await res.json().catch(() => ({}))) as {
          path?: string;
          content?: string;
          error?: string;
        };
        if (!res.ok || typeof body.path !== 'string' || typeof body.content !== 'string') {
          throw new Error(body.error || `Request failed (${res.status})`);
        }
        if (activeIdRef.current === sessionId) {
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
    [serverIp, port],
  );
  const closeDiff = useCallback(() => {
    setDiffOpen(false);
    setDiffSelectedPath(null);
    setDiffText(null);
    setDiffTruncated(false);
    setDiffImage(null);
  }, []);
  const deselectDiffFile = useCallback(() => {
    setDiffSelectedPath(null);
    setDiffText(null);
    setDiffTruncated(false);
    setDiffImage(null);
  }, []);
  const selectDiffFile = useCallback(
    async (filePath: string) => {
      setDiffSelectedPath(filePath);
      setDiffText(null);
      setDiffTruncated(false);
      setDiffImage(null);
      setDiffLoading(true);
      try {
        const sessionId = activeIdRef.current;
        const file = entryFor(sessionId).diffSummary.files.find((f) => f.path === filePath);
        if (file?.binary && isImagePath(filePath)) {
          const base = httpBase(serverIp, port);
          const query = new URLSearchParams({ path: filePath });
          const headers = authHeaders(passwordRef.current);
          const [oldUri, newUri] = await Promise.all([
            fetchDiffImageUri(
              `${base}/api/sessions/${sessionId}/diff/file?${query}&side=old`,
              headers,
            ),
            fetchDiffImageUri(
              `${base}/api/sessions/${sessionId}/diff/file?${query}&side=new`,
              headers,
            ),
          ]);
          setDiffImage({ old: oldUri, new: newUri });
          return;
        }
        const query = new URLSearchParams({ path: filePath });
        const res = await fetch(
          `${httpBase(serverIp, port)}/api/sessions/${sessionId}/diff?${query}`,
          {
            headers: authHeaders(passwordRef.current),
          },
        );
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
    [serverIp, port],
  );
  const openDiff = useCallback(() => {
    setDiffOpen(true);
    setDiffSelectedPath(null);
    setDiffText(null);
    setDiffTruncated(false);
    setDiffImage(null);
  }, []);
  // Peek (non-touching) so render stays pure — the active entry is already
  // MRU-resident from connect/switchTo; only the very first render (before any
  // touch) falls back to entryFor, which creates it.
  const activeEntry = cache.peek(activeId) ?? entryFor(activeId);
  const changeSummary = activeEntry.diffSummary;
  // Read live off the mutable emulator field — re-derives every render.
  const activeBellCount = activeEntry.term.bellCount;
  const activePromptReturnCount = activeEntry.term.promptReturnCount;

  // Desktop: native notification when a bell rings or a command finishes (new
  // shell prompt appears) while the window isn't focused. windowFocusedRef
  // tracks real OS focus — distinct from the visibilitychange listener
  // earlier in this file, which only catches minimize/hide, not "visible but
  // alt-tabbed away".
  const windowFocusedRef = useRef(true);
  useEffect(() => {
    if (!isDesktop || typeof window === 'undefined') return;
    const onFocus = () => {
      windowFocusedRef.current = true;
    };
    const onBlur = () => {
      windowFocusedRef.current = false;
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    };
  }, []);
  const prevBellCountForNotifyRef = useRef(0);
  const prevPromptReturnCountRef = useRef(0);
  useEffect(() => {
    if (!isDesktop) return;
    const bellFired = activeBellCount > prevBellCountForNotifyRef.current;
    const promptReturned = activePromptReturnCount > prevPromptReturnCountRef.current;
    prevBellCountForNotifyRef.current = activeBellCount;
    prevPromptReturnCountRef.current = activePromptReturnCount;
    if ((bellFired || promptReturned) && !windowFocusedRef.current) {
      void sendNativeNotification('Tether', bellFired ? 'Terminal bell' : 'Command finished');
    }
  }, [activeBellCount, activePromptReturnCount]);

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
      await fetch(`${httpBase(serverIp, port)}/api/sessions/rename`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(passwordRef.current) },
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
      await fetch(`${httpBase(serverIp, port)}/api/sessions/kill`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(passwordRef.current) },
        body: JSON.stringify({ id: activeId }),
      });
      connect(activeIdRef.current);
    } catch (e) {
      void notify('Error', 'Failed to kill session on the server', 'error');
    }
  };

  const onScroll = (e: any) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const contentHeight = contentSize.height;

    // If the content height changed, this scroll event is likely triggered by
    // new messages being added to the log/scrollback. Do not update autoScroll
    // status based on this transient offset (which hasn't caught up to the bottom yet).
    if (contentHeight !== lastContentHeight.current) {
      lastContentHeight.current = contentHeight;
      return;
    }

    const distanceFromBottom = contentHeight - layoutMeasurement.height - contentOffset.y;
    // Re-arm auto-scroll only at the true bottom; 40px "near bottom" used to
    // yank the viewport away while reading history during streaming output.
    autoScroll.current = distanceFromBottom < 8;
  };

  const renderRow = useCallback(
    ({ item }: { item: RenderRow }) => (
      <TermRow
        row={item}
        fontSize={fontSize}
        lineHeight={lineHeight}
        width={gridWidth}
        blinkOn={blinkOn}
        cursorStyle={(cache.peek(activeId) ?? entryFor(activeId)).term.cursorStyle}
        fontFamily={fontFamily}
        onOpenLink={openFile}
      />
    ),
    [fontSize, lineHeight, gridWidth, blinkOn, activeId, entryFor, cache, fontFamily, openFile],
  );

  // Map the connection state to the TitleBar's status union ('disconnected' → 'offline').
  const titleBarStatus: 'connected' | 'connecting' | 'auth-failed' | 'offline' =
    connectionStatus === 'connected'
      ? 'connected'
      : connectionStatus === 'connecting'
        ? 'connecting'
        : connectionStatus === 'auth-failed'
          ? 'auth-failed'
          : 'offline';

  // The scrollable terminal grid, shared by the desktop and mobile surfaces.
  const terminalGrid = (
    <FlatList
      ref={listRef}
      style={{ flex: 1 }}
      contentContainerStyle={styles.terminalContent}
      data={screen}
      renderItem={renderRow}
      keyExtractor={(_, i) => String(i)}
      // Rows are a fixed lineHeight, so give the list exact offsets — otherwise
      // RN-web's VirtualizedList estimates them and scrollToEnd lands a row short.
      getItemLayout={(_, index) => ({ length: lineHeight, offset: lineHeight * index, index })}
      onScroll={onScroll}
      onScrollBeginDrag={() => {
        autoScroll.current = false;
        scrolledRef.current = true;
      }}
      scrollEventThrottle={100}
      scrollEnabled={!mouseOn}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="none"
      onContentSizeChange={(_w, h) => {
        // Scroll to the height reported by THIS event, not scrollToEnd (which reads
        // the list's internal content length — that lags a row behind a just-
        // appended row, landing the view short). Offset past max is clamped to the
        // true bottom.
        if (autoScroll.current) listRef.current?.scrollToOffset({ offset: h, animated: false });
      }}
      ListEmptyComponent={
        connectionStatus === 'connected' ? (
          <Text style={styles.terminalEmpty}>Connected. Type a command to begin.</Text>
        ) : null
      }
      initialNumToRender={40}
      windowSize={11}
      removeClippedSubviews
    />
  );

  return {
    fontsLoaded,
    insets,
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
    setReady,
    readyRef,
    lastConnectedRef,
    connectionStatus,
    setConnectionStatus,
    hasConnectedRef,
    screen,
    setScreen,
    inputText,
    setInputText,
    prevValueRef,
    skipNextChangeRef,
    termHeight,
    setTermHeight,
    mouseOn,
    setMouseOn,
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
    cache,
    activeId,
    setActiveId,
    activeIdRef,
    drawerOpen,
    setDrawerOpen,
    drawerSessions,
    setDrawerSessions,
    presentations,
    activePresentation,
    activePresentationId,
    fileView,
    fileLoading,
    openFile,
    closeFile,
    diffOpen,
    changeSummary,
    diffSelectedPath,
    diffText,
    diffTruncated,
    diffLoading,
    diffImage,
    openDiff,
    closeDiff,
    selectDiffFile,
    deselectDiffFile,
    selectTerminal,
    selectPresentation,
    closePresentation,
    refreshPresentations,
    desktopNavigationMode,
    selectDesktopNavigationMode,
    listRef,
    inputRef,
    autoScroll,
    scrolledRef,
    lastContentHeight,
    blinkOn,
    setBlinkOn,
    reduceMotion,
    setReduceMotion,
    renderScheduled,
    mouseOnRef,
    wheelAccum,
    lastDy,
    CHAR_RATIO,
    fontSize,
    setFontSize,
    lineHeight,
    paneWidth,
    gridWidth,
    numCols,
    numRows,
    entryFor,
    wsSend,
    panResponder,
    scheduleRender,
    resetTerminal,
    applyWsMessage,
    connect,
    disconnect,
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
    sendInput,
    cursorSeq,
    getFullText,
    searchText,
    openSearch,
    openSelectionView,
    copySelection,
    selectAllTerminal,
    handlePaste,
    handleKeyPress,
    resetField,
    handleChangeText,
    handleSend,
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
    onScroll,
    renderRow,
    terminalGrid,
    titleBarStatus,
    jumpPrompt,
    uploadFile,
    pickAndUploadImage,
    fontFamily,
    changeFontFamily,
  };
}
