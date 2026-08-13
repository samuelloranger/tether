import AsyncStorage from '@react-native-async-storage/async-storage';
import { type RefObject, useEffect, useRef, useState } from 'react';
import type { GestureResponderEvent, LayoutChangeEvent, View as RNView } from 'react-native';
import {
  clampGitDrawerLeftWidth,
  defaultGitDrawerLeftWidth,
  drawerEscapeAction,
} from './gitDrawerLayout';

export function useGitDrawerLeftWidth(storageKey: string) {
  const [bodyWidth, setBodyWidth] = useState(0);
  const [leftWidth, setLeftWidth] = useState<number | null>(null);
  const leftWidthRef = useRef<number | null>(null);
  leftWidthRef.current = leftWidth;
  useEffect(() => {
    void AsyncStorage.getItem(storageKey).then((raw) => {
      const n = raw ? Number(raw) : NaN;
      if (Number.isFinite(n) && n > 0) setLeftWidth(n);
    });
  }, [storageKey]);
  const resolvedLeft =
    bodyWidth > 0
      ? leftWidth !== null
        ? clampGitDrawerLeftWidth(leftWidth, bodyWidth)
        : defaultGitDrawerLeftWidth(bodyWidth)
      : null;
  const onBodyLayout = (event: LayoutChangeEvent) => {
    const next = event.nativeEvent.layout.width;
    setBodyWidth(next);
    setLeftWidth((prev) => (prev === null ? prev : clampGitDrawerLeftWidth(prev, next)));
  };
  return { bodyWidth, setLeftWidth, leftWidthRef, resolvedLeft, onBodyLayout };
}

type EscapeOpts = {
  viewingCommit: boolean;
  selectedPath: string | null;
  onBack: () => void;
  onDeselectFile: () => void;
  onSelectCommit: (entry: null) => void;
};

function onDrawerKeyDown(
  event: KeyboardEvent,
  drawerRef: RefObject<RNView | null>,
  opts: EscapeOpts,
) {
  if (event.key !== 'Escape') return;
  const root = drawerRef.current as unknown as { contains?: (n: Node) => boolean } | null;
  const target = event.target as Node | null;
  const el = event.target as HTMLElement | null;
  const inDrawer = Boolean(root?.contains && target && root.contains(target));
  const isTextField = el?.tagName === 'TEXTAREA' || el?.tagName === 'INPUT';
  const isDocumentRoot = target === document.body || target === document.documentElement;
  const action = drawerEscapeAction({ inDrawer, isTextField, isDocumentRoot });
  if (action === 'ignore') return;
  event.preventDefault();
  event.stopPropagation();
  if (action === 'blur-field') {
    el?.blur();
    return;
  }
  if (opts.viewingCommit) opts.onSelectCommit(null);
  else if (opts.selectedPath) opts.onDeselectFile();
  else opts.onBack();
}

function useGitDrawerEscape(drawerRef: RefObject<RNView | null>, opts: EscapeOpts) {
  const { viewingCommit, selectedPath, onBack, onDeselectFile, onSelectCommit } = opts;
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onKeyDown = (event: KeyboardEvent) =>
      onDrawerKeyDown(event, drawerRef, {
        viewingCommit,
        selectedPath,
        onBack,
        onDeselectFile,
        onSelectCommit,
      });
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [drawerRef, viewingCommit, selectedPath, onBack, onDeselectFile, onSelectCommit]);
}

type Drag = { startX: number; startWidth: number };

function endPointerDrag(
  dragRef: RefObject<Drag | null>,
  bodyWidth: number,
  leftWidthRef: RefObject<number | null>,
  storageKey: string,
) {
  const wasDragging = dragRef.current !== null;
  dragRef.current = null;
  if (typeof document !== 'undefined' && document.body?.style) {
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }
  const widthNow = leftWidthRef.current;
  if (wasDragging && bodyWidth > 0 && widthNow !== null) {
    const clamped = clampGitDrawerLeftWidth(widthNow, bodyWidth);
    void AsyncStorage.setItem(storageKey, String(clamped));
  }
}

function useGitDrawerPointerResize(
  bodyWidth: number,
  storageKey: string,
  leftWidthRef: RefObject<number | null>,
  dragRef: RefObject<Drag | null>,
  setLeftWidth: (n: number) => void,
) {
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || bodyWidth <= 0) return;
      setLeftWidth(
        clampGitDrawerLeftWidth(drag.startWidth + (event.clientX - drag.startX), bodyWidth),
      );
    };
    const onUp = () => endPointerDrag(dragRef, bodyWidth, leftWidthRef, storageKey);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [bodyWidth, storageKey, leftWidthRef, dragRef, setLeftWidth]);
}

export function startGitDrawerResize(
  clientX: number,
  bodyWidth: number,
  resolvedLeft: number | null,
  dragRef: RefObject<Drag | null>,
) {
  if (bodyWidth <= 0) return;
  const current = resolvedLeft ?? defaultGitDrawerLeftWidth(bodyWidth);
  dragRef.current = { startX: clientX, startWidth: current };
  if (typeof document !== 'undefined' && document.body?.style) {
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }
}

export function grantSplitter(
  event: GestureResponderEvent,
  startResize: (clientX: number) => void,
) {
  const native = event.nativeEvent as GestureResponderEvent['nativeEvent'] & {
    clientX?: number;
    pageX?: number;
  };
  const clientX = native.clientX ?? native.pageX;
  if (typeof clientX === 'number') startResize(clientX);
}

export function applyGitDrawerA11yResize(
  actionName: string,
  bodyWidth: number,
  resolvedLeft: number | null,
  setLeftWidth: (n: number) => void,
  storageKey: string,
) {
  if (bodyWidth <= 0) return;
  const step = 24;
  const current = resolvedLeft ?? defaultGitDrawerLeftWidth(bodyWidth);
  let next = current;
  if (actionName === 'increment') next = clampGitDrawerLeftWidth(current + step, bodyWidth);
  else if (actionName === 'decrement') next = clampGitDrawerLeftWidth(current - step, bodyWidth);
  else return;
  setLeftWidth(next);
  void AsyncStorage.setItem(storageKey, String(next));
}

export function useGitDrawerLayout(p: EscapeOpts & { leftWidthStorageKey: string }) {
  const drawerRef = useRef<RNView | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const width = useGitDrawerLeftWidth(p.leftWidthStorageKey);
  useGitDrawerEscape(drawerRef, p);
  useGitDrawerPointerResize(
    width.bodyWidth,
    p.leftWidthStorageKey,
    width.leftWidthRef,
    dragRef,
    width.setLeftWidth,
  );
  const startResize = (clientX: number) =>
    startGitDrawerResize(clientX, width.bodyWidth, width.resolvedLeft, dragRef);
  return {
    drawerRef,
    bodyWidth: width.bodyWidth,
    setLeftWidth: width.setLeftWidth,
    resolvedLeft: width.resolvedLeft,
    onBodyLayout: width.onBodyLayout,
    startResize,
    onSplitterGrant: (event: GestureResponderEvent) => grantSplitter(event, startResize),
  };
}
