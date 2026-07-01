import React, { useState, useEffect, useRef } from 'react';
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

// Constants for async storage keys
const KEY_SERVER_IP = 'tether_server_ip';
const KEY_PORT = 'tether_port';
const KEY_SESSION_ID = 'tether_session_id';
const KEY_COLS = 'tether_cols';
const KEY_ROWS = 'tether_rows';
const KEY_HISTORY = 'tether_history';

// Zero-width sentinel kept in the capture field so it's never "empty" — lets iOS
// fire onChangeText for Backspace even with nothing typed yet.
const SENT = '\u200b';

function runToStyle(s: CellStyle): TextStyle {
  const style: TextStyle = {};
  if (s.fg) style.color = s.fg;
  if (s.bg) style.backgroundColor = s.bg;
  if (s.bold) style.fontWeight = 'bold';
  if (s.italic) style.fontStyle = 'italic';
  if (s.underline) style.textDecorationLine = 'underline';
  return style;
}

export default function App() {
  // Connection states
  const [serverIp, setServerIp] = useState('192.168.50.30');
  const [port, setPort] = useState('8085');
  const [sessionId, setSessionId] = useState('default');
  const [cols, setCols] = useState('80');
  const [rows, setRows] = useState('24');

  // UI states
  const [isConfiguring, setIsConfiguring] = useState(true);
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'disconnected'>('disconnected');
  const [screen, setScreen] = useState<RenderRow[]>([]);
  const [inputText, setInputText] = useState(SENT);
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [termHeight, setTermHeight] = useState(0);
  const [mouseOn, setMouseOn] = useState(false);

  // References
  const ws = useRef<WebSocket | null>(null);
  const listRef = useRef<FlatList<RenderRow> | null>(null);
  const inputRef = useRef<TextInput | null>(null);
  const reconnectTimeout = useRef<any>(null);
  const term = useRef(new TerminalEmulator(80, 24));
  const sinceId = useRef(0);
  const lastAppliedId = useRef(0);
  const autoScroll = useRef(true);
  const renderScheduled = useRef(false);
  const mouseOnRef = useRef(false); // stable mirror of mouseOn for the pan handler
  const wheelAccum = useRef(0);
  const lastDy = useRef(0);

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
        const wheel = (btn: number) => {
          const col = Math.max(1, Math.floor(term.current.cols / 2));
          const row = Math.max(1, Math.floor(term.current.rows / 2));
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
      setScreen(term.current.getSnapshot());
      if (term.current.mouseOn !== mouseOnRef.current) {
        mouseOnRef.current = term.current.mouseOn;
        setMouseOn(term.current.mouseOn);
      }
    }, 16);
  };

  const resetTerminal = () => {
    term.current.reset();
    sinceId.current = 0;
    lastAppliedId.current = 0;
    setScreen(term.current.getSnapshot());
  };

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

  // 1. Load saved config on mount
  useEffect(() => {
    async function loadConfig() {
      try {
        const [savedIp, savedPort, savedSession, savedCols, savedRows, savedHistory] =
          await Promise.all([
            AsyncStorage.getItem(KEY_SERVER_IP),
            AsyncStorage.getItem(KEY_PORT),
            AsyncStorage.getItem(KEY_SESSION_ID),
            AsyncStorage.getItem(KEY_COLS),
            AsyncStorage.getItem(KEY_ROWS),
            AsyncStorage.getItem(KEY_HISTORY),
          ]);

        if (savedIp) setServerIp(savedIp);
        if (savedPort) setPort(savedPort);
        if (savedSession) setSessionId(savedSession);
        if (savedCols) setCols(savedCols);
        if (savedRows) setRows(savedRows);
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
    term.current.resize(numCols, numRows);
    if (ws.current && connectionStatus === 'connected') {
      ws.current.send(JSON.stringify({ type: 'resize', cols: numCols, rows: numRows }));
    }
    scheduleRender();
  }, [numCols, numRows, connectionStatus]);

  // 2. Manage WebSocket connection
  useEffect(() => {
    if (!isConfiguring) connect();
    else disconnect();
    return () => disconnect();
  }, [isConfiguring, sessionId]);

  // Stick to the bottom when the keyboard opens (view shrinks, no new content).
  useEffect(() => {
    const sub = Keyboard.addListener('keyboardDidShow', () => {
      autoScroll.current = true;
      listRef.current?.scrollToEnd({ animated: true });
    });
    return () => sub.remove();
  }, []);

  const connect = () => {
    disconnect();

    setConnectionStatus('connecting');
    const wsUrl = `ws://${serverIp}:${port}/api/ws?sessionId=${sessionId}&sinceId=${sinceId.current}&cols=${numCols}&rows=${numRows}`;
    console.log(`Connecting to WebSocket: ${wsUrl}`);

    const socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      console.log('Tether WebSocket connected');
      setConnectionStatus('connected');
    };

    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'output') {
          // Dedup: the server replays logs with ids > sinceId on (re)connect.
          if (msg.id) {
            if (msg.id <= lastAppliedId.current) return;
            lastAppliedId.current = msg.id;
            sinceId.current = msg.id;
          }
          term.current.write(msg.chunk);
          scheduleRender();
        } else if (msg.type === 'exit') {
          term.current.write(`\r\n\x1b[31m[Process exited with code ${msg.exitCode}]\x1b[0m\r\n`);
          scheduleRender();
        }
      } catch (e) {
        console.error('Failed to handle WebSocket message:', e);
      }
    };

    socket.onclose = () => {
      console.log('Tether WebSocket disconnected');
      setConnectionStatus('disconnected');
      ws.current = null;

      if (!isConfiguring) {
        reconnectTimeout.current = setTimeout(connect, 3000);
      }
    };

    socket.onerror = (e) => {
      console.log('Tether WebSocket error:', e);
    };

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

  // 3. Command interactions
  const saveConfig = async () => {
    try {
      await AsyncStorage.multiSet([
        [KEY_SERVER_IP, serverIp],
        [KEY_PORT, port],
        [KEY_SESSION_ID, sessionId],
        [KEY_COLS, cols],
        [KEY_ROWS, rows],
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

  const clearLogs = () => {
    term.current.reset();
    setScreen(term.current.getSnapshot());
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
                body: JSON.stringify({ id: sessionId }),
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

  const renderRow = ({ item }: { item: RenderRow }) => (
    <Text style={[styles.termLine, { fontSize, lineHeight, width: gridWidth }]} numberOfLines={1}>
      {item.runs.map((run, i) => (
        <Text key={i} style={runToStyle(run.style)}>
          {run.text}
        </Text>
      ))}
    </Text>
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

            <Text style={styles.inputLabel}>Session Name</Text>
            <TextInput
              style={styles.configInput}
              value={sessionId}
              onChangeText={setSessionId}
              placeholder="e.g. default"
              placeholderTextColor="#64748b"
              autoCapitalize="none"
              autoCorrect={false}
            />

            <View style={styles.rowInputs}>
              <View style={styles.halfInput}>
                <Text style={styles.inputLabel}>Columns</Text>
                <TextInput
                  style={styles.configInput}
                  value={cols}
                  onChangeText={setCols}
                  keyboardType="numeric"
                />
              </View>
              <View style={styles.halfInput}>
                <Text style={styles.inputLabel}>Rows</Text>
                <TextInput
                  style={styles.configInput}
                  value={rows}
                  onChangeText={setRows}
                  keyboardType="numeric"
                />
              </View>
            </View>

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
            <View style={styles.headerInfo}>
              <Text style={styles.headerTitle}>Tether Console</Text>
              <Text style={styles.headerSubtitle}>
                {serverIp}:{port}
              </Text>
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

              <TouchableOpacity style={styles.headerBtn} onPress={clearLogs}>
                <Text style={styles.headerBtnText}>Clear</Text>
              </TouchableOpacity>

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
