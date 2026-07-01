import React, { useState, useEffect, useRef, useCallback } from 'react';
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
  SafeAreaView,
  Alert,
  ActivityIndicator,
  useWindowDimensions,
  type TextStyle,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { TerminalEmulator, type RenderRow, type CellStyle } from './src/terminal';
import { SessionCache, nextTermId, type SessionEntry } from './src/sessionCache';
import { SessionDrawer, type DrawerSession } from './src/SessionDrawer';

// Constants for async storage keys
const KEY_SERVER_IP = 'tether_server_ip';
const KEY_PORT = 'tether_port';
const KEY_SESSION_ID = 'tether_session_id';
const KEY_HISTORY = 'tether_history';

// Zero-width sentinel kept in the capture field so it's never "empty" — lets iOS
// fire onChangeText for Backspace even with nothing typed yet.
const SENT = '​';

function runToStyle(s: CellStyle): TextStyle {
  const style: TextStyle = {};
  if (s.fg) style.color = s.fg;
  if (s.bg) style.backgroundColor = s.bg;
  if (s.bold) style.fontWeight = 'bold';
  if (s.italic) style.fontStyle = 'italic';
  if (s.underline) style.textDecorationLine = 'underline';
  if (s.caret) {
    // Block caret: accent background, dark glyph for contrast.
    style.backgroundColor = '#818cf8';
    style.color = '#0b0f19';
  }
  return style;
}

// Memoized terminal row. Props are shallow-compared; the emulator reuses the
// same `row` object for unchanged lines, so continuous TUI repaints only
// re-render the handful of rows that actually changed.
const TermRow = React.memo(function TermRow({
  row,
  fontSize,
  lineHeight,
  width,
}: {
  row: RenderRow;
  fontSize: number;
  lineHeight: number;
  width: number;
}) {
  return (
    <Text style={[styles.termLine, { fontSize, lineHeight, width }]} numberOfLines={1}>
      {row.runs.map((run, i) => (
        <Text key={i} style={runToStyle(run.style)}>
          {run.text}
        </Text>
      ))}
    </Text>
  );
});

export default function App() {
  // Connection states
  const [serverIp, setServerIp] = useState('192.168.50.30');
  const [port, setPort] = useState('8085');

  // UI states
  const [isConfiguring, setIsConfiguring] = useState(true);
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'disconnected'>('disconnected');
  const [screen, setScreen] = useState<RenderRow[]>([]);
  const [inputText, setInputText] = useState(SENT);
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [termHeight, setTermHeight] = useState(0);
  const [mouseOn, setMouseOn] = useState(false);

  // Multi-session state
  const cache = useRef(new SessionCache(3)).current;
  const [activeId, setActiveId] = useState('term-1');
  const activeIdRef = useRef('term-1'); // for stale-closure-free access in ws handlers
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerSessions, setDrawerSessions] = useState<DrawerSession[]>([]);

  // References
  const ws = useRef<WebSocket | null>(null);
  const listRef = useRef<FlatList<RenderRow> | null>(null);
  const inputRef = useRef<TextInput | null>(null);
  const reconnectTimeout = useRef<any>(null);
  const autoScroll = useRef(true);
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
  const fontSize = 11;
  const lineHeight = Math.round(fontSize * 1.3);
  const gridWidth = winWidth - 12;
  const numCols = Math.max(20, Math.floor(gridWidth / (fontSize * CHAR_RATIO)));
  const numRows = termHeight ? Math.max(6, Math.floor((termHeight - 12) / lineHeight)) : 24;

  // Helper to get/create the cache entry for a given id, sized to the current grid.
  const entryFor = (id: string): SessionEntry =>
    cache.touch(id, () => ({ term: new TerminalEmulator(numCols || 80, numRows || 24), sinceId: 0, lastAppliedId: 0 }));

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
          ws.current?.send(JSON.stringify({ type: 'input', text: `\x1b[<${btn};${col};${row}M` }));
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
    }
  };

  const connect = () => {
    disconnect();
    const id = activeIdRef.current;
    const e = entryFor(id);
    setConnectionStatus('connecting');
    const wsUrl = `ws://${serverIp}:${port}/api/ws?sessionId=${id}&sinceId=${e.sinceId}&cols=${numCols}&rows=${numRows}`;

    const socket = new WebSocket(wsUrl);

    socket.onopen = () => setConnectionStatus('connected');

    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
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
        }
      } catch (err) {
        console.error('ws message error:', err);
      }
    };

    socket.onclose = () => {
      setConnectionStatus('disconnected');
      ws.current = null;
      if (!isConfiguring && activeIdRef.current === id) {
        reconnectTimeout.current = setTimeout(connect, 3000);
      }
    };
    socket.onerror = (e2) => console.log('ws error:', e2);
    ws.current = socket;
  };

  const disconnect = () => {
    if (reconnectTimeout.current) {
      clearTimeout(reconnectTimeout.current);
      reconnectTimeout.current = null;
    }
    if (ws.current) {
      ws.current.close();
      ws.current = null;
    }
    setConnectionStatus('disconnected');
  };

  // Switch to a different session
  const switchTo = (id: string) => {
    setDrawerOpen(false);
    if (id === activeIdRef.current && ws.current) return;
    disconnect();
    activeIdRef.current = id;
    setActiveId(id);
    AsyncStorage.setItem(KEY_SESSION_ID, id);
    const e = entryFor(id); // creates fresh if uncached; resizes handled by effect
    setScreen(e.term.getSnapshot()); // instant paint of last-known screen
    autoScroll.current = true;
    connect();
  };

  const newTerminal = () => {
    const existing = drawerSessions.map((s) => s.id);
    switchTo(nextTermId(existing.length ? existing : cache.ids()));
  };

  const killActiveOr = async (id: string) => {
    try {
      await fetch(`http://${serverIp}:${port}/api/sessions/kill`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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

  const refreshSessions = async () => {
    try {
      const res = await fetch(`http://${serverIp}:${port}/api/sessions`);
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
        const [savedIp, savedPort, savedSession, savedHistory] =
          await Promise.all([
            AsyncStorage.getItem(KEY_SERVER_IP),
            AsyncStorage.getItem(KEY_PORT),
            AsyncStorage.getItem(KEY_SESSION_ID),
            AsyncStorage.getItem(KEY_HISTORY),
          ]);

        if (savedIp) setServerIp(savedIp);
        if (savedPort) setPort(savedPort);
        if (savedSession) {
          setActiveId(savedSession);
          activeIdRef.current = savedSession;
        }
        if (savedHistory) setCommandHistory(JSON.parse(savedHistory));

        if (savedIp) setIsConfiguring(false);
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
    if (ws.current && connectionStatus === 'connected') {
      ws.current.send(JSON.stringify({ type: 'resize', cols: numCols, rows: numRows }));
    }
    scheduleRender();
  }, [numCols, numRows, connectionStatus, activeId]);

  // 2. Manage WebSocket connection
  useEffect(() => {
    if (!isConfiguring) connect();
    else disconnect();
    return () => disconnect();
  }, [isConfiguring, activeId]);

  // Stick to the bottom when the keyboard opens (view shrinks, no new content).
  useEffect(() => {
    const sub = Keyboard.addListener('keyboardDidShow', () => {
      autoScroll.current = true;
      listRef.current?.scrollToEnd({ animated: true });
    });
    return () => sub.remove();
  }, []);

  // 3. Command interactions
  const saveConfig = async () => {
    try {
      await AsyncStorage.multiSet([
        [KEY_SERVER_IP, serverIp],
        [KEY_PORT, port],
        [KEY_SESSION_ID, activeId],
      ]);
      resetTerminal();
      setIsConfiguring(false);
    } catch (e) {
      Alert.alert('Error', 'Failed to save configuration');
    }
  };

  const sendInput = (text: string) => {
    if (ws.current && connectionStatus === 'connected') {
      ws.current.send(JSON.stringify({ type: 'input', text }));
    }
  };

  // Type straight into the terminal: forward each keystroke to the PTY as it is
  // pressed (the shell echoes it back for display). The capture field is pinned
  // to a zero-width sentinel so nothing accumulates locally and Backspace keeps
  // firing on iOS even before anything is typed.
  const handleKeyPress = (e: { nativeEvent: { key: string } }) => {
    const key = e.nativeEvent.key;
    if (key === 'Backspace') sendInput('\x7f');
    else if (key.length === 1) sendInput(key); // printable char (incl. space)
    autoScroll.current = true;
  };

  const resetField = () => setInputText(SENT);

  // Return key: send carriage return (raw-mode TUIs like Claude Code expect \r).
  const handleSend = () => {
    autoScroll.current = true;
    sendInput('\r');
    resetField();
  };

  const navigateHistory = (direction: 'up' | 'down') => {
    if (commandHistory.length === 0) return;

    if (direction === 'up') {
      if (historyIndex < commandHistory.length - 1) {
        const nextIdx = historyIndex + 1;
        setHistoryIndex(nextIdx);
        setInputText(commandHistory[nextIdx]);
      }
    } else {
      if (historyIndex > 0) {
        const nextIdx = historyIndex - 1;
        setHistoryIndex(nextIdx);
        setInputText(commandHistory[nextIdx]);
      } else if (historyIndex === 0) {
        setHistoryIndex(-1);
        setInputText('');
      }
    }
  };

  const hardResetSession = () => {
    Alert.alert(
      'Hard Reset',
      'Are you sure you want to terminate and restart the shell process on the server?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Restart',
          style: 'destructive',
          onPress: async () => {
            resetTerminal();
            try {
              await fetch(`http://${serverIp}:${port}/api/sessions/kill`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
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
    const distanceFromBottom = contentSize.height - layoutMeasurement.height - contentOffset.y;
    autoScroll.current = distanceFromBottom < 40;
  };

  const renderRow = useCallback(
    ({ item }: { item: RenderRow }) => (
      <TermRow row={item} fontSize={fontSize} lineHeight={lineHeight} width={gridWidth} />
    ),
    [fontSize, lineHeight, gridWidth],
  );

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
            <Text style={styles.configTitle}>Tether Mobile</Text>
            <Text style={styles.configSubtitle}>Connect to your persistent agent console</Text>
          </View>

          <View style={styles.formContainer}>
            <Text style={styles.inputLabel}>Server IP / Host</Text>
            <TextInput
              style={styles.configInput}
              value={serverIp}
              onChangeText={setServerIp}
              placeholder="e.g. 192.168.50.30"
              placeholderTextColor="#64748b"
              autoCapitalize="none"
              autoCorrect={false}
            />

            <Text style={styles.inputLabel}>Port</Text>
            <TextInput
              style={styles.configInput}
              value={port}
              onChangeText={setPort}
              placeholder="e.g. 8085"
              placeholderTextColor="#64748b"
              keyboardType="numeric"
              autoCapitalize="none"
              autoCorrect={false}
            />

            <TouchableOpacity style={styles.connectBtn} onPress={saveConfig}>
              <Text style={styles.connectBtnText}>Establish Tether Connection</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      ) : (
        /* Terminal Client Screen */
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.terminalContainer}
        >
          {/* Header Panel */}
          <View style={styles.header}>
            <TouchableOpacity style={styles.headerBtn} onPress={() => { refreshSessions(); setDrawerOpen(true); }}>
              <Text style={styles.headerBtnText}>≡</Text>
            </TouchableOpacity>

            <View style={styles.headerInfo}>
              <Text style={styles.headerTitle}>{activeId}</Text>
              <Text style={styles.headerSubtitle}>{serverIp}:{port}</Text>
            </View>

            <View style={styles.headerControls}>
              {connectionStatus === 'connected' ? (
                <View style={[styles.statusBadge, styles.badgeConnected]}>
                  <View style={[styles.badgeDot, styles.dotConnected]} />
                  <Text style={styles.badgeTextConnected}>Connected</Text>
                </View>
              ) : connectionStatus === 'connecting' ? (
                <View style={[styles.statusBadge, styles.badgeConnecting]}>
                  <ActivityIndicator size={8} color="#fbbf24" style={styles.spinIcon} />
                  <Text style={styles.badgeTextConnecting}>Syncing...</Text>
                </View>
              ) : (
                <View style={[styles.statusBadge, styles.badgeOffline]}>
                  <View style={[styles.badgeDot, styles.dotOffline]} />
                  <Text style={styles.badgeTextOffline}>Offline</Text>
                </View>
              )}

              <TouchableOpacity style={styles.headerBtn} onPress={hardResetSession}>
                <Text style={[styles.headerBtnText, styles.headerBtnTextDanger]}>Reset</Text>
              </TouchableOpacity>

              <TouchableOpacity style={[styles.headerBtn, styles.headerBtnActive]} onPress={() => setIsConfiguring(true)}>
                <Text style={[styles.headerBtnText, styles.headerBtnTextActive]}>Config</Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* Connection banner */}
          {connectionStatus !== 'connected' && (
            <View style={styles.reconnectBanner}>
              <Text style={styles.reconnectBannerText}>
                Reconnecting... Process is preserved safely on the host.
              </Text>
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
            <Pressable style={{ flex: 1 }} onPress={() => inputRef.current?.focus()}>
              <FlatList
                ref={listRef}
                style={{ flex: 1 }}
                contentContainerStyle={styles.terminalContent}
                data={screen}
                renderItem={renderRow}
                keyExtractor={(_, i) => String(i)}
                onScroll={onScroll}
                scrollEventThrottle={100}
                scrollEnabled={!mouseOn}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="none"
                onContentSizeChange={() => {
                  if (autoScroll.current) listRef.current?.scrollToEnd({ animated: false });
                }}
                initialNumToRender={40}
                windowSize={11}
                removeClippedSubviews
              />
            </Pressable>
          </View>

          {/* Session Drawer (overlay) */}
          <SessionDrawer
            visible={drawerOpen}
            sessions={drawerSessions}
            activeId={activeId}
            onSelect={switchTo}
            onNew={newTerminal}
            onKill={killActiveOr}
            onClose={() => setDrawerOpen(false)}
          />

          {/* Mobile Terminal Shortcuts Utility Bar */}
          <View style={styles.utilityBar}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" contentContainerStyle={styles.utilityScroll}>
              <TouchableOpacity style={styles.utilityBtn} onPress={() => sendInput('\x03')}>
                <Text style={[styles.utilityBtnText, styles.utilityBtnTextDanger]}>Ctrl+C</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.utilityBtn} onPress={() => sendInput('\t')}>
                <Text style={styles.utilityBtnText}>Tab</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.utilityBtn} onPress={() => sendInput('\x04')}>
                <Text style={styles.utilityBtnText}>Ctrl+D</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.utilityBtn} onPress={() => sendInput('\x1b')}>
                <Text style={styles.utilityBtnText}>Esc</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.utilityBtn} onPress={() => sendInput('\x1b[A')}>
                <Text style={styles.utilityBtnText}>↑</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.utilityBtn} onPress={() => sendInput('\x1b[B')}>
                <Text style={styles.utilityBtnText}>↓</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.utilityBtn} onPress={() => sendInput('\x1b[D')}>
                <Text style={styles.utilityBtnText}>←</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.utilityBtn} onPress={() => sendInput('\x1b[C')}>
                <Text style={styles.utilityBtnText}>→</Text>
              </TouchableOpacity>

              <TouchableOpacity style={styles.utilityBtn} onPress={() => Keyboard.dismiss()}>
                <Text style={styles.utilityBtnText}>Hide ⌨</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>

          {/* Hidden keyboard-capture field: tapping the terminal focuses it, so
              typing goes straight into the terminal (the shell echoes it back).
              No visible input box. */}
          <TextInput
            ref={inputRef}
            style={styles.hiddenInput}
            value={inputText}
            onKeyPress={handleKeyPress}
            onChangeText={resetField}
            onSubmitEditing={handleSend}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            autoComplete="off"
            blurOnSubmit={false}
            keyboardAppearance="dark"
          />
        </KeyboardAvoidingView>
      )}
    </SafeAreaView>
  );
}

const MONO = Platform.OS === 'ios' ? 'Courier' : 'monospace';

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
    backgroundColor: '#4f46e5',
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

  /* Terminal Screen Styles */
  terminalContainer: {
    flex: 1,
    backgroundColor: '#05070e',
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
  headerBtnActive: {
    backgroundColor: 'rgba(99, 102, 241, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(99, 102, 241, 0.3)',
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
    alignItems: 'center',
  },
  reconnectBannerText: {
    fontSize: 10,
    color: '#fcd34d',
    textAlign: 'center',
  },
  terminalScroll: {
    flex: 1,
    backgroundColor: '#05070e',
  },
  terminalContent: {
    paddingHorizontal: 6,
    paddingVertical: 8,
  },
  termLine: {
    fontFamily: MONO,
    color: '#cbd5e1',
  },
  utilityBar: {
    backgroundColor: '#0b0f19',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.05)',
    paddingVertical: 6,
  },
  utilityScroll: {
    paddingHorizontal: 12,
    alignItems: 'center',
  },
  utilityBtn: {
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 4,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    marginRight: 4,
  },
  utilityBtnText: {
    fontSize: 10,
    fontWeight: '700',
    fontFamily: MONO,
    color: '#cbd5e1',
  },
  utilityBtnTextDanger: {
    color: '#f87171',
  },
  utilityIconBtn: {
    paddingVertical: 5,
    paddingHorizontal: 8,
    borderRadius: 4,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    marginRight: 4,
    justifyContent: 'center',
    alignItems: 'center',
  },
  utilityIconText: {
    fontSize: 10,
    fontFamily: MONO,
    color: '#cbd5e1',
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
    backgroundColor: '#4f46e5',
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
