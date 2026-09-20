package main

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// Device is one registered phone: an APNs token plus the AES key it shares with
// this host (generated on the phone, sent over SSH by the app).
type Device struct {
	Token     string `json:"token"`
	SecretKey string `json:"secretKey"`
	Label     string `json:"label,omitempty"`
}

func home() string {
	if dir := os.Getenv("TETHER_NOTIFY_HOME"); dir != "" {
		return dir
	}
	base, err := os.UserHomeDir()
	if err != nil {
		base = "."
	}
	return filepath.Join(base, ".tether-notify")
}

func devicesPath() string { return filepath.Join(home(), "devices.json") }

func loadDevices() ([]Device, error) {
	data, err := os.ReadFile(devicesPath())
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var devices []Device
	if err := json.Unmarshal(data, &devices); err != nil {
		return nil, err
	}
	return devices, nil
}

func saveDevices(devices []Device) error {
	if err := os.MkdirAll(home(), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(devices, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(devicesPath(), data, 0o600)
}

// registerDevice upserts on token — the app re-registers on every launch and
// APNs rotates tokens, so this replaces rather than accumulates.
func registerDevice(devices []Device, d Device) []Device {
	for i := range devices {
		if devices[i].Token == d.Token {
			devices[i] = d
			return devices
		}
	}
	return append(devices, d)
}

func removeDevice(devices []Device, token string) []Device {
	out := devices[:0]
	for _, d := range devices {
		if d.Token != token {
			out = append(out, d)
		}
	}
	return out
}
