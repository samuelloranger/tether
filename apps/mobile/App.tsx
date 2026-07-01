import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  Alert,
  ActivityIndicator,
  Keyboard,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { parseAnsi, TextSegment } from './src/ansi';

// Constants for async storage keys
const KEY_SERVER_IP = 'tether_server_ip';
const KEY_PORT = 'tether_port';
const KEY_SESSION_ID = 'tether_session_id';
const KEY_COLS = 'tether_cols';
const KEY_ROWS = 'tether_rows';
const KEY_HISTORY = 'tether_history';

interface LogMessage {
  id: number;
  segments: TextSegment[];
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
  const [logs, setLogs] = useState<LogMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [sinceId, setSinceId] = useState(0);

  // References
  const ws = useRef<WebSocket | null>(null);
  const scrollViewRef = useRef<ScrollView | null>(null);
  const reconnectTimeout = useRef<any>(null);
  const isConnected = useRef(false);

  // 1. Load saved config on mount
  useEffect(() => {
    async function loadConfig() {
      try {
        const savedIp = await AsyncStorage.getItem(KEY_SERVER_IP);
        const savedPort = await AsyncStorage.getItem(KEY_PORT);
        const savedSession = await AsyncStorage.getItem(KEY_SESSION_ID);
        const savedCols = await AsyncStorage.getItem(KEY_COLS);
        const savedRows = await AsyncStorage.getItem(KEY_ROWS);
        const savedHistory = await AsyncStorage.getItem(KEY_HISTORY);

        if (savedIp) setServerIp(savedIp);
        if (savedPort) setPort(savedPort);
        if (savedSession) setSessionId(savedSession);
        if (savedCols) setCols(savedCols);
        if (savedRows) setRows(savedRows);
        if (savedHistory) {
          setCommandHistory(JSON.parse(savedHistory));
        }

        // Auto-connect if we have saved IP
        if (savedIp) {
          setIsConfiguring(false);
        }
      } catch (e) {
        console.error('Failed to load configuration:', e);
      }
    }

    loadConfig();

    return () => {
      disconnect();
    };
  }, []);

  // 2. Manage WebSockets
  useEffect(() => {
    if (!isConfiguring) {
      connect();
    } else {
      disconnect();
    }

    return () => {
      disconnect();
    };
  }, [isConfiguring, sessionId]);

  const connect = () => {
    disconnect();

    setConnectionStatus('connecting');
    const wsUrl = `ws://${serverIp}:${port}/api/ws?sessionId=${sessionId}&sinceId=${sinceId}&cols=${cols}&rows=${rows}`;
    console.log(`Connecting to WebSocket: ${wsUrl}`);

    const socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      console.log('Tether WebSocket connected');
      setConnectionStatus('connected');
      isConnected.current = true;
    };

    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'output') {
          // Parse ANSI codes to styled Text segments
          const segments = parseAnsi(msg.chunk);
          
          if (msg.id) {
            setSinceId(msg.id);
            setLogs((prevLogs) => {
              // Avoid duplicates
              if (prevLogs.some((l) => l.id === msg.id)) return prevLogs;
              const newLogs = [...prevLogs, { id: msg.id, segments }];
              return newLogs.slice(-800); // limit local log array length
            });
          } else {
            // Live logs fallback
            setLogs((prevLogs) => {
              const newLogs = [...prevLogs, { id: Date.now(), segments }];
              return newLogs.slice(-800);
            });
          }
        } else if (msg.type === 'exit') {
          setLogs((prevLogs) => [
            ...prevLogs,
            {
              id: Date.now(),
              segments: [
                {
                  text: `\n[Process exited with code ${msg.exitCode}]\n`,
                  style: { color: '#ef4444', fontWeight: 'bold' },
                },
              ],
            },
          ]);
        }
      } catch (e) {
        console.error('Failed to handle WebSocket message:', e);
      }
    };

    socket.onclose = () => {
      console.log('Tether WebSocket disconnected');
      setConnectionStatus('disconnected');
      isConnected.current = false;
      ws.current = null;

      // Exponential backoff reconnect
      if (!isConfiguring) {
        console.log('Scheduling reconnect in 3s...');
        reconnectTimeout.current = setTimeout(() => {
          connect();
        }, 3000);
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
    isConnected.current = false;
    setConnectionStatus('disconnected');
  };

  // 3. Command Interactions
  const saveConfig = async () => {
    try {
      await AsyncStorage.setItem(KEY_SERVER_IP, serverIp);
      await AsyncStorage.setItem(KEY_PORT, port);
      await AsyncStorage.setItem(KEY_SESSION_ID, sessionId);
      await AsyncStorage.setItem(KEY_COLS, cols);
      await AsyncStorage.setItem(KEY_ROWS, rows);
      setSinceId(0);
      setLogs([]);
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

  const sendShortcut = (text: string) => {
    sendInput(text);
  };

  const handleSend = () => {
    if (!inputText.trim()) return;

    // Save to history
    const newHistory = [inputText, ...commandHistory.filter((h) => h !== inputText)].slice(0, 50);
    setCommandHistory(newHistory);
    AsyncStorage.setItem(KEY_HISTORY, JSON.stringify(newHistory));
    setHistoryIndex(-1);

    // Send with newline
    sendInput(inputText + '\n');
    setInputText('');
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

  const triggerResize = (newCols: number, newRows: number) => {
    setCols(String(newCols));
    setRows(String(newRows));
    if (ws.current && connectionStatus === 'connected') {
      ws.current.send(JSON.stringify({ type: 'resize', cols: newCols, rows: newRows }));
    }
  };

  const clearLogs = () => {
    setLogs([]);
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
            clearLogs();
            setSinceId(0);
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
            <Text style={styles.inputLabel}>Server IP Address</Text>
            <TextInput
              style={styles.configInput}
              value={serverIp}
              onChangeText={setServerIp}
              placeholder="e.g. 192.168.50.30"
              placeholderTextColor="#64748b"
              keyboardType="numeric"
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
          keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
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

          {/* Logs scroll port */}
          <ScrollView
            ref={scrollViewRef}
            style={styles.terminalScroll}
            contentContainerStyle={styles.terminalContent}
            onContentSizeChange={() => scrollViewRef.current?.scrollToEnd({ animated: true })}
          >
            <View style={styles.preText}>
              {logs.map((log) => (
                <Text key={log.id}>
                  {log.segments.map((seg, segIdx) => (
                    <Text
                      key={segIdx}
                      style={[
                        styles.terminalMono,
                        seg.style.color ? { color: seg.style.color } : null,
                        seg.style.fontWeight === 'bold' ? { fontWeight: 'bold' } : null,
                        seg.style.fontStyle === 'italic' ? { fontStyle: 'italic' } : null,
                        seg.style.textDecorationLine === 'underline' ? { textDecorationLine: 'underline' } : null,
                        seg.style.backgroundColor ? { backgroundColor: seg.style.backgroundColor } : null,
                      ]}
                    >
                      {seg.text}
                    </Text>
                  ))}
                </Text>
              ))}
            </View>
          </ScrollView>

          {/* Mobile Terminal Shortcuts Utility Bar */}
          <View style={styles.utilityBar}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.utilityScroll}>
              <TouchableOpacity style={styles.utilityBtn} onPress={() => sendShortcut('\x03')}>
                <Text style={[styles.utilityBtnText, styles.utilityBtnTextDanger]}>Ctrl+C</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.utilityBtn} onPress={() => sendShortcut('\t')}>
                <Text style={styles.utilityBtnText}>Tab</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.utilityBtn} onPress={() => sendShortcut('\x04')}>
                <Text style={styles.utilityBtnText}>Ctrl+D</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.utilityBtn} onPress={() => sendShortcut('\x1b')}>
                <Text style={styles.utilityBtnText}>Esc</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.utilityIconBtn} onPress={() => navigateHistory('up')}>
                <Text style={styles.utilityIconText}>▲</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.utilityIconBtn} onPress={() => navigateHistory('down')}>
                <Text style={styles.utilityIconText}>▼</Text>
              </TouchableOpacity>

              <View style={styles.resizeSpacer} />
              
              <TouchableOpacity style={[styles.resizeBtn, cols === '80' && styles.resizeBtnActive]} onPress={() => triggerResize(80, 24)}>
                <Text style={[styles.resizeBtnText, cols === '80' && styles.resizeBtnTextActive]}>80x24</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.resizeBtn, cols === '120' && styles.resizeBtnActive]} onPress={() => triggerResize(120, 35)}>
                <Text style={[styles.resizeBtnText, cols === '120' && styles.resizeBtnTextActive]}>120x35</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>

          {/* Send Input Bar */}
          <View style={styles.inputBar}>
            <View style={styles.inputBoxContainer}>
              <TextInput
                style={styles.terminalInput}
                value={inputText}
                onChangeText={setInputText}
                placeholder="Type command or agent prompt response..."
                placeholderTextColor="#475569"
                onSubmitEditing={handleSend}
                autoCapitalize="none"
                autoCorrect={false}
                blurOnSubmit={false}
              />
              <TouchableOpacity
                style={[styles.sendBtn, connectionStatus !== 'connected' && styles.sendBtnDisabled]}
                onPress={handleSend}
                disabled={connectionStatus !== 'connected'}
              >
                <Text style={styles.sendBtnText}>Send</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      )}
    </SafeAreaView>
  );
}

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
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
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
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
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
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  terminalContent: {
    paddingBottom: 24,
  },
  preText: {
    flexDirection: 'column',
  },
  terminalMono: {
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    fontSize: 12,
    lineHeight: 16,
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
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    color: '#cbd5e1',
  },
  utilityBtnTextDanger: {
    color: '#f87171',
  },
  utilityIconBtn: {
    padding: 5,
    borderRadius: 4,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    marginRight: 4,
    justifyContent: 'center',
    alignItems: 'center',
    width: 26,
    height: 24,
  },
  utilityIconText: {
    fontSize: 10,
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
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
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
  terminalInput: {
    flex: 1,
    color: '#e2e8f0',
    fontSize: 16,
    paddingVertical: 8,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
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
