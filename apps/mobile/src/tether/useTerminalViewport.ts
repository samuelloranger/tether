import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { useEffect, useRef, useState } from 'react';
import { ensureNotificationPermission, notify as sendNativeNotification } from '../desktopNotify';
import { isDesktop } from '../platform';

const KEY_FONT = 'tether_font_size';
const KEY_MONO_FONT = 'tether_mono_font';
const KEY_MOUSE_ENABLED = 'tether_mouse_enabled';
const KEY_NOTIFICATIONS_ENABLED = 'tether_notifications_enabled';

export function clampFontSize(size: number): number {
  return Math.min(24, Math.max(8, size));
}

function applySavedPrefs(
  values: readonly (readonly [string, string | null])[],
  setFontSize: Dispatch<SetStateAction<number>>,
  setMouseEnabled: Dispatch<SetStateAction<boolean>>,
  mouseEnabledRef: MutableRefObject<boolean>,
  setNotificationsEnabled: Dispatch<SetStateAction<boolean>>,
  notificationsEnabledRef: MutableRefObject<boolean>,
) {
  const savedFont = Number(values[0]?.[1]);
  if (Number.isFinite(savedFont)) setFontSize(clampFontSize(savedFont));
  if (values[1]?.[1] === 'false') {
    setMouseEnabled(false);
    mouseEnabledRef.current = false;
  }
  if (values[2]?.[1] === 'false') {
    setNotificationsEnabled(false);
    notificationsEnabledRef.current = false;
  }
}

function changeFontSize(delta: number, setFontSize: Dispatch<SetStateAction<number>>) {
  setFontSize((previous) => {
    const next = clampFontSize(previous + delta);
    AsyncStorage.setItem(KEY_FONT, String(next)).catch(() => {});
    return next;
  });
}

function changeFontFamily(font: string, setFontFamily: Dispatch<SetStateAction<string>>) {
  if (font !== 'FiraCode_400Regular' && font !== 'JetBrainsMono_400Regular') return;
  setFontFamily(font);
  AsyncStorage.setItem(KEY_MONO_FONT, font).catch(() => {});
}

function togglePref(
  ref: MutableRefObject<boolean>,
  setValue: Dispatch<SetStateAction<boolean>>,
  key: string,
) {
  setValue((previous) => {
    const next = !previous;
    ref.current = next;
    AsyncStorage.setItem(key, String(next)).catch(() => {});
    return next;
  });
}

export function useTerminalViewport() {
  const [fontSize, setFontSize] = useState(11);
  const [fontFamily, setFontFamily] = useState('FiraCode_400Regular');
  const [mouseEnabled, setMouseEnabled] = useState(true);
  const mouseEnabledRef = useRef(true);
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const notificationsEnabledRef = useRef(true);

  useEffect(() => {
    AsyncStorage.multiGet([KEY_FONT, KEY_MOUSE_ENABLED, KEY_NOTIFICATIONS_ENABLED])
      .then((values) =>
        applySavedPrefs(
          values,
          setFontSize,
          setMouseEnabled,
          mouseEnabledRef,
          setNotificationsEnabled,
          notificationsEnabledRef,
        ),
      )
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!isDesktop) return;
    AsyncStorage.getItem(KEY_MONO_FONT)
      .then((font) => {
        if (font === 'FiraCode_400Regular' || font === 'JetBrainsMono_400Regular') {
          setFontFamily(font);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (isDesktop) void ensureNotificationPermission();
  }, []);

  return {
    fontSize,
    setFontSize,
    fontFamily,
    changeFontFamily: (font: string) => changeFontFamily(font, setFontFamily),
    lineHeight: Math.round(fontSize * 1.3),
    changeFontSize: (delta: number) => changeFontSize(delta, setFontSize),
    mouseEnabled,
    mouseEnabledRef,
    toggleMouseEnabled: () => togglePref(mouseEnabledRef, setMouseEnabled, KEY_MOUSE_ENABLED),
    notificationsEnabled,
    notificationsEnabledRef,
    toggleNotificationsEnabled: () =>
      togglePref(notificationsEnabledRef, setNotificationsEnabled, KEY_NOTIFICATIONS_ENABLED),
    testNotification: () =>
      void sendNativeNotification('Tether', 'Test notification — notifications are working ✅'),
  };
}
