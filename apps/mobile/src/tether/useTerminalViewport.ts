import AsyncStorage from '@react-native-async-storage/async-storage';
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

export function useTerminalViewport() {
  const [fontSize, setFontSize] = useState(11);
  const [fontFamily, setFontFamily] = useState('FiraCode_400Regular');
  const [mouseEnabled, setMouseEnabled] = useState(true);
  const mouseEnabledRef = useRef(true);
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const notificationsEnabledRef = useRef(true);

  useEffect(() => {
    AsyncStorage.multiGet([KEY_FONT, KEY_MOUSE_ENABLED, KEY_NOTIFICATIONS_ENABLED])
      .then((values) => {
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
      })
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

  const changeFontSize = (delta: number) => {
    setFontSize((previous) => {
      const next = clampFontSize(previous + delta);
      AsyncStorage.setItem(KEY_FONT, String(next)).catch(() => {});
      return next;
    });
  };

  const changeFontFamily = (font: string) => {
    if (font !== 'FiraCode_400Regular' && font !== 'JetBrainsMono_400Regular') return;
    setFontFamily(font);
    AsyncStorage.setItem(KEY_MONO_FONT, font).catch(() => {});
  };

  const toggleMouseEnabled = () => {
    setMouseEnabled((previous) => {
      const next = !previous;
      mouseEnabledRef.current = next;
      AsyncStorage.setItem(KEY_MOUSE_ENABLED, String(next)).catch(() => {});
      return next;
    });
  };

  const toggleNotificationsEnabled = () => {
    setNotificationsEnabled((previous) => {
      const next = !previous;
      notificationsEnabledRef.current = next;
      AsyncStorage.setItem(KEY_NOTIFICATIONS_ENABLED, String(next)).catch(() => {});
      return next;
    });
  };

  return {
    fontSize,
    setFontSize,
    fontFamily,
    changeFontFamily,
    lineHeight: Math.round(fontSize * 1.3),
    changeFontSize,
    mouseEnabled,
    mouseEnabledRef,
    toggleMouseEnabled,
    notificationsEnabled,
    notificationsEnabledRef,
    toggleNotificationsEnabled,
    testNotification: () =>
      void sendNativeNotification('Tether', 'Test notification — notifications are working ✅'),
  };
}
