package main

import "testing"

func TestRegisterUpsertsOnToken(t *testing.T) {
	var devices []Device
	devices = registerDevice(devices, Device{Token: "a", SecretKey: "k1"})
	devices = registerDevice(devices, Device{Token: "a", SecretKey: "k2", Label: "phone"})
	if len(devices) != 1 {
		t.Fatalf("want 1 device, got %d", len(devices))
	}
	if devices[0].SecretKey != "k2" || devices[0].Label != "phone" {
		t.Fatalf("upsert did not replace: %+v", devices[0])
	}
}

func TestRegisterAppendsDistinctTokens(t *testing.T) {
	var devices []Device
	devices = registerDevice(devices, Device{Token: "a"})
	devices = registerDevice(devices, Device{Token: "b"})
	if len(devices) != 2 {
		t.Fatalf("want 2, got %d", len(devices))
	}
}

func TestRemoveDropsOnlyMatching(t *testing.T) {
	devices := []Device{{Token: "a"}, {Token: "b"}}
	devices = removeDevice(devices, "a")
	if len(devices) != 1 || devices[0].Token != "b" {
		t.Fatalf("remove wrong: %+v", devices)
	}
}

func TestSaveLoadRoundTrip(t *testing.T) {
	t.Setenv("TETHER_NOTIFY_HOME", t.TempDir())
	want := []Device{{Token: "a", SecretKey: "k", Label: "phone"}}
	if err := saveDevices(want); err != nil {
		t.Fatal(err)
	}
	got, err := loadDevices()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0] != want[0] {
		t.Fatalf("round-trip: %+v", got)
	}
}

func TestLoadMissingIsEmpty(t *testing.T) {
	t.Setenv("TETHER_NOTIFY_HOME", t.TempDir())
	got, err := loadDevices()
	if err != nil || got != nil {
		t.Fatalf("missing should be empty: %+v err %v", got, err)
	}
}
