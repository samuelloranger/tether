import {
  type ForwardedRef,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState, StyleSheet } from 'react-native';
import WebView, { type WebViewMessageEvent } from 'react-native-webview';
import { RendererLifecycle } from './rendererLifecycle';
import type { TerminalViewHandle, TerminalViewProps } from './TerminalView.types';
import { terminalRendererHtml } from './terminalRendererHtml';
import { RendererQueue, RendererRpc } from './terminalRendererProtocol';
import { createTerminalHandle } from './terminalViewHandle';
import {
  handleNativeRendererMessage,
  injectRendererCommand,
  type NativeTerminalCallbacks,
} from './terminalViewNative';

const PROBE_JS = `window.__tetherDispatch && window.ReactNativeWebView.postMessage(JSON.stringify({v:1,type:'pong'}));true;`;

function nativeCallbacks(props: TerminalViewProps): NativeTerminalCallbacks {
  return {
    onRecover: props.onRecover,
    onStatus: props.onStatus,
    onControl: props.onControl,
    onReply: props.onReply,
    onClipboardWrite: props.onClipboardWrite,
    onInput: props.onInput,
    onResize: props.onResize,
    onOpenLink: props.onOpenLink,
    onSelection: props.onSelection,
    onFallback: props.onFallback,
  };
}

function createNativeLifecycle(
  webView: { current: WebView | null },
  rpc: RendererRpc,
  queue: RendererQueue,
  callbacks: { current: NativeTerminalCallbacks },
  setInstance: (update: (n: number) => number) => void,
) {
  return new RendererLifecycle({
    probe: () => webView.current?.injectJavaScript(PROBE_JS),
    remount: () => {
      rpc.clear('remount');
      queue.recover(() => callbacks.current.onRecover());
      setInstance((n) => n + 1);
    },
    onStatus: (status) => callbacks.current.onStatus?.(status),
  });
}

function useNativeTerminalBridge(props: TerminalViewProps, ref: ForwardedRef<TerminalViewHandle>) {
  const webView = useRef<WebView>(null);
  const [instance, setInstance] = useState(0);
  const queue = useMemo(
    () => new RendererQueue((command) => injectRendererCommand(webView.current, command)),
    [],
  );
  const rpc = useMemo(
    () => new RendererRpc((command) => injectRendererCommand(webView.current, command)),
    [],
  );
  const callbacks = useRef(nativeCallbacks(props));
  callbacks.current = nativeCallbacks(props);
  const lifecycle = useMemo(
    () => createNativeLifecycle(webView, rpc, queue, callbacks, setInstance),
    [queue, rpc],
  );
  const hydrateWait = useRef<(() => void) | null>(null);
  useImperativeHandle(
    ref,
    () => createTerminalHandle(queue, rpc, hydrateWait, () => lifecycle.retry()),
    [queue, rpc, lifecycle],
  );
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') lifecycle.foregrounded();
    });
    return () => {
      subscription.remove();
      rpc.clear('disposed');
      lifecycle.dispose();
    };
  }, [lifecycle, rpc]);
  const onMessage = (event: WebViewMessageEvent) =>
    handleNativeRendererMessage(
      event.nativeEvent.data,
      lifecycle,
      queue,
      rpc,
      callbacks.current,
      hydrateWait,
    );
  return { instance, webView, lifecycle, queue, rpc, onMessage };
}

function TerminalWebView({
  instance,
  webView,
  lifecycle,
  queue,
  rpc,
  onMessage,
}: ReturnType<typeof useNativeTerminalBridge>) {
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
        rpc.clear('reload');
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
}

export const TerminalView = forwardRef<TerminalViewHandle, TerminalViewProps>((props, ref) => {
  const bridge = useNativeTerminalBridge(props, ref);
  return <TerminalWebView {...bridge} />;
});

const styles = StyleSheet.create({
  view: { flex: 1, backgroundColor: '#1e1e2e' },
});
