//! In-memory per-host Noise REST token cache.
//!
//! Tokens are minted over Noise (`mint_noise_token`) and reused until they are
//! within ~10% of expiry. A 401 invalidates the entry so the next lookup remints.

use std::collections::HashMap;
use std::time::{Duration, Instant, SystemTime};

use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

/// A cached per-device REST bearer. `expires_at` is the *refresh* Instant
/// (90% of remaining lifetime, capped at 23h from mint), not the server's
/// wall-clock `expiresAt`.
#[derive(Clone, Debug)]
pub struct CachedToken {
    pub token: String,
    pub expires_at: Instant,
}

/// Hard cap on how long we will ride a cached token, even if the server's
/// `expiresAt` is further out (or unparseable). 23h < the 24h server TTL.
const MAX_REMAINING: Duration = Duration::from_secs(23 * 60 * 60);

/// Refresh once this fraction of the remaining lifetime has elapsed (0.9 ⇒
/// remint in the last 10%).
const REFRESH_FRACTION: f64 = 0.9;

/// Remaining time until the server's ISO-8601 `expiresAt`, or `None` if the
/// timestamp cannot be parsed. Already-elapsed timestamps yield `Duration::ZERO`.
pub fn remaining_until_expiry(expires_at_iso: &str, now: SystemTime) -> Option<Duration> {
    let parsed = OffsetDateTime::parse(expires_at_iso, &Rfc3339).ok()?;
    let expiry: SystemTime = parsed.into();
    Some(expiry.duration_since(now).unwrap_or(Duration::ZERO))
}

/// Monotonic refresh deadline: `now + 0.9 * min(23h, remaining)`. A zero or
/// already-elapsed remaining yields `now` (caller remints immediately).
pub fn refresh_deadline(now: Instant, remaining: Duration) -> Instant {
    let capped = remaining.min(MAX_REMAINING);
    now + capped.mul_f64(REFRESH_FRACTION)
}

/// Insert (or replace) a cached token for `host_id`. Unparseable `expiresAt`
/// falls back to the 23h cap so a freshly minted token is still reused.
pub fn store_token(
    cache: &mut HashMap<String, CachedToken>,
    host_id: &str,
    token: String,
    expires_at_iso: &str,
    now_instant: Instant,
    now_wall: SystemTime,
) {
    let remaining = remaining_until_expiry(expires_at_iso, now_wall).unwrap_or(MAX_REMAINING);
    cache.insert(
        host_id.to_string(),
        CachedToken {
            token,
            expires_at: refresh_deadline(now_instant, remaining),
        },
    );
}

/// The cached token if it has not yet reached its refresh Instant.
pub fn cached_token_if_fresh(
    cache: &HashMap<String, CachedToken>,
    host_id: &str,
    now: Instant,
) -> Option<String> {
    cache
        .get(host_id)
        .filter(|cached| now < cached.expires_at)
        .map(|cached| cached.token.clone())
}

/// Drop the cached token so the next lookup remints (the 401 path).
pub fn invalidate_token(cache: &mut HashMap<String, CachedToken>, host_id: &str) {
    cache.remove(host_id);
}

/// A Noise host that got a 401 and has not already retried should invalidate
/// the cache and remint once.
pub fn should_remint_on_401(is_noise: bool, status: u16, already_retried: bool) -> bool {
    is_noise && status == 401 && !already_retried
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::UNIX_EPOCH;

    fn cache_with(host_id: &str, token: &str, expires_at: Instant) -> HashMap<String, CachedToken> {
        let mut cache = HashMap::new();
        cache.insert(
            host_id.to_string(),
            CachedToken {
                token: token.to_string(),
                expires_at,
            },
        );
        cache
    }

    #[test]
    fn remaining_until_parses_iso8601_zulu() {
        let rem = remaining_until_expiry("1970-01-01T00:00:10.000Z", UNIX_EPOCH).unwrap();
        assert_eq!(rem, Duration::from_secs(10));
    }

    #[test]
    fn remaining_until_parses_rfc3339_without_millis() {
        let rem = remaining_until_expiry("1970-01-01T00:01:00Z", UNIX_EPOCH).unwrap();
        assert_eq!(rem, Duration::from_secs(60));
    }

    #[test]
    fn remaining_until_rejects_garbage() {
        assert_eq!(remaining_until_expiry("not-a-date", UNIX_EPOCH), None);
    }

    #[test]
    fn remaining_until_already_elapsed_is_zero() {
        let rem = remaining_until_expiry(
            "1970-01-01T00:00:00.000Z",
            UNIX_EPOCH + Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(rem, Duration::ZERO);
    }

    #[test]
    fn refresh_deadline_is_90_percent_of_remaining() {
        let now = Instant::now();
        let deadline = refresh_deadline(now, Duration::from_secs(100));
        assert_eq!(deadline.duration_since(now), Duration::from_secs(90));
    }

    #[test]
    fn refresh_deadline_caps_remaining_at_23h() {
        let now = Instant::now();
        let two_days = Duration::from_secs(48 * 60 * 60);
        let deadline = refresh_deadline(now, two_days);
        let expected = MAX_REMAINING.mul_f64(REFRESH_FRACTION);
        assert_eq!(deadline.duration_since(now), expected);
    }

    #[test]
    fn refresh_deadline_for_zero_remaining_is_now() {
        let now = Instant::now();
        assert_eq!(refresh_deadline(now, Duration::ZERO), now);
    }

    #[test]
    fn store_then_fresh_lookup_returns_token() {
        let mut cache = HashMap::new();
        let t0 = Instant::now();
        let wall = UNIX_EPOCH;
        store_token(
            &mut cache,
            "host-a",
            "tok-1".into(),
            "1970-01-01T00:01:40.000Z", // 100s from epoch
            t0,
            wall,
        );
        assert_eq!(
            cached_token_if_fresh(&cache, "host-a", t0).as_deref(),
            Some("tok-1")
        );
        // 80s in — still before the 90s refresh point.
        assert_eq!(
            cached_token_if_fresh(&cache, "host-a", t0 + Duration::from_secs(80)).as_deref(),
            Some("tok-1")
        );
    }

    #[test]
    fn lookup_past_refresh_point_is_none() {
        let mut cache = HashMap::new();
        let t0 = Instant::now();
        store_token(
            &mut cache,
            "host-a",
            "tok-1".into(),
            "1970-01-01T00:01:40.000Z",
            t0,
            UNIX_EPOCH,
        );
        assert_eq!(
            cached_token_if_fresh(&cache, "host-a", t0 + Duration::from_secs(91)),
            None
        );
    }

    #[test]
    fn hosts_do_not_share_cached_tokens() {
        let mut cache = HashMap::new();
        let t0 = Instant::now();
        store_token(
            &mut cache,
            "host-a",
            "tok-a".into(),
            "1970-01-01T00:01:40.000Z",
            t0,
            UNIX_EPOCH,
        );
        store_token(
            &mut cache,
            "host-b",
            "tok-b".into(),
            "1970-01-01T00:01:40.000Z",
            t0,
            UNIX_EPOCH,
        );
        assert_eq!(
            cached_token_if_fresh(&cache, "host-a", t0).as_deref(),
            Some("tok-a")
        );
        assert_eq!(
            cached_token_if_fresh(&cache, "host-b", t0).as_deref(),
            Some("tok-b")
        );
    }

    #[test]
    fn invalidate_drops_the_entry() {
        let mut cache = cache_with("host-a", "tok-1", Instant::now() + Duration::from_secs(60));
        invalidate_token(&mut cache, "host-a");
        assert_eq!(
            cached_token_if_fresh(&cache, "host-a", Instant::now()),
            None
        );
    }

    #[test]
    fn remint_on_401_only_for_noise_first_try() {
        assert!(should_remint_on_401(true, 401, false));
        assert!(!should_remint_on_401(true, 401, true));
        assert!(!should_remint_on_401(true, 200, false));
        assert!(!should_remint_on_401(false, 401, false));
    }
}
