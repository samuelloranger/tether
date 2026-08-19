import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import type { TerminalViewHandle, TerminalViewProps } from './TerminalView.types';
import { TERMINAL_RENDERER_CSS } from './terminalRenderer.generated';
import { type RendererCommand, RendererQueue, RendererRpc } from './terminalRendererProtocol';
import { type DesktopTerminalCallbacks, mountDesktopTerminal } from './terminalViewDesktop';
import { createTerminalHandle } from './terminalViewHandle';

function desktopCallbacks(props: TerminalViewProps): DesktopTerminalCallbacks {
  return {
    onInput: props.onInput,
    onResize: props.onResize,
    onOpenLink: props.onOpenLink,
    onSelection: props.onSelection,
    onControl: props.onControl,
    onReply: props.onReply,
    onClipboardWrite: props.onClipboardWrite,
    onPaste: props.onPaste,
    onNewTerminal: props.onNewTerminal,
    onFontZoom: props.onFontZoom,
    onFallback: props.onFallback,
    onStatus: props.onStatus,
  };
}

export const TerminalView = forwardRef<TerminalViewHandle, TerminalViewProps>((props, ref) => {
  const container = useRef<HTMLDivElement>(null);
  const callbacks = useRef(desktopCallbacks(props));
  callbacks.current = desktopCallbacks(props);
  const dispatch = useRef<(command: RendererCommand) => void>(() => {});
  const hydrateWait = useRef<(() => void) | null>(null);
  const queue = useMemo(() => new RendererQueue((command) => dispatch.current(command)), []);
  const rpc = useMemo(() => new RendererRpc((command) => dispatch.current(command)), []);
  useImperativeHandle(ref, () => createTerminalHandle(queue, rpc, hydrateWait, () => {}), [
    queue,
    rpc,
  ]);
  useEffect(() => {
    if (!container.current) return;
    return mountDesktopTerminal({
      container: container.current,
      rpc,
      queue,
      callbacks,
      hydrateWait,
      dispatch,
    });
  }, [queue, rpc]);
  return (
    <div style={{ width: '100%', height: '100%', overflow: 'hidden' }}>
      <style>{TERMINAL_RENDERER_CSS}</style>
      <style>{'.xterm .xterm-viewport{background-color:transparent}'}</style>
      <div ref={container} style={{ width: '100%', height: '100%' }} />
    </div>
  );
});
