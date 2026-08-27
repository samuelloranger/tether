# Notification Service Extension

Decrypts APNs payloads on-device before display. The relay only ever sees
ciphertext (`e`); plaintext title/body exist only here.

## Layout

```
clients/apple/TetherNotificationService/
  NotificationService.swift
  Info.plist
  TetherNotificationService.entitlements
```

Embedded into `TetherIOS` via the Xcode target of the same name
(`com.samuelloranger.tether-mobile.TetherNotificationService`).

## Shared keychain

Both the app and the extension list the same keychain access group:

`$(AppIdentifierPrefix)com.samuelloranger.tether-mobile`

`PushRegistrar` writes account `tether_push_secret` / service `dev.tether.app`
with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`. The NSE reads that
item and decrypts AES-256-GCM (`nonce[12] ‖ ciphertext ‖ tag[16]`).

## Signing note

App Store / TestFlight builds need a provisioning profile that covers the
extension bundle id as well as the app. Automatic signing handles this in
Xcode; the release workflow's manual profile must include the NSE.
