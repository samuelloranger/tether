import { forwardRef, useImperativeHandle, useMemo, useRef } from 'react';
import { StyleSheet } from 'react-native';
import WebView, { type WebViewMessageEvent } from 'react-native-webview';
import { terminalRendererHtml } from './terminalRendererHtml';
import { parseRendererEvent, RendererQueue } from './terminalRendererProtocol';
import type { TerminalViewHandle, TerminalViewProps } from './TerminalView.types';

export const TerminalView = forwardRef<TerminalViewHandle, TerminalViewProps>(
  ({ onInput, onResize, onOpenLink, onSelection, onFallback }, ref) => {
    const webView = useRef<WebView>(null);
    const queue = useMemo(
      () =>
        new RendererQueue((command) => {
          const json = JSON.stringify(command);
          webView.current?.injectJavaScript(`window.__tetherDispatch(${json});true;`);
        }),
      [],
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
      }),
      [queue],
    );

    const onMessage = (event: WebViewMessageEvent) => {
      const message = parseRendererEvent(event.nativeEvent.data);
      if (!message) return;
      switch (message.type) {
        case 'ready':
          queue.ready();
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

    const recover = () => {
      queue.notReady();
      webView.current?.reload();
    };

    return (
      <WebView
        ref={webView}
        source={{ html: terminalRendererHtml() }}
        originWhitelist={['*']}
        javaScriptEnabled
        scrollEnabled={false}
        bounces={false}
        overScrollMode="never"
        style={styles.view}
        onLoadStart={() => queue.notReady()}
        onMessage={onMessage}
        onContentProcessDidTerminate={recover}
        onRenderProcessGone={recover}
        onShouldStartLoadWithRequest={({ url }) => url === 'about:blank'}
      />
    );
  },
);

const styles = StyleSheet.create({
  view: { flex: 1, backgroundColor: '#1e1e2e' },
});
