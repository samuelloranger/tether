<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { ansiToHtml } from './lib/ansi';
  import { Terminal, Cpu, RefreshCw, Trash2, ArrowUp, ArrowDown, Send, ShieldAlert } from 'lucide-svelte';

  // Reactivity runes in Svelte 5
  let sessionId = $state('default');
  let connectionStatus = $state<'connecting' | 'connected' | 'disconnected'>('disconnected');
  let logs = $state<Array<{ id: number; chunk: string; html: string }>>([]);
  let inputText = $state('');
  let sinceId = $state(0);
  let commandHistory = $state<string[]>([]);
  let historyIndex = $state(-1);
  let scrollContainer = $state<HTMLDivElement | null>(null);
  let autoScroll = $state(true);
  let ws = $state<WebSocket | null>(null);
  let reconnectCount = $state(0);
  let cols = $state(80);
  let rows = $state(24);

  // Read saved state on mount
  onMount(() => {
    // Load command history
    const savedHistory = localStorage.getItem('tether_history');
    if (savedHistory) {
      try {
        commandHistory = JSON.parse(savedHistory);
      } catch (e) {}
    }

    // Load sinceId to avoid replay of ancient logs, but still grab recent session logs
    const savedSinceId = localStorage.getItem(`tether_since_${sessionId}`);
    if (savedSinceId) {
      sinceId = Number(savedSinceId);
    }
  });

  // Calculate WebSocket URL based on protocol
  function getWsUrl(): string {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    // Handle Vite dev server port mapping
    const host = window.location.port === '5173' ? `${window.location.hostname}:8085` : window.location.host;
    return `${protocol}//${host}/api/ws?sessionId=${sessionId}&sinceId=${sinceId}&cols=${cols}&rows=${rows}`;
  }

  // Connect to the server WebSocket
  function connect() {
    if (ws) {
      ws.close();
    }

    connectionStatus = 'connecting';
    const url = getWsUrl();
    const socket = new WebSocket(url);

    socket.onopen = () => {
      console.log('Tether connected');
      connectionStatus = 'connected';
      reconnectCount = 0;
    };

    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'output') {
          // Render chunk using our fast ANSI parser
          const html = ansiToHtml(msg.chunk);
          
          // Track unique IDs to avoid duplication during rapid re-sync
          if (msg.id) {
            sinceId = msg.id;
            localStorage.setItem(`tether_since_${sessionId}`, String(sinceId));
            
            // Check if we already have this log ID
            const exists = logs.some(l => l.id === msg.id);
            if (!exists) {
              logs = [...logs, { id: msg.id, chunk: msg.chunk, html }];
            }
          } else {
            // Live broadcast fallback
            logs = [...logs, { id: Date.now(), chunk: msg.chunk, html }];
          }

          // Cap logs length to prevent DOM memory leaks (SQLite has full history)
          if (logs.length > 800) {
            logs = logs.slice(logs.length - 800);
          }

          if (autoScroll) {
            scrollToBottom();
          }
        } else if (msg.type === 'exit') {
          logs = [...logs, {
            id: Date.now(),
            chunk: `\r\n[Process exited with code ${msg.exitCode}]\r\n`,
            html: `<div class="log-exit-msg">[Process exited with code ${msg.exitCode}]</div>`
          }];
        }
      } catch (e) {
        console.error('Error handling WebSocket message:', e);
      }
    };

    socket.onclose = () => {
      console.log('Tether disconnected');
      connectionStatus = 'disconnected';
      ws = null;
      
      // Auto-reconnect with exponential backoff (max 10 seconds delay)
      const delay = Math.min(1000 * Math.pow(2, reconnectCount), 10000);
      reconnectCount += 1;
      setTimeout(() => {
        if (connectionStatus === 'disconnected') {
          connect();
        }
      }, delay);
    };

    socket.onerror = (err) => {
      console.error('WebSocket error:', err);
    };

    ws = socket;
  }

  // Auto-connect and update on session change (only track sessionId)
  $effect(() => {
    const _ = sessionId;
    
    untrack(() => {
      connect();
    });

    return () => {
      untrack(() => {
        if (ws) {
          ws.close();
        }
      });
    };
  });

  // Keep terminal focused on bottom on updates
  function scrollToBottom() {
    setTimeout(() => {
      if (scrollContainer) {
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
      }
    }, 10);
  }

  // Handle manual scroll changes
  function onScroll() {
    if (!scrollContainer) return;
    const threshold = 60; // pixels from bottom
    const isAtBottom = scrollContainer.scrollHeight - scrollContainer.clientHeight - scrollContainer.scrollTop < threshold;
    autoScroll = isAtBottom;
  }

  // Send keyboard commands to backend
  function sendCommand(text: string) {
    if (!ws || connectionStatus !== 'connected') return;
    ws.send(JSON.stringify({ type: 'input', text }));
  }

  // Submit typed command
  function handleSubmit(e?: Event) {
    if (e) e.preventDefault();
    if (!inputText.trim()) return;

    // Add to history list
    commandHistory = [inputText, ...commandHistory.filter(h => h !== inputText)].slice(0, 50);
    localStorage.setItem('tether_history', JSON.stringify(commandHistory));
    historyIndex = -1;

    // Send text with newline to execute in terminal
    sendCommand(inputText + '\n');
    inputText = '';
    autoScroll = true;
    scrollToBottom();
  }

  // Send raw shortcut keys (like Ctrl+C, Ctrl+D)
  function sendShortcut(key: string) {
    sendCommand(key);
    autoScroll = true;
    scrollToBottom();
  }

  // Retrieve command from history
  function navigateHistory(direction: 'up' | 'down') {
    if (commandHistory.length === 0) return;
    
    if (direction === 'up') {
      if (historyIndex < commandHistory.length - 1) {
        historyIndex += 1;
        inputText = commandHistory[historyIndex];
      }
    } else {
      if (historyIndex > 0) {
        historyIndex -= 1;
        inputText = commandHistory[historyIndex];
      } else if (historyIndex === 0) {
        historyIndex = -1;
        inputText = '';
      }
    }
  }

  // Trigger terminal resize
  function handleResize(newCols: number, newRows: number) {
    cols = newCols;
    rows = newRows;
    if (ws && connectionStatus === 'connected') {
      ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  }

  // Clear logs view (does not kill process)
  function clearScreen() {
    logs = [];
    // Reset offset to current
    localStorage.setItem(`tether_since_${sessionId}`, String(sinceId));
  }

  // Kill and restart session
  async function restartSession() {
    if (confirm('Are you sure you want to hard kill the shell session? This will restart the shell process.')) {
      clearScreen();
      sinceId = 0;
      localStorage.setItem(`tether_since_${sessionId}`, '0');
      
      await fetch('/api/sessions/kill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: sessionId }),
      });
      
      connect();
    }
  }

  // Listen to window focus (iOS wake up) to trigger immediate reconnection
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', () => {
      console.log('Window focused - checking socket...');
      if (ws === null || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        connect();
      }
    });
  }
</script>

<div class="tether-container">
  <!-- Top Glassmorphism Navigation Bar -->
  <header class="tether-header">
    <div class="logo-area">
      <div class="logo-icon">
        <Terminal size={18} />
      </div>
      <div class="logo-text">
        <span class="brand-title">Tether</span>
        <span class="brand-subtitle">Persistent Agent Terminal</span>
      </div>
    </div>

    <!-- Active Status Indicators -->
    <div class="controls-area">
      {#if connectionStatus === 'connected'}
        <span class="indicator-badge badge-connected">
          <span class="dot-pulse bg-emerald-400"></span>
          Connected
        </span>
      {:else if connectionStatus === 'connecting'}
        <span class="indicator-badge badge-connecting">
          <RefreshCw size={10} class="spin" />
          Syncing...
        </span>
      {:else}
        <span class="indicator-badge badge-offline">
          <ShieldAlert size={10} />
          Offline
        </span>
      {/if}

      <!-- Quick Session Controls -->
      <button onclick={clearScreen} title="Clear display logs" class="control-btn">
        <Trash2 size={16} />
      </button>

      <button onclick={restartSession} title="Hard reset session" class="control-btn btn-danger">
        <RefreshCw size={16} />
      </button>
    </div>
  </header>

  <!-- Connection Status Banner for Mobile Background recovery -->
  {#if connectionStatus !== 'connected'}
    <div class="alert-banner">
      <span>Tether is reconnecting. Your server process is still running safely in the background.</span>
      <button onclick={connect} class="force-sync-btn">Force Sync</button>
    </div>
  {/if}

  <!-- Terminal Display Port -->
  <div bind:this={scrollContainer} onscroll={onScroll} class="console-view">
    <div class="console-text">
      {#each logs as log (log.id)}
        <!-- Render parsed HTML spans containing correct terminal colors -->
        {@html log.html}
      {/each}
      
      <!-- Auto Scroll anchor -->
      <div class="scroll-anchor"></div>
    </div>
  </div>

  <!-- Mobile Keyboard Shortcuts Utility Bar -->
  <div class="utility-bar">
    <div class="shortcuts-group">
      <button onclick={() => sendShortcut('\x03')} class="utility-btn btn-ctrl">
        Ctrl+C
      </button>
      <button onclick={() => sendShortcut('\t')} class="utility-btn">
        Tab
      </button>
      <button onclick={() => sendShortcut('\x04')} class="utility-btn">
        Ctrl+D
      </button>
      <button onclick={() => sendShortcut('\x1b')} class="utility-btn">
        Esc
      </button>
      <button onclick={() => navigateHistory('up')} class="utility-icon-btn">
        <ArrowUp size={14} />
      </button>
      <button onclick={() => navigateHistory('down')} class="utility-icon-btn">
        <ArrowDown size={14} />
      </button>
    </div>

    <!-- PTY Columns configuration -->
    <div class="resize-group">
      <span class="resize-label">PTY size:</span>
      <button onclick={() => handleResize(80, 24)} class="resize-btn" class:active={cols === 80}>80x24</button>
      <button onclick={() => handleResize(120, 35)} class="resize-btn" class:active={cols === 120}>120x35</button>
    </div>
  </div>

  <!-- Chat-style Input Bar for Touch-screens -->
  <footer class="input-bar">
    <form onsubmit={handleSubmit} class="input-form">
      <input 
        type="text" 
        bind:value={inputText}
        placeholder="Type command or prompt response..."
        autocomplete="off"
        autocorrect="off"
        autocapitalize="none"
        spellcheck="false"
        class="command-input"
      />
      
      <button 
        type="submit" 
        disabled={connectionStatus !== 'connected'}
        class="send-btn"
      >
        <Send size={14} />
      </button>
    </form>
  </footer>
</div>

<style>
  /* Base Layout */
  .tether-container {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background-color: #070a13;
    color: #cbd5e1;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    overflow: hidden;
  }

  /* Header CSS */
  .tether-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: calc(0.75rem + env(safe-area-inset-top, 0px)) calc(1rem + env(safe-area-inset-right, 0px)) 0.75rem calc(1rem + env(safe-area-inset-left, 0px));
    border-b: 1px solid rgba(255, 255, 255, 0.1);
    background-color: rgba(11, 15, 25, 0.8);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    z-index: 10;
  }
  .logo-area {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .logo-icon {
    padding: 0.5rem;
    border-radius: 0.5rem;
    background-color: rgba(99, 102, 241, 0.1);
    border: 1px solid rgba(99, 102, 241, 0.2);
    color: #818cf8;
    display: flex;
    align-items: center;
  }
  .logo-text {
    display: flex;
    flex-direction: column;
  }
  .brand-title {
    font-weight: 700;
    font-size: 0.875rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #ffffff;
  }
  .brand-subtitle {
    font-size: 10px;
    color: #94a3b8;
  }

  /* Controls Area CSS */
  .controls-area {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .control-btn {
    padding: 0.375rem;
    border-radius: 0.375rem;
    background: transparent;
    border: none;
    color: #94a3b8;
    cursor: pointer;
    transition: all 0.2s;
    display: flex;
    align-items: center;
  }
  .control-btn:hover {
    background-color: rgba(255, 255, 255, 0.05);
    color: #ffffff;
  }
  .control-btn.btn-danger:hover {
    background-color: rgba(239, 68, 68, 0.1);
    color: #f87171;
  }

  /* Badges CSS */
  .indicator-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.125rem 0.625rem;
    border-radius: 9999px;
    font-size: 0.75rem;
    font-weight: 500;
    border: 1px solid;
  }
  .badge-connected {
    background-color: rgba(16, 185, 129, 0.1);
    color: #34d399;
    border-color: rgba(16, 185, 129, 0.2);
  }
  .badge-connecting {
    background-color: rgba(245, 158, 11, 0.1);
    color: #fbbf24;
    border-color: rgba(245, 158, 11, 0.2);
  }
  .badge-offline {
    background-color: rgba(239, 68, 68, 0.1);
    color: #f87171;
    border-color: rgba(239, 68, 68, 0.2);
  }
  .dot-pulse {
    width: 0.375rem;
    height: 0.375rem;
    border-radius: 9999px;
    background-color: #34d399;
    animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
  }

  /* Alert Banner CSS */
  .alert-banner {
    background-color: rgba(245, 158, 11, 0.15);
    border-b: 1px solid rgba(245, 158, 11, 0.25);
    color: #fcd34d;
    padding: 0.5rem 1rem;
    font-size: 0.75rem;
    display: flex;
    justify-content: space-between;
    align-items: center;
    animation: flash 2.5s infinite;
  }
  .force-sync-btn {
    background: transparent;
    border: none;
    text-decoration: underline;
    font-weight: 600;
    color: #ffffff;
    cursor: pointer;
  }

  /* Console CSS */
  .console-view {
    flex: 1;
    overflow-y: auto;
    padding: 0.75rem 1rem;
    background-color: #05070e;
    font-family: Consolas, Monaco, "Andale Mono", "Ubuntu Mono", monospace;
    font-size: 0.8125rem;
    line-height: 1.5;
  }
  .console-text {
    word-break: break-all;
    white-space: pre-wrap;
  }
  .scroll-anchor {
    height: 1rem;
  }
  :global(.log-exit-msg) {
    color: #ef4444;
    font-weight: bold;
    margin: 0.5rem 0;
  }

  /* Utility CSS */
  .utility-bar {
    background-color: #0b0f19;
    border-top: 1px solid rgba(255, 255, 255, 0.05);
    padding: 0.375rem 0.5rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    overflow-x: auto;
  }
  .shortcuts-group {
    display: flex;
    gap: 0.25rem;
    align-items: center;
  }
  .utility-btn {
    padding: 0.25rem 0.625rem;
    border-radius: 4px;
    background-color: rgba(255, 255, 255, 0.05);
    border: none;
    color: #94a3b8;
    font-size: 0.6875rem;
    font-weight: 700;
    font-family: monospace;
    cursor: pointer;
    transition: all 0.2s;
  }
  .utility-btn:hover {
    background-color: rgba(255, 255, 255, 0.1);
    color: #ffffff;
  }
  .utility-btn.btn-ctrl {
    color: #ef4444;
  }
  .utility-icon-btn {
    padding: 0.25rem;
    border-radius: 4px;
    background-color: rgba(255, 255, 255, 0.05);
    border: none;
    color: #94a3b8;
    cursor: pointer;
    display: flex;
    align-items: center;
  }
  .utility-icon-btn:hover {
    background-color: rgba(255, 255, 255, 0.1);
    color: #ffffff;
  }

  /* Resize CSS */
  .resize-group {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.6875rem;
    color: #94a3b8;
    font-family: monospace;
    padding-left: 0.5rem;
  }
  .resize-label {
    white-space: nowrap;
  }
  .resize-btn {
    background-color: rgba(255, 255, 255, 0.03);
    border: none;
    color: #64748b;
    padding: 0.125rem 0.25rem;
    border-radius: 4px;
    cursor: pointer;
    font-family: monospace;
  }
  .resize-btn:hover {
    color: #ffffff;
  }
  .resize-btn.active {
    color: #818cf8;
    background-color: rgba(99, 102, 241, 0.1);
  }

  /* Footer & Input Bar CSS */
  .input-bar {
    background-color: #0b0f19;
    border-top: 1px solid rgba(255, 255, 255, 0.1);
    padding: 0.75rem calc(0.75rem + env(safe-area-inset-right, 0px)) calc(0.75rem + env(safe-area-inset-bottom, 0px)) calc(0.75rem + env(safe-area-inset-left, 0px));
    z-index: 10;
  }
  .input-form {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background-color: #030712;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 0.75rem;
    padding: 0.125rem 0.75rem;
    transition: border-color 0.2s;
  }
  .input-form:focus-within {
    border-color: rgba(99, 102, 241, 0.5);
  }
  .command-input {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    color: #e2e8f0;
    font-size: 16px;
    font-family: monospace;
    padding: 0.5rem 0;
  }
  .send-btn {
    padding: 0.5rem;
    border-radius: 0.5rem;
    background-color: #4f46e5;
    border: none;
    color: #ffffff;
    cursor: pointer;
    transition: background-color 0.2s;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .send-btn:hover {
    background-color: #4338ca;
  }
  .send-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  /* Animations */
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: .5; }
  }
  @keyframes flash {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.8; }
  }
  :global(.spin) {
    animation: spin 1.5s linear infinite;
  }
  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }

  /* Hide scrollbars on shortcuts group */
  .utility-bar::-webkit-scrollbar {
    display: none;
  }
  .utility-bar {
    -ms-overflow-style: none;
    scrollbar-width: none;
  }
</style>
