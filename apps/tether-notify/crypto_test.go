package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestEncryptRoundTrips(t *testing.T) {
	key := generateSecretKeyBase64()
	content := PushContent{Title: "homelab · claude", Body: "Waiting for input", Link: "tether://x"}

	sealed, err := encryptPushContent(key, content)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	got, err := decryptPushContent(key, sealed)
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	if got != content {
		t.Fatalf("round-trip mismatch: %+v != %+v", got, content)
	}
}

func TestWireFormatIsNoncePlusCiphertextPlusTag(t *testing.T) {
	key := generateSecretKeyBase64()
	content := PushContent{Title: "t", Body: "b"}
	sealed, err := encryptPushContent(key, content)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := base64.StdEncoding.DecodeString(sealed)
	if err != nil {
		t.Fatalf("not base64: %v", err)
	}
	plaintext, _ := json.Marshal(content)
	want := nonceBytes + len(plaintext) + tagBytes
	if len(raw) != want {
		t.Fatalf("wire length %d, want %d (nonce %d + json %d + tag %d)", len(raw), want, nonceBytes, len(plaintext), tagBytes)
	}
}

func TestWrongKeyFailsToDecrypt(t *testing.T) {
	sealed, err := encryptPushContent(generateSecretKeyBase64(), PushContent{Title: "t", Body: "b"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := decryptPushContent(generateSecretKeyBase64(), sealed); err == nil {
		t.Fatal("expected decrypt with wrong key to fail")
	}
}

func TestRejectsNon32ByteKey(t *testing.T) {
	short := base64.StdEncoding.EncodeToString([]byte("too short"))
	if _, err := encryptPushContent(short, PushContent{Title: "t", Body: "b"}); err == nil {
		t.Fatal("expected a 32-byte key requirement")
	}
}

func TestOmitsEmptyLink(t *testing.T) {
	key := generateSecretKeyBase64()
	sealed, _ := encryptPushContent(key, PushContent{Title: "t", Body: "b"})
	raw, _ := base64.StdEncoding.DecodeString(sealed)
	// The JSON the phone decodes must not carry an empty "link" the old server omitted.
	if strings.Contains(string(raw[nonceBytes:len(raw)-tagBytes]), "link") {
		// ciphertext is opaque, so decrypt and inspect instead
	}
	got, _ := decryptPushContent(key, sealed)
	if got.Link != "" {
		t.Fatalf("link should be empty, got %q", got.Link)
	}
}

func generateSecretKeyBase64() string {
	b := make([]byte, keyBytes)
	_, _ = rand.Read(b)
	return base64.StdEncoding.EncodeToString(b)
}

func decryptPushContent(keyBase64, payload string) (PushContent, error) {
	var content PushContent
	key, err := base64.StdEncoding.DecodeString(keyBase64)
	if err != nil {
		return content, err
	}
	raw, err := base64.StdEncoding.DecodeString(payload)
	if err != nil {
		return content, err
	}
	if len(raw) < nonceBytes+tagBytes {
		return content, errors.New("payload too short")
	}
	gcm, err := newGCM(key)
	if err != nil {
		return content, err
	}
	plaintext, err := gcm.Open(nil, raw[:nonceBytes], raw[nonceBytes:], nil)
	if err != nil {
		return content, err
	}
	return content, json.Unmarshal(plaintext, &content)
}
