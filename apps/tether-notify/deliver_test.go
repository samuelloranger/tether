package main

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func scripted(t *testing.T, replies ...func(http.ResponseWriter)) (string, *atomic.Int32) {
	t.Helper()
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		i := int(calls.Add(1)) - 1
		if i >= len(replies) {
			i = len(replies) - 1
		}
		replies[i](w)
	}))
	t.Cleanup(srv.Close)
	return srv.URL, &calls
}

func status(code int, retryAfter string) func(http.ResponseWriter) {
	return func(w http.ResponseWriter) {
		if retryAfter != "" {
			w.Header().Set("Retry-After", retryAfter)
		}
		w.WriteHeader(code)
	}
}

func recordingRetrier() (*retrier, *[]time.Duration) {
	var waits []time.Duration
	return &retrier{sleep: func(d time.Duration) { waits = append(waits, d) }}, &waits
}

func TestDeliverUrgentRetriesRateLimitHonoringRetryAfter(t *testing.T) {
	url, calls := scripted(t, status(429, "2"), status(429, "30"), status(200, ""))
	r, waits := recordingRetrier()
	if got := deliver(http.DefaultClient, url, relayRequest{}, r); got != delivered {
		t.Fatalf("got %v, want delivered", got)
	}
	if calls.Load() != 3 {
		t.Fatalf("calls = %d, want 3", calls.Load())
	}
	if len(*waits) != 2 || (*waits)[0] != 2*time.Second || (*waits)[1] != maxRetryWait {
		t.Fatalf("waits = %v, want [2s %v]", *waits, maxRetryWait)
	}
}

func TestDeliverUrgentRetries503WithBackoffWhenNoRetryAfter(t *testing.T) {
	url, _ := scripted(t, status(503, ""), status(200, ""))
	r, waits := recordingRetrier()
	if got := deliver(http.DefaultClient, url, relayRequest{}, r); got != delivered {
		t.Fatalf("got %v, want delivered", got)
	}
	if len(*waits) != 1 || (*waits)[0] != defaultBackoff {
		t.Fatalf("waits = %v", *waits)
	}
}

func TestDeliverUrgentGivesUpAfterMaxRetries(t *testing.T) {
	url, calls := scripted(t, status(429, "1"))
	r, _ := recordingRetrier()
	if got := deliver(http.DefaultClient, url, relayRequest{}, r); got != failed {
		t.Fatalf("got %v, want failed", got)
	}
	if calls.Load() != maxRetries+1 {
		t.Fatalf("calls = %d, want %d", calls.Load(), maxRetries+1)
	}
}

func TestDeliverStopsWhenTimeBudgetIsSpent(t *testing.T) {
	url, calls := scripted(t, status(429, "5"))
	r, waits := recordingRetrier()
	r.waited = retryBudget - 6*time.Second
	if got := deliver(http.DefaultClient, url, relayRequest{}, r); got != failed {
		t.Fatalf("got %v, want failed", got)
	}
	if calls.Load() != 2 || len(*waits) != 1 {
		t.Fatalf("calls = %d waits = %v, want one retry then stop", calls.Load(), *waits)
	}
}

func TestDeliverRetriesTransportErrors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	url := srv.URL
	srv.Close()
	r, waits := recordingRetrier()
	if got := deliver(http.DefaultClient, url, relayRequest{}, r); got != failed {
		t.Fatalf("got %v, want failed", got)
	}
	if len(*waits) != maxRetries {
		t.Fatalf("waits = %v, want %d", *waits, maxRetries)
	}
}

func TestDeliverWithoutRetrierMakesOneAttempt(t *testing.T) {
	url, calls := scripted(t, status(429, "1"), status(200, ""))
	if got := deliver(http.DefaultClient, url, relayRequest{}, nil); got != failed {
		t.Fatalf("got %v, want failed", got)
	}
	if calls.Load() != 1 {
		t.Fatalf("calls = %d, want 1", calls.Load())
	}
}

func TestDeliverDoesNotRetryClientErrors(t *testing.T) {
	url, calls := scripted(t, status(400, ""), status(200, ""))
	r, waits := recordingRetrier()
	if got := deliver(http.DefaultClient, url, relayRequest{}, r); got != failed {
		t.Fatalf("got %v, want failed", got)
	}
	if calls.Load() != 1 || len(*waits) != 0 {
		t.Fatalf("calls = %d waits = %v", calls.Load(), *waits)
	}
}

func TestDeliverGoneIsNotRetried(t *testing.T) {
	url, calls := scripted(t, status(410, ""))
	r, _ := recordingRetrier()
	if got := deliver(http.DefaultClient, url, relayRequest{}, r); got != gone || calls.Load() != 1 {
		t.Fatalf("got %v after %d calls", got, calls.Load())
	}
}
