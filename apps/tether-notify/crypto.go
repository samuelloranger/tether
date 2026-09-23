package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
)

// Wire format shared with the iOS NSE: base64( nonce[12] || ciphertext || tag[16] ),
// AES-256-GCM over JSON {title, body, link?}.
const (
	nonceBytes = 12
	keyBytes   = 32
	tagBytes   = 16
)

type PushContent struct {
	Title string `json:"title"`
	Body  string `json:"body"`
	Link  string `json:"link,omitempty"`
}

func encryptPushContent(keyBase64 string, content PushContent) (string, error) {
	key, err := base64.StdEncoding.DecodeString(keyBase64)
	if err != nil {
		return "", err
	}
	if len(key) != keyBytes {
		return "", errors.New("push secret key must be 32 bytes")
	}
	plaintext, err := json.Marshal(content)
	if err != nil {
		return "", err
	}
	gcm, err := newGCM(key)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, nonceBytes)
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	sealed := gcm.Seal(nonce, nonce, plaintext, nil)
	return base64.StdEncoding.EncodeToString(sealed), nil
}

func newGCM(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}
