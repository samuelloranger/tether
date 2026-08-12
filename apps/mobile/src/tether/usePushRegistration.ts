import * as Crypto from 'expo-crypto';
import * as Notifications from 'expo-notifications';
import { useCallback, useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { getPushSecret, setPushSecret } from '../secureConfig';
import type { HostClient } from './hostClient';
import {
  needsRegistration,
  normalizeDeviceToken,
  registerWithHosts,
  unregisterFromHost,
} from './pushRegistration';

const KEY_BYTES = 32;

/**
 * Generate (once) the AES key this device shares with its Tether servers. The
 * key is created on the device on purpose — no server, and certainly not the
 * relay, ever chooses it.
 */
async function loadOrCreateSecret(): Promise<string> {
  const existing = await getPushSecret();
  if (existing) return existing;
  const bytes = Crypto.getRandomBytes(KEY_BYTES);
  // btoa over a binary string: React Native has no Buffer, and base64 is what
  // the server's `isValidSecretKey` expects.
  const secret = btoa(String.fromCharCode(...bytes));
  await setPushSecret(secret);
  return secret;
}

/**
 * Registers this device for native push with every configured host.
 *
 * iOS only: Android already has its own delivery story via ntfy, and adding
 * FCM would mean a second relay credential for no current benefit.
 */
export function usePushRegistration(
  clients: HostClient[],
  enabled: boolean,
): { unregisterPushFromHost: (hostId: string) => Promise<void> } {
  // Registration is idempotent but not free — remember what we last sent so a
  // cold start does not re-POST to every host.
  const lastSent = useRef<{ deviceToken: string; secretKey: string } | null>(null);

  useEffect(() => {
    if (!enabled || Platform.OS !== 'ios' || clients.length === 0) return;
    let cancelled = false;

    void (async () => {
      const permission = await Notifications.getPermissionsAsync();
      const granted =
        permission.granted ||
        (
          await Notifications.requestPermissionsAsync({
            ios: { allowAlert: true, allowBadge: true, allowSound: true },
          })
        ).granted;
      if (!granted || cancelled) return;

      const devicePushToken = await Notifications.getDevicePushTokenAsync();
      const deviceToken = normalizeDeviceToken(String(devicePushToken.data));
      if (!deviceToken || cancelled) return;

      const secretKey = await loadOrCreateSecret();
      const next = { deviceToken, secretKey };
      if (!needsRegistration(lastSent.current, next) || cancelled) return;

      const results = await registerWithHosts(
        clients.map((client) => ({
          hostId: client.profile.id,
          post: (path, init) =>
            client.post(path, init as RequestInit) as unknown as Promise<{
              ok: boolean;
              status: number;
            }>,
        })),
        next,
      );
      if (cancelled) return;
      // Only remember the registration if at least one host accepted it;
      // otherwise the next launch should try again.
      if (results.some((result) => result.ok)) lastSent.current = next;
    })();

    return () => {
      cancelled = true;
    };
  }, [clients, enabled]);

  // Revoking must happen while the host's credentials still exist, so this is
  // exposed for the removal path to await before the profile is deleted.
  const unregisterPushFromHost = useCallback(
    async (hostId: string) => {
      const client = clients.find((candidate) => candidate.profile.id === hostId);
      const deviceToken = lastSent.current?.deviceToken;
      if (!client || !deviceToken) return;
      await unregisterFromHost(
        {
          hostId,
          post: (path, init) =>
            client.post(path, init as RequestInit) as unknown as Promise<{
              ok: boolean;
              status: number;
            }>,
        },
        deviceToken,
      );
    },
    [clients],
  );

  return { unregisterPushFromHost };
}
