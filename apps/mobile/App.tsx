import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  ScrollView,
  FlatList,
  Pressable,
  PanResponder,
  KeyboardAvoidingView,
  Keyboard,
  Platform,
  Alert,
  ActivityIndicator,
  useWindowDimensions,
  Modal,
  Linking,
  AccessibilityInfo,
  type TextStyle,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import Feather from '@expo/vector-icons/Feather';
import { useFonts } from '@expo-google-fonts/fira-code/useFonts';
import { FiraCode_400Regular } from '@expo-google-fonts/fira-code/400Regular';
import { TerminalEmulator, type RenderRow, type CellStyle } from './src/terminal';
import { splitRunByLinks, urlColumns } from './src/links';
import { SessionCache, nextTermId, type SessionEntry } from './src/sessionCache';
import { SessionDrawer, PANEL_W, type DrawerSession } from './src/SessionDrawer';
import { applyFieldChange, SENT } from './src/input';
import { getPassword, setPassword as persistPassword, authHeaders } from './src/secureConfig';
import { httpBase, wsUrl, validateAddress } from './src/address';
import { openTerminalSocket, type TerminalSocket } from './src/wsTransport';
import { keyToBytes, COPY, PASTE } from './src/desktopKeys';

// The web bundle only ever runs inside the Tauri desktop shell (plain browsers
// can't authenticate the WS). So Platform.OS === 'web' means "desktop", and we
// use it to swap the mobile chrome (utility bar, overlay drawer, tap-to-type)
// for desktop conventions (physical keyboard, docked sidebar, mouse selection).
const isDesktop = Platform.OS === 'web';

// Constants for async storage keys
const KEY_SERVER_IP = 'tether_server_ip';
const KEY_PORT = 'tether_port';
const KEY_SESSION_ID = 'tether_session_id';
const KEY_FONT = 'tether_font_size';
const KEY_SNIPPETS = 'tether_snippets';

function runToStyle(s: CellStyle, caretOn = true): TextStyle {
  const style: TextStyle = {};
  if (s.fg) style.color = s.fg;
  if (s.bg) style.backgroundColor = s.bg;
  if (s.bold) style.fontWeight = 'bold';
  if (s.dim) style.opacity = 0.55;
  if (s.italic) style.fontStyle = 'italic';
  if (s.underline && s.strike) style.textDecorationLine = 'underline line-through';
  else if (s.underline) style.textDecorationLine = 'underline';
  else if (s.strike) style.textDecorationLine = 'line-through';
  if (s.caret && caretOn) {
    // Block caret: accent background, dark glyph for contrast.
    style.backgroundColor = '#818cf8';
    style.color = '#0b0f19';
  }
  return style;
}

// Memoized terminal row. Props are shallow-compared; the emulator reuses the
// same `row` object for unchanged lines, so continuous TUI repaints only
// re-render the handful of rows that actually changed.
const rowHasCaret = (row: RenderRow) => row.runs.some((r) => r.style.caret);

const TermRow = React.memo(
  function TermRow({
    row,
    fontSize,
    lineHeight,
    width,
    blinkOn,
  }: {
    row: RenderRow;
    fontSize: number;
    lineHeight: number;
    width: number;
    blinkOn: boolean;
  }) {
    // Column → full URL, from spans the emulator resolved across soft-wrapped
    // rows. A wrapped link's fragments each carry the WHOLE url, so tapping any
    // fragment (on either row) opens the complete link.
    const urlAt = urlColumns(row.links);

    let col = 0;
    return (
      <View style={{ height: lineHeight, width, overflow: 'hidden' }}>
        <Text
          style={[styles.termLine, { fontSize, lineHeight, width }]}
          numberOfLines={1}
          selectable={isDesktop}
        >
          {row.runs.map((run, i) => {
            const st = runToStyle(run.style, blinkOn);
            const segs = splitRunByLinks(run.text, col, urlAt);
            col += run.text.length;
            return segs.map((seg, j) =>
              seg.url ? (
                <Text
                  key={`${i}-${j}`}
                  style={[st, styles.link]}
                  onPress={() => Linking.openURL(seg.url!)}
                >
                  {seg.text}
                </Text>
              ) : (
                <Text key={`${i}-${j}`} style={st}>
                  {seg.text}
                </Text>
              ),
            );
          })}
        </Text>
      </View>
    );
  },
  (prev, next) =>
    prev.row === next.row &&
    prev.fontSize === next.fontSize &&
    prev.lineHeight === next.lineHeight &&
    prev.width === next.width &&
    // Blink only invalidates the row that actually contains the caret.
    (prev.blinkOn === next.blinkOn || !rowHasCaret(next.row)),
);

// Directional pad, styled after the arrow clusters in Blink/Termius: one
// capsule with three segments (left | up-over-down | right) instead of four
// separate buttons — reads as a single control and halves the width four
// loose buttons would cost in an already-tight toolbar.
// Press-and-hold repeat for navigation keys: fire once on press, then repeat
// after 350ms at 60ms — mirrors hardware key-repeat.
function RepeatBtn({
  onFire,
  style,
  label,
  children,
}: {
  onFire: () => void;
  style: object;
  label: string;
  children: React.ReactNode;
}) {
  const delay = useRef<ReturnType<typeof setTimeout> | null>(null);
  const iv = useRef<ReturnType<typeof setInterval> | null>(null);
  const stop = () => {
    if (delay.current) clearTimeout(delay.current);
    if (iv.current) clearInterval(iv.current);
    delay.current = null;
    iv.current = null;
  };
  useEffect(() => stop, []);
  return (
    <TouchableOpacity
      style={style}
      activeOpacity={0.6}
      onPressIn={() => {
        onFire();
        delay.current = setTimeout(() => {
          iv.current = setInterval(onFire, 60);
        }, 350);
      }}
      onPressOut={stop}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      {children}
    </TouchableOpacity>
  );
}

const ArrowCluster = React.memo(function ArrowCluster({
  onArrow,
}: {
  onArrow: (dir: 'A' | 'B' | 'C' | 'D') => void;
}) {
  return (
    <View style={styles.arrowCluster}>
      <RepeatBtn style={styles.arrowSeg} label="Arrow left" onFire={() => onArrow('D')}>
        <Feather name="chevron-left" size={18} color="#cbd5e1" />
      </RepeatBtn>
      <View style={styles.arrowVDivider} />
      <View style={styles.arrowMid}>
        <RepeatBtn style={styles.arrowMidHalf} label="Arrow up" onFire={() => onArrow('A')}>
          <Feather name="chevron-up" size={15} color="#cbd5e1" />
        </RepeatBtn>
        <View style={styles.arrowHDivider} />
        <RepeatBtn style={styles.arrowMidHalf} label="Arrow down" onFire={() => onArrow('B')}>
          <Feather name="chevron-down" size={15} color="#cbd5e1" />
        </RepeatBtn>
      </View>
      <View style={styles.arrowVDivider} />
      <RepeatBtn style={styles.arrowSeg} label="Arrow right" onFire={() => onArrow('C')}>
        <Feather name="chevron-right" size={18} color="#cbd5e1" />
      </RepeatBtn>
    </View>
  );
});

export default function App() {
  return (
    <SafeAreaProvider>
      <AppInner />
    </SafeAreaProvider>
  );
}

function AppInner() {
  const [fontsLoaded] = useFonts({ FiraCode_400Regular });
  const insets = useSafeAreaInsets();

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
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const [selectionViewOpen, setSelectionViewOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renameModalOpen, setRenameModalOpen] = useState(false);
  const [renameText, setRenameText] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<TextInput | null>(null);
  const [snippets, setSnippets] = useState<string[]>([]);
  const [snippetsModalOpen, setSnippetsModalOpen] = useState(false);
  const [snippetDraft, setSnippetDraft] = useState('');

  // Multi-session state
  const cache = useRef(new SessionCache(3)).current;
  const [activeId, setActiveId] = useState('term-1');
  const activeIdRef = useRef('term-1'); // for stale-closure-free access in ws handlers
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerSessions, setDrawerSessions] = useState<DrawerSession[]>([]);

  // References
  // Active terminal socket, abstracted over platform (RN WebSocket on mobile,
  // Tauri Rust bridge on desktop — see wsTransport). `gen` invalidates the
  // handlers of a superseded connection; `open` gates sends.
  const sock = useRef<TerminalSocket | null>(null);
  const gen = useRef(0);
  const open = useRef(false);
  const listRef = useRef<FlatList<RenderRow> | null>(null);
  const inputRef = useRef<TextInput | null>(null);
  const reconnectTimeout = useRef<any>(null);
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
  const lineHeight = Math.round(fontSize * 1.3);
  // Desktop docks a fixed-width sidebar, so the terminal pane is narrower than
  // the window — fit the grid (and the PTY resize) to the pane, not the window,
  // or the rightmost columns overflow off-screen.
  const paneWidth = isDesktop ? Math.max(120, winWidth - PANEL_W) : winWidth;
  const gridWidth = paneWidth - 12;
  const numCols = Math.max(20, Math.floor(gridWidth / (fontSize * CHAR_RATIO)));
  const numRows = termHeight ? Math.max(6, Math.floor((termHeight - 12) / lineHeight)) : 24;

  // Helper to get/create the cache entry for a given id, sized to the current grid.
  const entryFor = (id: string): SessionEntry =>
    cache.touch(id, () => {
      const term = new TerminalEmulator(numCols || 80, numRows || 24);
      // Only the active session holds a live socket, so replies from a
      // backgrounded session's emulator have nowhere to go — drop them.
      term.onReply = (text) => {
        if (id === activeIdRef.current) wsSend({ type: 'input', text });
      };
      return { term, sinceId: 0, lastAppliedId: 0 };
    });

  // Send only when the socket is actually OPEN. `connectionStatus` (React state)
  // lags the real socket state — e.g. mid-switch the new socket is CONNECTING —
  // so guarding on it throws INVALID_STATE_ERR. readyState is the source of truth.
  const wsSend = (obj: unknown) => {
    if (open.current && sock.current) sock.current.send(JSON.stringify(obj));
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
          wsSend({ type: 'input', text: `\x1b[<${btn};${col};${row}M` });
        };
        while (wheelAccum.current >= STEP) { wheel(64); wheelAccum.current -= STEP; } // drag down → older
        while (wheelAccum.current <= -STEP) { wheel(65); wheelAccum.current += STEP; } // drag up → newer
      },
    })
  ).current;

  // Coalesce many PTY chunks into one render per frame.
  const scheduleRender = () => {
    if (renderScheduled.current) return;
    renderScheduled.current = true;
    setTimeout(() => {
      renderScheduled.current = false;
      const e = cache.get(activeIdRef.current);
      if (!e) return;
      setScreen(e.term.getSnapshot());
      if (e.term.mouseOn !== mouseOnRef.current) {
        mouseOnRef.current = e.term.mouseOn;
        setMouseOn(e.term.mouseOn);
      }
    }, 33); // ~30fps: enough for a terminal, halves render load vs 60fps
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
      if (msg.type === 'output') {
        // Dedup: the server replays logs with ids > sinceId on (re)connect.
        if (msg.id) {
          if (msg.id <= ent.lastAppliedId) return;
          ent.lastAppliedId = msg.id;
          ent.sinceId = msg.id;
        }
        ent.term.write(msg.chunk);
        if (id === activeIdRef.current) scheduleRender();
      } else if (msg.type === 'exit') {
        ent.term.write(`\r\n\x1b[31m[Process exited with code ${msg.exitCode}]\x1b[0m\r\n`);
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

  const connect = () => {
    disconnect();
    lastConnectedRef.current = { ip: serverIp, port };
    const id = activeIdRef.current;
    const e = entryFor(id);
    setConnectionStatus('connecting');
    const url = wsUrl(serverIp, port, {
      sessionId: id,
      sinceId: e.sinceId,
      cols: numCols,
      rows: numRows,
    });

    // Each connect bumps the generation; a superseded socket's late callbacks are
    // ignored (replaces the old `ws.current !== socket` staleness check).
    const myGen = ++gen.current;
    const fresh = () => myGen === gen.current;

    sock.current = openTerminalSocket(url, passwordRef.current, {
      onOpen: () => {
        if (!fresh()) return;
        hasConnectedRef.current = true;
        open.current = true;
        setConnectionStatus('connected');
      },
      onMessage: (data) => {
        if (fresh()) applyWsMessage(id, data);
      },
      onClose: () => {
        if (!fresh()) return;
        open.current = false;
        setConnectionStatus('disconnected');
        if (readyRef.current && activeIdRef.current === id) {
          reconnectTimeout.current = setTimeout(connect, 3000);
        }
      },
    });
  };

  const disconnect = () => {
    if (reconnectTimeout.current) {
      clearTimeout(reconnectTimeout.current);
      reconnectTimeout.current = null;
    }
    gen.current++; // invalidate any in-flight handlers
    open.current = false;
    const s = sock.current;
    sock.current = null;
    if (s) s.close();
    setConnectionStatus('disconnected');
  };

  // Switch to a different session
  const switchTo = (id: string) => {
    setDrawerOpen(false);
    if (id === activeIdRef.current && sock.current) return;
    disconnect();
    activeIdRef.current = id;
    setActiveId(id);
    AsyncStorage.setItem(KEY_SESSION_ID, id);
    const e = entryFor(id); // creates fresh if uncached; resizes handled by effect
    setScreen(e.term.getSnapshot()); // instant paint of last-known screen
    autoScroll.current = true;
    lastContentHeight.current = 0;
    connect();
  };

  const newTerminal = () => {
    const existing = drawerSessions.map((s) => s.id);
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
    const remaining = drawerSessions.filter((s) => s.id !== id).map((s) => s.id);
    await refreshSessions();
    if (id === activeIdRef.current) switchTo(remaining[0] ?? 'term-1');
  };

  // Keep activeIdRef synced when activeId changes (belt-and-suspenders)
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  // Load persisted font size once on mount.
  useEffect(() => {
    AsyncStorage.getItem(KEY_FONT)
      .then((v) => {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 8 && n <= 24) setFontSize(n);
      })
      .catch(() => {});
  }, []);

  const changeFontSize = (delta: number) => {
    setFontSize((prev) => {
      const next = Math.min(24, Math.max(8, prev + delta));
      AsyncStorage.setItem(KEY_FONT, String(next));
      return next;
    });
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

  // Poll the session list every 4s while foregrounded.
  useEffect(() => {
    if (isConfiguring) return;
    refreshSessions();
    const iv = setInterval(refreshSessions, 4000);
    return () => clearInterval(iv);
  }, [isConfiguring, serverIp, port]);

  // 1. Load saved config on mount
  useEffect(() => {
    async function loadConfig() {
      try {
        const [savedIp, savedPort, savedSession, savedPw] = await Promise.all([
          AsyncStorage.getItem(KEY_SERVER_IP),
          AsyncStorage.getItem(KEY_PORT),
          AsyncStorage.getItem(KEY_SESSION_ID),
          getPassword(),
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
    return () => disconnect();
  }, []);

  // Size the emulator (and the remote PTY) to the on-screen grid so the shell
  // fills the viewport. Re-runs when the fit changes or the socket connects.
  useEffect(() => {
    cache.get(activeIdRef.current)?.term.resize(numCols, numRows);
    wsSend({ type: 'resize', cols: numCols, rows: numRows });
    scheduleRender();
  }, [numCols, numRows, connectionStatus, activeId]);

  // 2. Manage WebSocket connection — reconnects on session switch. Opening
  // Settings does NOT tear this down; only an address/port change (saveConfig)
  // or an actual session switch touches the socket.
  useEffect(() => {
    if (!ready) return;
    connect();
    return () => disconnect();
  }, [ready, activeId]);

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
        resetTerminal();
        connect();
      }
    } catch (e) {
      Alert.alert('Error', 'Failed to save configuration');
    }
  };

  const sendInput = (text: string) => {
    wsSend({ type: 'input', text });
  };

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

  const handleCopyAll = async () => {
    const text = getFullText();
    if (!text) return;
    await Clipboard.setStringAsync(text);
    Alert.alert('Copied', 'Displayed transcript copied to clipboard.');
  };

  const handlePaste = async () => {
    let text = '';
    try {
      text = await Clipboard.getStringAsync();
    } catch {
      Alert.alert('Paste failed', 'Could not read the clipboard.');
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

  // Desktop: capture the physical keyboard globally and forward keystrokes to
  // the PTY (replacing the mobile utility bar). Skipped while a text field is
  // focused (config form, rename/snippet/search modals) so those still type
  // normally. Ctrl/Cmd+C copies an active selection or sends SIGINT; Ctrl/Cmd+V
  // pastes from the clipboard.
  useEffect(() => {
    if (!isDesktop || isConfiguring) return;
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as (HTMLElement & { isContentEditable?: boolean }) | null;
      // Don't hijack the keyboard while a real UI control is focused: text fields
      // must type normally, and Enter/Space must activate a focused button
      // (New terminal, Settings, the overflow menu, Kill) instead of leaking into
      // the shell. The terminal surface itself is exempt so click-to-focus then
      // type still works. Nothing focused (body) → forward, the common case.
      if (el && el !== document.body) {
        const onTerminal = el.id === 'tether-terminal' || !!el.closest?.('#tether-terminal');
        if (!onTerminal) {
          const tag = el.tagName;
          const role = el.getAttribute?.('role');
          if (
            tag === 'INPUT' ||
            tag === 'TEXTAREA' ||
            tag === 'SELECT' ||
            tag === 'BUTTON' ||
            tag === 'A' ||
            el.isContentEditable ||
            role === 'button' ||
            role === 'link' ||
            role === 'menuitem' ||
            el.getAttribute?.('tabindex') != null
          ) {
            return;
          }
        }
      }
      const bytes = keyToBytes(e);
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
    return () => window.removeEventListener('keydown', onKey);
    // sendInput/handlePaste delegate to refs, so a stable listener is fine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConfiguring]);

  const activeName = drawerSessions.find((s) => s.id === activeId)?.name || activeId;

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
      Alert.alert('Rename failed', String(err));
    }
  };

  const hardResetSession = () => {
    Alert.alert(
      'Restart terminal',
      "This restarts the shell process and clears this terminal's scrollback history on the server. This can't be undone.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Restart',
          style: 'destructive',
          onPress: async () => {
            resetTerminal();
            try {
              await fetch(`${httpBase(serverIp, port)}/api/sessions/kill`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders(passwordRef.current) },
                body: JSON.stringify({ id: activeId }),
              });
              connect();
            } catch (e) {
              Alert.alert('Error', 'Failed to kill session on the server');
            }
          },
        },
      ]
    );
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
      />
    ),
    [fontSize, lineHeight, gridWidth, blinkOn],
  );

  if (!fontsLoaded) return null;

  return (
    <SafeAreaView style={styles.appContainer}>
      {isConfiguring ? (
        /* Configuration Screen */
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.configContainer}
        >
          <View style={styles.configLogoContainer}>
            <View style={styles.configIconBox}>
              <Text style={styles.configLogoIcon}>{'>_'}</Text>
            </View>
            <Text style={styles.configTitle}>{isDesktop ? 'Tether Desktop' : 'Tether Mobile'}</Text>
            <Text style={styles.configSubtitle}>Connect to a terminal on your server</Text>
          </View>

          <View style={styles.formContainer}>
            <Text style={styles.inputLabel}>Server IP / Host</Text>
            <TextInput
              style={styles.configInput}
              value={serverIp}
              onChangeText={(t) => {
                setServerIp(t);
                setSetupMode('unknown');
                setTestStatus({ kind: 'idle' });
              }}
              placeholder="e.g. 192.168.50.30"
              placeholderTextColor="#64748b"
              autoCapitalize="none"
              autoCorrect={false}
            />

            <Text style={styles.inputLabel}>Port</Text>
            <TextInput
              style={styles.configInput}
              value={port}
              onChangeText={(t) => {
                setPort(t);
                setSetupMode('unknown');
                setTestStatus({ kind: 'idle' });
              }}
              placeholder="e.g. 8085"
              placeholderTextColor="#64748b"
              keyboardType="numeric"
              autoCapitalize="none"
              autoCorrect={false}
            />

            <Text style={styles.inputLabel}>Password</Text>
            <TextInput
              style={styles.configInput}
              value={password}
              onChangeText={(t) => {
                setPassword(t);
                setTestStatus({ kind: 'idle' });
              }}
              placeholder={setupMode === 'create' ? 'Choose a password' : 'Shared server password'}
              placeholderTextColor="#64748b"
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
            />

            {setupMode === 'create' && (
              <>
                <TextInput
                  style={styles.configInput}
                  value={confirmPassword}
                  onChangeText={(t) => {
                    setConfirmPassword(t);
                    setTestStatus({ kind: 'idle' });
                  }}
                  placeholder="Confirm password"
                  placeholderTextColor="#64748b"
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <Text style={styles.configHint}>
                  This server has no password yet. The one you choose here will be required by every
                  client.
                </Text>
              </>
            )}

            <Text style={styles.configHint}>
              The password controls access. For traffic encryption, run tether behind a tunnel
              (Tailscale, WireGuard, or SSH).
            </Text>

            {testStatus.kind === 'error' && <Text style={styles.testError}>{testStatus.msg}</Text>}
            {testStatus.kind === 'ok' && (
              <View style={styles.testOkRow}>
                <View style={[styles.badgeDot, styles.dotConnected]} />
                <Text style={styles.testOk}>Reachable</Text>
              </View>
            )}

            {testStatus.kind === 'ok' ? (
              <TouchableOpacity style={styles.connectBtn} onPress={saveConfig}>
                <Text style={styles.connectBtnText}>Save &amp; Connect</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={styles.connectBtn}
                onPress={testConnection}
                disabled={testStatus.kind === 'testing'}
              >
                <Text style={styles.connectBtnText}>
                  {testStatus.kind === 'testing'
                    ? 'Testing…'
                    : setupMode === 'create'
                      ? 'Create password'
                      : 'Test connection'}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        </KeyboardAvoidingView>
      ) : (
        /* Terminal Client Screen */
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={[styles.terminalContainer, isDesktop && styles.terminalRow]}
        >
          {/* Desktop: permanent sidebar of terminals in place of the overlay drawer. */}
          {isDesktop && (
            <SessionDrawer
              docked
              visible
              sessions={drawerSessions}
              activeId={activeId}
              onSelect={switchTo}
              onNew={newTerminal}
              onKill={killActiveOr}
              onClose={() => {}}
              onSettings={() => setIsConfiguring(true)}
            />
          )}

          <View style={styles.terminalMain}>
          {/* Header Panel */}
          <View style={styles.header}>
            {!isDesktop && (
              <TouchableOpacity
                style={styles.headerBtn}
                activeOpacity={0.6}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                onPress={() => { Keyboard.dismiss(); refreshSessions(); setDrawerOpen(true); }}
                accessibilityRole="button"
                accessibilityLabel="Open terminal list"
              >
                <Feather name="menu" size={20} color="#cbd5e1" />
              </TouchableOpacity>
            )}

            <View style={styles.headerInfo}>
              <Text style={styles.headerTitle}>{activeName}</Text>
              <Text style={styles.headerSubtitle}>{serverIp}:{port}</Text>
            </View>

            <View style={styles.headerControls}>
              {connectionStatus === 'connected' ? (
                <View style={[styles.statusBadge, styles.badgeConnected]}>
                  <View style={[styles.badgeDot, styles.dotConnected]} />
                  <Text style={styles.badgeTextConnected}>Connected</Text>
                </View>
              ) : connectionStatus === 'auth-failed' ? (
                <View style={[styles.statusBadge, styles.badgeOffline]}>
                  <View style={[styles.badgeDot, styles.dotOffline]} />
                  <Text style={styles.badgeTextOffline}>Auth</Text>
                </View>
              ) : connectionStatus === 'connecting' ? (
                <View style={[styles.statusBadge, styles.badgeConnecting]}>
                  <ActivityIndicator size={8} color="#fbbf24" style={styles.spinIcon} />
                  <Text style={styles.badgeTextConnecting}>Connecting…</Text>
                </View>
              ) : (
                <View style={[styles.statusBadge, styles.badgeOffline]}>
                  <View style={[styles.badgeDot, styles.dotOffline]} />
                  <Text style={styles.badgeTextOffline}>Offline</Text>
                </View>
              )}

              <TouchableOpacity
                style={styles.headerBtn}
                activeOpacity={0.6}
                hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
                onPress={() => setMenuOpen(true)}
                accessibilityRole="button"
                accessibilityLabel="Terminal menu"
              >
                <Feather name="more-vertical" size={19} color="#cbd5e1" />
              </TouchableOpacity>
            </View>
          </View>

          {/* Connection banner — names the real state; no safety overclaim. */}
          {connectionStatus !== 'connected' && (
            <View style={styles.reconnectBanner}>
              <Text style={styles.reconnectBannerText}>
                {connectionStatus === 'auth-failed'
                  ? 'Wrong password.'
                  : hasConnectedRef.current
                    ? 'Reconnecting… (session kept running on the server)'
                    : 'Connecting…'}
              </Text>
              <TouchableOpacity
                onPress={() => setIsConfiguring(true)}
                accessibilityRole="button"
                accessibilityLabel="Edit connection settings"
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={styles.reconnectBannerEdit}>Edit</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Terminal grid — vertical FlatList inside a horizontal ScrollView so
              wide (e.g. 80-col) output stays legible and scrolls sideways.
              Tapping it focuses the hidden capture field to bring up the keyboard. */}
          <View
            style={styles.terminalScroll}
            onLayout={(e) => setTermHeight(e.nativeEvent.layout.height)}
            {...panResponder.panHandlers}
          >
            <Pressable
              nativeID="tether-terminal"
              style={{ flex: 1 }}
              accessibilityRole="button"
              accessibilityLabel="Terminal. Double-tap to type, long-press to select text."
              onPressIn={() => {
                scrolledRef.current = false;
              }}
              onPress={() => {
                // Only a genuine tap focuses the input; a scroll-release must not
                // pop the keyboard.
                if (!scrolledRef.current) inputRef.current?.focus();
              }}
              onLongPress={openSelectionView}
            >
              <FlatList
                ref={listRef}
                style={{ flex: 1 }}
                contentContainerStyle={styles.terminalContent}
                data={screen}
                renderItem={renderRow}
                keyExtractor={(_, i) => String(i)}
                onScroll={onScroll}
                onScrollBeginDrag={() => {
                  autoScroll.current = false;
                  scrolledRef.current = true;
                }}
                scrollEventThrottle={100}
                scrollEnabled={!mouseOn}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="none"
                onContentSizeChange={() => {
                  if (autoScroll.current) listRef.current?.scrollToEnd({ animated: false });
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
            </Pressable>
          </View>

          {/* Session Drawer (overlay) — mobile only; desktop uses the docked sidebar. */}
          {!isDesktop && (
            <SessionDrawer
              visible={drawerOpen}
              sessions={drawerSessions}
              activeId={activeId}
              onSelect={switchTo}
              onNew={newTerminal}
              onKill={killActiveOr}
              onClose={() => setDrawerOpen(false)}
              onSettings={() => { setDrawerOpen(false); setIsConfiguring(true); }}
            />
          )}

          {/* Overflow menu (header ⋯) */}
          <Modal
            visible={menuOpen}
            animationType="fade"
            transparent
            onRequestClose={() => setMenuOpen(false)}
          >
            <Pressable style={styles.overflowMenuBackdrop} onPress={() => setMenuOpen(false)}>
              <Pressable style={[styles.menuPanel, { marginTop: insets.top + 52 }]} onPress={() => {}}>
                <TouchableOpacity style={styles.menuRow} onPress={openRename}>
                  <Feather name="edit-2" size={16} color="#cbd5e1" />
                  <Text style={styles.menuRowText}>Rename terminal</Text>
                </TouchableOpacity>
                <View style={styles.menuRow}>
                  <Feather name="type" size={16} color="#cbd5e1" />
                  <Text style={[styles.menuRowText, { flex: 1 }]} numberOfLines={1}>
                    Font size
                  </Text>
                  <TouchableOpacity
                    style={styles.fontStepBtn}
                    onPress={() => changeFontSize(-1)}
                    accessibilityLabel="Decrease font size"
                  >
                    <Text style={styles.fontStepText}>−</Text>
                  </TouchableOpacity>
                  <Text style={styles.fontSizeValue}>{fontSize}</Text>
                  <TouchableOpacity
                    style={styles.fontStepBtn}
                    onPress={() => changeFontSize(1)}
                    accessibilityLabel="Increase font size"
                  >
                    <Text style={styles.fontStepText}>+</Text>
                  </TouchableOpacity>
                </View>
                <TouchableOpacity style={styles.menuRow} onPress={openSearch}>
                  <Feather name="search" size={16} color="#cbd5e1" />
                  <Text style={styles.menuRowText}>Search displayed transcript</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.menuRow}
                  onPress={() => {
                    setMenuOpen(false);
                    setSnippetsModalOpen(true);
                  }}
                >
                  <Feather name="terminal" size={16} color="#cbd5e1" />
                  <Text style={styles.menuRowText}>Saved commands</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.menuRow}
                  onPress={() => {
                    setMenuOpen(false);
                    hardResetSession();
                  }}
                >
                  <Feather name="refresh-cw" size={16} color="#f87171" />
                  <Text style={[styles.menuRowText, { color: '#f87171' }]}>Restart terminal</Text>
                </TouchableOpacity>
              </Pressable>
            </Pressable>
          </Modal>

          {/* Rename Modal */}
          <Modal
            visible={renameModalOpen}
            animationType="fade"
            transparent
            onRequestClose={() => setRenameModalOpen(false)}
          >
            <Pressable style={styles.menuBackdrop} onPress={() => setRenameModalOpen(false)}>
              <Pressable style={styles.renamePanel} onPress={() => {}}>
                <Text style={styles.renameTitle}>Rename terminal</Text>
                <TextInput
                  style={styles.renameInput}
                  value={renameText}
                  onChangeText={setRenameText}
                  placeholder={activeId}
                  placeholderTextColor="#64748b"
                  autoFocus
                  autoCapitalize="none"
                  autoCorrect={false}
                  onSubmitEditing={submitRename}
                  keyboardAppearance="dark"
                />
                <View style={styles.renameBtns}>
                  <TouchableOpacity
                    style={styles.renameBtn}
                    onPress={() => setRenameModalOpen(false)}
                  >
                    <Text style={styles.renameBtnText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.renameBtn} onPress={submitRename}>
                    <Text style={[styles.renameBtnText, { color: '#22d3ee' }]}>Save</Text>
                  </TouchableOpacity>
                </View>
              </Pressable>
            </Pressable>
          </Modal>

          {/* Snippets Modal */}
          <Modal
            visible={snippetsModalOpen}
            animationType="fade"
            transparent
            onRequestClose={() => setSnippetsModalOpen(false)}
          >
            <Pressable style={styles.menuBackdrop} onPress={() => setSnippetsModalOpen(false)}>
              <Pressable style={styles.renamePanel} onPress={() => {}}>
                <Text style={styles.renameTitle}>Saved commands</Text>
                {snippets.length === 0 && (
                  <Text style={styles.snippetEmpty}>No saved commands yet. Add one below.</Text>
                )}
                {snippets.map((s, i) => (
                  <View key={`${s}-${i}`} style={styles.snippetRow}>
                    <TouchableOpacity style={styles.snippetSend} onPress={() => sendSnippet(s)}>
                      <Text style={styles.snippetText} numberOfLines={1}>
                        {s}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.snippetDelete}
                      onPress={() => removeSnippet(i)}
                      accessibilityLabel={`Delete snippet ${s}`}
                    >
                      <Feather name="x" size={16} color="#94a3b8" />
                    </TouchableOpacity>
                  </View>
                ))}
                <View style={styles.snippetAddRow}>
                  <TextInput
                    style={[styles.renameInput, { flex: 1 }]}
                    value={snippetDraft}
                    onChangeText={setSnippetDraft}
                    placeholder="New snippet (e.g. git status)"
                    placeholderTextColor="#64748b"
                    autoCapitalize="none"
                    autoCorrect={false}
                    onSubmitEditing={addSnippet}
                    keyboardAppearance="dark"
                  />
                  <TouchableOpacity style={styles.snippetAddBtn} onPress={addSnippet}>
                    <Feather name="plus" size={18} color="#22d3ee" />
                  </TouchableOpacity>
                </View>
              </Pressable>
            </Pressable>
          </Modal>

          {/* Fullscreen selectable-text view (long-press the terminal to open) */}
          <Modal
            visible={selectionViewOpen}
            animationType="slide"
            onRequestClose={() => {
              setSelectionViewOpen(false);
              setSearchQuery('');
            }}
          >
            <View style={[styles.selectionViewContainer, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
              <View style={styles.selectionViewHeader}>
                <Text style={styles.selectionViewTitle}>Select text (displayed transcript)</Text>
                <View style={styles.selectionViewHeaderBtns}>
                  <TouchableOpacity
                    style={styles.selectionViewHeaderBtn}
                    onPress={handleCopyAll}
                    accessibilityRole="button"
                    accessibilityLabel="Copy displayed transcript"
                  >
                    <Text style={styles.selectionViewHeaderBtnText}>Copy displayed transcript</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.selectionViewHeaderBtn}
                    onPress={() => {
                      setSelectionViewOpen(false);
                      setSearchQuery('');
                    }}
                    accessibilityRole="button"
                    accessibilityLabel="Close"
                  >
                    <Feather name="x" size={20} color="#cbd5e1" />
                  </TouchableOpacity>
                </View>
              </View>
              <TextInput
                ref={searchInputRef}
                style={styles.searchInput}
                value={searchQuery}
                onChangeText={setSearchQuery}
                placeholder="Filter lines…"
                placeholderTextColor="#64748b"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardAppearance="dark"
              />
              {selectionViewOpen && (
                <TextInput
                  style={styles.selectionViewText}
                  value={searchText}
                  editable={false}
                  multiline
                  scrollEnabled
                />
              )}
            </View>
          </Modal>

          {/* Mobile Terminal Shortcuts Utility Bar — desktop uses the real keyboard. */}
          {!isDesktop && (
          <View style={styles.utilityBar}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" contentContainerStyle={styles.utilityScroll}>
              <TouchableOpacity
                style={[styles.utilityBtn, ctrlArmed && styles.utilityBtnActive]}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  setCtrlArmed((v) => !v);
                }}
              >
                <Text style={[styles.utilityBtnText, ctrlArmed && styles.utilityBtnTextActive]}>
                  Ctrl
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.utilityBtn}
                onPress={() => sendInput('\t')}
                onLongPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  sendInput('\x1b[Z');
                }}
              >
                <Text style={styles.utilityBtnText}>Tab</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.utilityBtn} onPress={() => sendInput('\x1b')}>
                <Text style={styles.utilityBtnText}>Esc</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.utilityBtn} onPress={() => sendInput('\x1b[3~')}>
                <Text style={styles.utilityBtnText}>Del</Text>
              </TouchableOpacity>

              <View style={styles.utilityGroupDivider} />

              <ArrowCluster
                onArrow={(dir) => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  sendInput(`\x1b[${dir}`);
                }}
              />

              <View style={styles.utilityGroupDivider} />

              <TouchableOpacity style={styles.utilityBtn} onPress={() => sendInput('\x1b[H')}>
                <Text style={styles.utilityBtnText}>Home</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.utilityBtn} onPress={() => sendInput('\x1b[F')}>
                <Text style={styles.utilityBtnText}>End</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.utilityBtn} onPress={() => sendInput('\x1b[5~')}>
                <Text style={styles.utilityBtnText}>PgUp</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.utilityBtn} onPress={() => sendInput('\x1b[6~')}>
                <Text style={styles.utilityBtnText}>PgDn</Text>
              </TouchableOpacity>

              <View style={styles.utilityGroupDivider} />

              <TouchableOpacity style={styles.utilityIconBtn} activeOpacity={0.6} onPress={handlePaste} accessibilityRole="button" accessibilityLabel="Paste">
                <Feather name="clipboard" size={17} color="#cbd5e1" />
              </TouchableOpacity>
              <TouchableOpacity style={styles.utilityIconBtn} activeOpacity={0.6} onPress={() => Keyboard.dismiss()} accessibilityRole="button" accessibilityLabel="Hide keyboard">
                <Feather name="chevron-down" size={18} color="#cbd5e1" />
              </TouchableOpacity>
            </ScrollView>
          </View>
          )}

          {/* Hidden keyboard-capture field (mobile): tapping the terminal focuses
              it, so typing goes straight into the terminal (the shell echoes it
              back). Desktop reads the physical keyboard globally instead. */}
          {!isDesktop && (
            <TextInput
              ref={inputRef}
              style={styles.hiddenInput}
              value={inputText}
              onKeyPress={handleKeyPress}
              onChangeText={handleChangeText}
              onSubmitEditing={handleSend}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              autoComplete="off"
              blurOnSubmit={false}
              keyboardAppearance="dark"
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              accessibilityLabel="Terminal input (hidden)"
            />
          )}
          </View>
        </KeyboardAvoidingView>
      )}
    </SafeAreaView>
  );
}

const MONO = 'FiraCode_400Regular'; // wide box-drawing/braille/powerline glyph coverage vs. Courier

const styles = StyleSheet.create({
  appContainer: {
    flex: 1,
    backgroundColor: '#070a13',
  },

  /* Config Screen Styles */
  configContainer: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
    backgroundColor: '#070a13',
  },
  configLogoContainer: {
    alignItems: 'center',
    marginBottom: 32,
  },
  configIconBox: {
    padding: 16,
    borderRadius: 16,
    backgroundColor: 'rgba(99, 102, 241, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(99, 102, 241, 0.2)',
    marginBottom: 16,
  },
  configLogoIcon: {
    fontSize: 32,
    fontFamily: MONO,
    fontWeight: 'bold',
    color: '#818cf8',
  },
  configTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#ffffff',
    marginBottom: 8,
  },
  configSubtitle: {
    fontSize: 12,
    color: '#94a3b8',
    textAlign: 'center',
  },
  formContainer: {
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    padding: 20,
  },
  inputLabel: {
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    color: '#94a3b8',
    marginBottom: 6,
    letterSpacing: 0.5,
  },
  configInput: {
    backgroundColor: '#030712',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    borderRadius: 8,
    color: '#e2e8f0',
    fontSize: 14,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 16,
    fontFamily: MONO,
  },
  rowInputs: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  halfInput: {
    width: '48%',
  },
  connectBtn: {
    backgroundColor: '#3730a3',
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 10,
  },
  connectBtnText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
  configHint: { color: '#64748b', fontSize: 12, lineHeight: 17, marginTop: 4, marginBottom: 12 },
  testError: { color: '#f87171', fontSize: 13, marginBottom: 10 },
  testOkRow: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 10 },
  testOk: { color: '#4ade80', fontSize: 13 },

  /* Terminal Screen Styles */
  terminalContainer: {
    flex: 1,
    backgroundColor: '#05070e',
  },
  // Desktop: sidebar + terminal side by side.
  terminalRow: {
    flexDirection: 'row',
  },
  // The terminal column (right of the docked sidebar on desktop; the whole
  // screen on mobile).
  terminalMain: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: 'rgba(11, 15, 25, 0.8)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.1)',
  },
  headerInfo: {
    flexDirection: 'column',
    flex: 1,
    marginHorizontal: 8,
  },
  headerTitle: {
    fontSize: 13,
    fontWeight: 'bold',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    color: '#ffffff',
  },
  headerSubtitle: {
    fontSize: 10,
    color: '#94a3b8',
  },
  headerControls: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerBtn: {
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 4,
    marginLeft: 6,
  },
  headerBtnText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#94a3b8',
  },
  headerBtnTextDanger: {
    color: '#f87171',
  },
  headerBtnTextActive: {
    color: '#818cf8',
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 9999,
    borderWidth: 1,
    marginRight: 6,
  },
  badgeConnected: {
    backgroundColor: 'rgba(16, 185, 129, 0.1)',
    borderColor: 'rgba(16, 185, 129, 0.2)',
  },
  badgeConnecting: {
    backgroundColor: 'rgba(245, 158, 11, 0.1)',
    borderColor: 'rgba(245, 158, 11, 0.2)',
  },
  badgeOffline: {
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    borderColor: 'rgba(239, 68, 68, 0.2)',
  },
  badgeTextConnected: {
    fontSize: 10,
    fontWeight: '500',
    color: '#34d399',
  },
  badgeTextConnecting: {
    fontSize: 10,
    fontWeight: '500',
    color: '#fbbf24',
  },
  badgeTextOffline: {
    fontSize: 10,
    fontWeight: '500',
    color: '#f87171',
  },
  badgeDot: {
    width: 5,
    height: 5,
    borderRadius: 9999,
    marginRight: 4,
  },
  dotConnected: {
    backgroundColor: '#34d399',
  },
  dotOffline: {
    backgroundColor: '#f87171',
  },
  spinIcon: {
    marginRight: 4,
  },
  reconnectBanner: {
    backgroundColor: 'rgba(245, 158, 11, 0.15)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(245, 158, 11, 0.25)',
    paddingVertical: 6,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  reconnectBannerText: {
    fontSize: 10,
    color: '#fcd34d',
    textAlign: 'center',
  },
  reconnectBannerEdit: {
    fontSize: 11,
    color: '#22d3ee',
    fontWeight: '600',
  },
  terminalScroll: {
    flex: 1,
    backgroundColor: '#05070e',
    // Desktop: allow native mouse selection of terminal text (RN-web maps these
    // through; no-ops on native).
    ...(isDesktop ? ({ userSelect: 'text', cursor: 'text' } as object) : null),
  },
  terminalContent: {
    paddingHorizontal: 6,
    paddingVertical: 8,
  },
  terminalEmpty: {
    color: '#64748b',
    fontFamily: MONO,
    fontSize: 13,
    padding: 16,
  },
  termLine: {
    fontFamily: MONO,
    color: '#cbd5e1',
  },
  link: {
    textDecorationLine: 'underline',
  },
  utilityBar: {
    backgroundColor: '#0b0f19',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.05)',
    paddingVertical: 8,
  },
  utilityScroll: {
    paddingHorizontal: 12,
    alignItems: 'center',
    gap: 6,
  },
  utilityBtn: {
    height: 40,
    justifyContent: 'center',
    paddingHorizontal: 14,
    borderRadius: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
  },
  utilityBtnText: {
    fontSize: 13,
    fontWeight: '700',
    fontFamily: MONO,
    color: '#cbd5e1',
  },
  utilityBtnActive: {
    backgroundColor: '#22d3ee',
  },
  utilityBtnTextActive: {
    color: '#0b0f19',
  },
  utilityIconBtn: {
    width: 40,
    height: 40,
    borderRadius: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  fontStepBtn: {
    width: 30,
    height: 30,
    borderRadius: 6,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  fontStepText: {
    fontSize: 18,
    fontWeight: '700',
    color: '#e2e8f0',
  },
  fontSizeValue: {
    minWidth: 24,
    textAlign: 'center',
    fontSize: 14,
    fontWeight: '700',
    color: '#e2e8f0',
  },
  snippetEmpty: {
    color: '#64748b',
    fontSize: 13,
  },
  snippetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  snippetSend: {
    flex: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  snippetText: {
    color: '#e2e8f0',
    fontSize: 14,
    fontFamily: MONO,
  },
  snippetDelete: {
    padding: 8,
  },
  snippetAddRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  snippetAddBtn: {
    width: 40,
    height: 40,
    borderRadius: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  menuBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  overflowMenuBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    justifyContent: 'flex-start',
    alignItems: 'flex-end',
  },
  menuPanel: {
    alignSelf: 'flex-end',
    marginRight: 12,
    minWidth: 240,
    backgroundColor: '#0b0f19',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    paddingVertical: 6,
  },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  menuRowText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#cbd5e1',
  },
  renamePanel: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: '#0b0f19',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    padding: 20,
    gap: 14,
  },
  renameTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#e2e8f0',
  },
  renameInput: {
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#e2e8f0',
    fontSize: 15,
  },
  renameBtns: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 20,
  },
  renameBtn: {
    paddingHorizontal: 4,
    paddingVertical: 4,
  },
  renameBtnText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#94a3b8',
  },
  selectionViewContainer: {
    flex: 1,
    backgroundColor: '#070a13',
  },
  selectionViewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.08)',
  },
  selectionViewTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#e2e8f0',
  },
  selectionViewHeaderBtns: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  selectionViewHeaderBtn: {
    paddingHorizontal: 4,
    paddingVertical: 4,
  },
  selectionViewHeaderBtnText: {
    color: '#22d3ee',
    fontWeight: '600',
    fontSize: 14,
  },
  searchInput: {
    marginHorizontal: 16,
    marginBottom: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: '#e2e8f0',
    fontSize: 14,
  },
  selectionViewText: {
    flex: 1,
    padding: 16,
    fontFamily: MONO,
    fontSize: 13,
    lineHeight: 18,
    color: '#cbd5e1',
  },
  utilityIconText: {
    fontSize: 10,
    fontFamily: MONO,
    color: '#cbd5e1',
  },
  utilityGroupDivider: {
    width: 1,
    height: 24,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    marginHorizontal: 2,
  },
  arrowCluster: {
    flexDirection: 'row',
    height: 40,
    borderRadius: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    overflow: 'hidden',
  },
  arrowSeg: {
    width: 38,
    alignItems: 'center',
    justifyContent: 'center',
  },
  arrowMid: {
    width: 34,
  },
  arrowMidHalf: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  arrowVDivider: {
    width: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
  },
  arrowHDivider: {
    height: 1,
    marginHorizontal: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
  },
  resizeSpacer: {
    width: 12,
  },
  resizeBtn: {
    paddingVertical: 3,
    paddingHorizontal: 6,
    borderRadius: 4,
    backgroundColor: 'rgba(255, 255, 255, 0.02)',
    marginRight: 4,
  },
  resizeBtnActive: {
    backgroundColor: 'rgba(99, 102, 241, 0.1)',
  },
  resizeBtnText: {
    fontSize: 9,
    fontFamily: MONO,
    color: '#64748b',
  },
  resizeBtnTextActive: {
    color: '#818cf8',
  },
  inputBar: {
    backgroundColor: '#0b0f19',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.1)',
    padding: 12,
  },
  inputBoxContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#030712',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 2,
  },
  hiddenInput: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    width: 1,
    height: 1,
    opacity: 0,
  },
  inputPrompt: {
    color: '#34d399',
    fontFamily: MONO,
    fontSize: 16,
    fontWeight: '700',
    marginRight: 8,
  },
  terminalInput: {
    flex: 1,
    color: '#e2e8f0',
    fontSize: 16,
    paddingVertical: 8,
    fontFamily: MONO,
  },
  sendBtn: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: '#3730a3',
    justifyContent: 'center',
    alignItems: 'center',
  },
  sendBtnDisabled: {
    opacity: 0.4,
  },
  sendBtnText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '600',
  },
});
