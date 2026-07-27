import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { AppState, StyleSheet } from 'react-native';
import WebView, { type WebViewMessageEvent } from 'react-native-webview';
import { RendererLifecycle } from './rendererLifecycle';
import { terminalRendererHtml } from './terminalRendererHtml';
import { parseRendererEvent, RendererQueue } from './terminalRendererProtocol';
import type { TerminalViewHandle, TerminalViewProps } from './TerminalView.types';

// Liveness probe. Gated on the renderer's own global so a bare about:blank page
// (which still has the ReactNativeWebView bridge) cannot answer for it.
const PROBE_JS = `window.__tetherDispatch && window.ReactNativeWebView.postMessage(JSON.stringify({v:1,type:'pong'}));true;`;

export const TerminalView = forwardRef<TerminalViewHandle, TerminalViewProps>(
  ({ onInput, onResize, onOpenLink, onSelection, onFallback, onRecover, onStatus }, ref) => {
    const webView = useRef<WebView>(null);
    // Bumping this remounts the WebView. Recovery must remount rather than
    // reload(): once iOS has reclaimed the content process there is nothing left
    // to reload, and a WebView that never comes back leaves the terminal a blank
    // white rectangle until the user force-quits the app.
    const [instance, setInstance] = useState(0);
    const queue = useMemo(
      () =>
        new RendererQueue(
          (command) => {
            const json = JSON.stringify(command);
            webView.current?.injectJavaScript(`window.__tetherDispatch(${json});true;`);
          },
          { native: true },
        ),
      [],
    );

    // Callbacks are read through refs so the lifecycle can be built once; it owns
    // timers, and rebuilding it on every render would rearm them.
    const callbacks = useRef({ onRecover, onStatus });
    callbacks.current = { onRecover, onStatus };

    const lifecycle = useMemo(
      () =>
        new RendererLifecycle({
          probe: () => webView.current?.injectJavaScript(PROBE_JS),
          remount: () => {
            queue.recover(() => callbacks.current.onRecover());
            setInstance((n) => n + 1);
          },
          onStatus: (status) => callbacks.current.onStatus?.(status),
        }),
      [queue],
    );

    useImperativeHandle(
      ref,
      () => ({
        hydrate: (...args) => queue.hydrate(...args),
        write: (data) => queue.write(data),
        resize: (cols, rows) => queue.resize(cols, rows),
        scrollToLine: (line) => queue.scrollToLine(line),
        selectAll: () => queue.selectAll(),
        focus: () => queue.focus(),
        blur: () => queue.blur(),
        retry: () => lifecycle.retry(),
      }),
      [queue, lifecycle],
    );

    // Foregrounding is when a reclaimed content process shows up, so that is when
    // the renderer gets asked to prove it is alive.
    useEffect(() => {
      const subscription = AppState.addEventListener('change', (state) => {
        if (state === 'active') lifecycle.foregrounded();
      });
      return () => {
        subscription.remove();
        lifecycle.dispose();
      };
    }, [lifecycle]);

    const onMessage = (event: WebViewMessageEvent) => {
      const message = parseRendererEvent(event.nativeEvent.data);
      if (!message) return;
      // Any well-formed message proves the page is running.
      lifecycle.sawMessage();
      switch (message.type) {
        case 'ready':
          queue.ready();
          lifecycle.pageReady();
          break;
        case 'pong':
          break;
        case 'input':
          onInput(message.text);
          break;
        case 'resize':
          onResize(message.cols, message.rows);
          break;
        case 'openLink':
          onOpenLink(message.target);
          break;
        case 'rendererFallback':
          onFallback(message.reason);
          break;
        case 'selection':
          onSelection?.(message.text);
          break;
      }
    };

    return (
      <WebView
        key={instance}
        ref={webView}
        source={{ html: terminalRendererHtml() }}
        originWhitelist={['*']}
        javaScriptEnabled
        scrollEnabled
        hideKeyboardAccessoryView
        bounces={false}
        overScrollMode="never"
        style={styles.view}
        onLoadStart={() => {
          queue.notReady();
          lifecycle.loadStarted();
        }}
        onMessage={onMessage}
        onError={() => lifecycle.crashed()}
        onHttpError={() => lifecycle.crashed()}
        onContentProcessDidTerminate={() => lifecycle.crashed()}
        onRenderProcessGone={() => lifecycle.crashed()}
        onShouldStartLoadWithRequest={({ url }) => url === 'about:blank'}
      />
    );
  },
);

const styles = StyleSheet.create({
  view: { flex: 1, backgroundColor: '#1e1e2e' },
});
