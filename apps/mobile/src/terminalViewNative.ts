import type WebView from 'react-native-webview';
import type { LinkTarget } from './links';
import type { RendererLifecycle } from './rendererLifecycle';
import {
  parseRendererEvent,
  type RendererQueue,
  type RendererRpc,
} from './terminalRendererProtocol';
import type { PageControlEvent } from './tether/pageControlState';

export type NativeTerminalCallbacks = {
  onInput: (text: string) => void;
  onResize: (cols: number, rows: number) => void;
  onOpenLink: (target: LinkTarget) => void;
  onSelection?: (text: string) => void;
  onControl?: (event: PageControlEvent) => void;
  onReply?: (data: string) => void;
  onClipboardWrite?: (text: string) => void;
  onFallback: (reason: string) => void;
  onRecover: () => void;
  onStatus?: (status: import('./rendererLifecycle').RendererStatus) => void;
};

export function injectRendererCommand(webView: WebView | null, command: unknown) {
  const json = JSON.stringify(command);
  webView?.injectJavaScript(`window.__tetherDispatch(${json});true;`);
}

function applyNativeEvent(
  message: NonNullable<ReturnType<typeof parseRendererEvent>>,
  lifecycle: RendererLifecycle,
  queue: RendererQueue,
  rpc: RendererRpc,
  callbacks: NativeTerminalCallbacks,
  hydrateWait: { current: (() => void) | null },
) {
  switch (message.type) {
    case 'ready':
      queue.ready();
      lifecycle.pageReady();
      break;
    case 'pong':
      break;
    case 'input':
      callbacks.onInput(message.text);
      break;
    case 'resize':
      callbacks.onResize(message.cols, message.rows);
      break;
    case 'openLink':
      callbacks.onOpenLink(message.target);
      break;
    case 'rendererFallback':
      callbacks.onFallback(message.reason);
      break;
    case 'selection':
      callbacks.onSelection?.(message.text);
      break;
    case 'serialized':
      rpc.settle(message.requestId, {
        data: message.data,
        promptLines: message.promptLines,
      });
      break;
    case 'snapshotText':
      rpc.settle(message.requestId, message.text);
      break;
    case 'hydrated':
      hydrateWait.current?.();
      hydrateWait.current = null;
      break;
    case 'reply':
      callbacks.onReply?.(message.data);
      break;
    case 'clipboardWrite':
      callbacks.onClipboardWrite?.(message.text);
      break;
    case 'title':
    case 'cwd':
    case 'bell':
    case 'notify':
    case 'promptReturn':
    case 'modes':
      callbacks.onControl?.(message);
      break;
  }
}

export function handleNativeRendererMessage(
  data: string,
  lifecycle: RendererLifecycle,
  queue: RendererQueue,
  rpc: RendererRpc,
  callbacks: NativeTerminalCallbacks,
  hydrateWait: { current: (() => void) | null },
) {
  const message = parseRendererEvent(data);
  if (!message) return;
  lifecycle.sawMessage();
  applyNativeEvent(message, lifecycle, queue, rpc, callbacks, hydrateWait);
}
