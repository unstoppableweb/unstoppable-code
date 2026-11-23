//! HTTP transport with the Dart `ApiClient` / `fetchMobileRelayToken` wire
//! contract. Every request the auth layer sends goes through [`Http::send`].
//!
//! Header profiles mirror the three Dart clients:
//! - [`Profile::App`]: the app-wide `ApiClient` (`lib/main.dart`), which adds
//!   `Content-Type: application/json` to every request, `x-canopy-client`,
//!   `x-canopy-client-version` when valid, and the stored bearer/2FA proof.
//! - [`Profile::Bare`]: `ComputerConnectAccess.revokeLegacyKey`'s `ApiClient`,
//!   which has no default headers and no version provider.
//! - [`Profile::RelayToken`]: `_fetchRelayToken`'s raw `http.Client`, which
//!   sends only the bearer, the proof and `Content-Type`.
use crate::error::{Error, Kind};
use reqwest::{
    Client, Method, Response,
    header::{HeaderMap, HeaderName, HeaderValue},
    redirect::{Attempt, Policy},
};
use serde_json::Value;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub(crate) const CLIENT_SURFACE_HEADER: &str = "x-canopy-client";
pub(crate) const CLIENT_VERSION_HEADER: &str = "x-canopy-client-version";
pub(crate) const MOBILE_CLIENT_SURFACE: &str = "mobile";

pub(crate) type AuthResult<T> = crate::error::Result<T>;

pub(crate) fn local(code: &str) -> Error {
    Error::new(code)
}
/// Transport failure before any status (DNS, TLS, reset, redirect loop).
pub(crate) fn network() -> Error {
    Error {
        kind: Kind::Http,
        ..Error::new("network_unavailable")
    }
}
pub(crate) fn timeout() -> Error {
    Error {
        kind: Kind::Timeout,
        ..Error::new("timeout")
    }
}
/// The synthetic 500 Dart raises for a 2xx body missing a required field.
pub(crate) fn malformed() -> Error {
    Error::http(500, "malformed_response")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Profile {
    App,
    Bare,
    RelayToken,
}

/// Stored credentials attached to a request.
#[derive(Clone, Default)]
pub(crate) struct Credentials {
    pub token: Option<String>,
    pub proof: Option<String>,
}
impl std::fmt::Debug for Credentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Credentials(redacted)")
    }
}

pub(crate) struct Call<'a> {
    pub method: Method,
    /// Origin-relative path, optionally with a query string.
    pub path: &'a str,
    /// JSON body; `None` sends no body (Dart `postJson(body: null)`).
    pub body: Option<&'a Value>,
    pub profile: Profile,
    /// Overall deadline for receiving response headers (Dart `.timeout` on
    /// the call, or `client.send(...).timeout` for the relay token).
    pub timeout: Option<Duration>,
    /// Idle deadline between body chunks (relay token: 15 s per chunk).
    pub chunk_timeout: Option<Duration>,
    /// Body byte limit; exceeding it fails the call.
    pub limit: usize,
}

#[derive(Debug, Clone)]
pub(crate) struct RawResponse {
    pub status: u16,
    /// Lower-case header names; repeated headers joined with `, ` as
    /// package:http does.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}
impl RawResponse {
    pub(crate) fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }
    pub(crate) fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
    /// Dart `ApiClient._decode`: empty body -> `{}`, non-JSON -> error,
    /// a non-object JSON value -> `{}`.
    pub(crate) fn decode_object(&self) -> AuthResult<Value> {
        if self.body.is_empty() {
            return Ok(Value::Object(Default::default()));
        }
        let value: Value =
            serde_json::from_slice(&self.body).map_err(|_| local("malformed_response"))?;
        Ok(if value.is_object() {
            value
        } else {
            Value::Object(Default::default())
        })
    }
    /// The `ApiException` mapping callers use: status, the body's `code`
    /// (`[A-Za-z_]{1,64}`, else `http_error`), `error` text and Retry-After.
    pub(crate) fn failure(&self) -> Error {
        let json: Value = serde_json::from_slice(&self.body).unwrap_or(Value::Null);
        let code = json["code"]
            .as_str()
            .filter(|s| is_code(s))
            .unwrap_or("http_error");
        Error {
            message: error_text(&json),
            retry_after: self.header("retry-after").and_then(parse_retry_after),
            ..Error::http(self.status, code)
        }
    }
}

pub(crate) fn is_code(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_alphabetic() || b == b'_')
}
pub(crate) fn error_text(json: &Value) -> Option<String> {
    json["error"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(4096).collect())
}

/// The three redirect behaviors of Dart's clients.
pub(crate) struct Http {
    /// GET/HEAD: dart:io follows 301/302/303/307/308 up to 5 hops.
    follow: Client,
    /// POST: dart:io follows only 303 (then as GET).
    post: Client,
    /// PUT/PATCH/DELETE and the relay token (`followRedirects = false`).
    none: Client,
    /// dart:io's `HttpClient.userAgent` (`Dart/<version> (dart:io)`), given
    /// by the host so requests carry the header the Dart clients send.
    user_agent: std::sync::RwLock<Option<HeaderValue>>,
}

/// The single place every HTTP client is configured, so the TLS trust
/// decision (see `w2-wiring.md`, OS trust store) changes in one spot.
pub(crate) fn client_builder() -> reqwest::ClientBuilder {
    // dart:io's HttpClient ignores proxy environment variables by default and
    // trusts the OS store; bundled roots remain the pre-init Android fallback.
    crate::tls::reqwest_builder().unwrap_or_else(|_| Client::builder().no_proxy())
}

fn post_policy(attempt: Attempt) -> reqwest::redirect::Action {
    // The first hop is the original POST; afterwards the request is a GET.
    if attempt.previous().len() > 5 {
        attempt.error("too many redirects")
    } else if attempt.previous().len() == 1 && attempt.status().as_u16() != 303 {
        attempt.stop()
    } else {
        attempt.follow()
    }
}

impl Http {
    pub(crate) fn new() -> Result<Self, Error> {
        Self::with_redirects(Policy::limited(5), Policy::custom(post_policy))
    }

    pub(crate) fn app_auth() -> Result<Self, Error> {
        let same_origin = |attempt: &Attempt<'_>| {
            attempt
                .previous()
                .first()
                .is_some_and(|origin| origin.origin() == attempt.url().origin())
        };
        Self::with_redirects(
            Policy::custom(move |attempt| {
                if attempt.previous().len() > 5 {
                    attempt.error("too many redirects")
                } else if same_origin(&attempt) {
                    attempt.follow()
                } else {
                    attempt.stop()
                }
            }),
            Policy::custom(move |attempt| {
                if same_origin(&attempt) {
                    post_policy(attempt)
                } else {
                    attempt.stop()
                }
            }),
        )
    }

    fn with_redirects(follow: Policy, post: Policy) -> Result<Self, Error> {
        let build = |policy: Policy| {
            client_builder()
                .redirect(policy)
                .build()
                .map_err(|_| Error::new("http_init"))
        };
        Ok(Self {
            follow: build(follow)?,
            post: build(post)?,
            none: build(Policy::none())?,
            user_agent: std::sync::RwLock::new(None),
        })
    }
    pub(crate) fn set_user_agent(&self, agent: Option<&str>) {
        *self.user_agent.write().unwrap_or_else(|e| e.into_inner()) =
            agent.and_then(|a| HeaderValue::from_str(a).ok());
    }

    /// Sends one request and reads its body. Non-2xx statuses are returned,
    /// not raised; only transport failures, timeouts and the body limit are
    /// errors.
    pub(crate) async fn send(
        &self,
        origin: &url::Url,
        call: Call<'_>,
        credentials: &Credentials,
        client_version: Option<&str>,
    ) -> AuthResult<RawResponse> {
        let (limit, chunk, overall) = (call.limit, call.chunk_timeout, call.timeout);
        let started = tokio::time::Instant::now();
        let response = self
            .start(origin, call, credentials, client_version)
            .await?;
        let remaining = overall.map(|t| t.saturating_sub(started.elapsed()));
        read(response, limit, chunk, remaining).await
    }

    /// Sends one request and returns once headers arrive (within
    /// `call.timeout`); the caller decides whether to read the body.
    pub(crate) async fn start(
        &self,
        origin: &url::Url,
        call: Call<'_>,
        credentials: &Credentials,
        client_version: Option<&str>,
    ) -> AuthResult<Response> {
        let url = resolve(origin, call.path)?;
        let client = match (call.profile, &call.method) {
            (Profile::RelayToken, _) => &self.none,
            (_, m) if *m == Method::GET || *m == Method::HEAD => &self.follow,
            (_, m) if *m == Method::POST => &self.post,
            _ => &self.none,
        };
        let mut headers = HeaderMap::new();
        // dart:io sends both on every request (`autoUncompress`).
        if let Some(agent) = self
            .user_agent
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
        {
            headers.insert(reqwest::header::USER_AGENT, agent);
        }
        headers.insert(
            reqwest::header::ACCEPT_ENCODING,
            HeaderValue::from_static("gzip"),
        );
        let json = HeaderValue::from_static("application/json");
        match call.profile {
            Profile::App => {
                headers.insert(reqwest::header::CONTENT_TYPE, json);
                surface(&mut headers, client_version);
            }
            Profile::Bare => {
                if call.body.is_some() {
                    headers.insert(reqwest::header::CONTENT_TYPE, json);
                }
                surface(&mut headers, None);
            }
            Profile::RelayToken => {
                headers.insert(reqwest::header::CONTENT_TYPE, json);
            }
        }
        if let Some(token) = credentials.token.as_deref().filter(|t| !t.is_empty()) {
            headers.insert(
                reqwest::header::AUTHORIZATION,
                HeaderValue::from_str(&format!("Bearer {token}"))
                    .map_err(|_| local("invalid_credentials"))?,
            );
        }
        if let Some(proof) = credentials.proof.as_deref().filter(|p| !p.is_empty()) {
            headers.insert(
                HeaderName::from_static("x-two-factor-verified"),
                HeaderValue::from_str(proof).map_err(|_| local("invalid_credentials"))?,
            );
        }
        let mut request = client.request(call.method, url).headers(headers);
        if let Some(body) = call.body {
            request = request.body(serde_json::to_vec(body).map_err(|_| local("invalid_input"))?);
        }
        let sent = request.send();
        let response = match call.timeout {
            Some(limit) => tokio::time::timeout(limit, sent)
                .await
                .map_err(|_| timeout())?,
            None => sent.await,
        }
        .map_err(|_| network())?;
        Ok(response)
    }
}

fn surface(headers: &mut HeaderMap, version: Option<&str>) {
    headers.insert(
        HeaderName::from_static(CLIENT_SURFACE_HEADER),
        HeaderValue::from_static(MOBILE_CLIENT_SURFACE),
    );
    if let Some(version) = version.filter(|v| valid_client_version(v))
        && let Ok(value) = HeaderValue::from_str(version)
    {
        headers.insert(HeaderName::from_static(CLIENT_VERSION_HEADER), value);
    }
}

/// `^[0-9A-Za-z.+-]{1,32}$`, the shape the server accepts.
pub(crate) fn valid_client_version(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 32
        && v.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'+' | b'-'))
}

/// Origin-relative resolution that can never leave the configured origin.
pub(crate) fn resolve(origin: &url::Url, path: &str) -> AuthResult<url::Url> {
    if !path.starts_with('/')
        || path.starts_with("//")
        || path.contains('\\')
        || path.contains('#')
        || path.bytes().any(|b| b.is_ascii_control() || b == b' ')
    {
        return Err(local("invalid_path"));
    }
    let url = origin.join(path).map_err(|_| local("invalid_path"))?;
    if url.origin() != origin.origin() {
        return Err(local("invalid_path"));
    }
    Ok(url)
}

pub(crate) async fn read(
    mut response: Response,
    limit: usize,
    chunk_timeout: Option<Duration>,
    overall: Option<Duration>,
) -> AuthResult<RawResponse> {
    let status = response.status().as_u16();
    let mut headers: Vec<(String, String)> = Vec::new();
    for (name, value) in response.headers() {
        let value = String::from_utf8_lossy(value.as_bytes()).into_owned();
        match headers.iter_mut().find(|(k, _)| k == name.as_str()) {
            Some((_, existing)) => {
                existing.push_str(", ");
                existing.push_str(&value);
            }
            None => headers.push((name.as_str().to_owned(), value)),
        }
    }
    let mut body = Vec::new();
    let started = tokio::time::Instant::now();
    loop {
        // Per-chunk idle deadline (relay token), or the remaining overall
        // deadline a Dart `.timeout(...)` would also apply to the body read.
        let wait = match (chunk_timeout, overall) {
            (Some(chunk), _) => Some(chunk),
            (None, Some(total)) => Some(total.saturating_sub(started.elapsed())),
            (None, None) => None,
        };
        let next = response.chunk();
        let chunk = match wait {
            Some(wait) => tokio::time::timeout(wait, next)
                .await
                .map_err(|_| timeout())?,
            None => next.await,
        }
        .map_err(|_| network())?;
        let Some(chunk) = chunk else { break };
        if body.len() + chunk.len() > limit {
            return Err(local("response_too_large"));
        }
        body.extend_from_slice(&chunk);
    }
    // dart:io inflates a gzip body transparently; the limit applies to it.
    if headers
        .iter()
        .any(|(k, v)| k == "content-encoding" && v.eq_ignore_ascii_case("gzip"))
    {
        use std::io::Read;
        let mut clear = Vec::new();
        flate2::read::GzDecoder::new(body.as_slice())
            .take(limit as u64 + 1)
            .read_to_end(&mut clear)
            .map_err(|_| network())?;
        if clear.len() > limit {
            return Err(local("response_too_large"));
        }
        body = clear;
    }
    Ok(RawResponse {
        status,
        headers,
        body,
    })
}

/// `Retry-After` as seconds from now, only when positive. Accepts what the
/// Dart email service accepts (`int.tryParse`, `DateTime.tryParse`, i.e.
/// ISO 8601) plus the RFC 9110 IMF-fixdate form servers actually send.
pub(crate) fn parse_retry_after(raw: &str) -> Option<u64> {
    parse_retry_after_at(raw, SystemTime::now())
}

pub(crate) fn parse_retry_after_at(raw: &str, now: SystemTime) -> Option<u64> {
    let raw = raw.trim();
    if let Ok(seconds) = raw.strip_prefix('+').unwrap_or(raw).parse::<i64>() {
        return u64::try_from(seconds).ok().filter(|s| *s > 0);
    }
    let at = parse_iso8601(raw).or_else(|| parse_imf_fixdate(raw))?;
    let now = now.duration_since(UNIX_EPOCH).ok()?.as_secs() as i64;
    // Dart: `date.difference(now).inSeconds` truncates toward zero.
    u64::try_from(at - now).ok().filter(|s| *s > 0)
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn epoch(y: i64, mo: i64, d: i64, h: i64, mi: i64, s: i64) -> Option<i64> {
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || s > 59 {
        return None;
    }
    Some(days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60 + s)
}

fn num(s: &str) -> Option<i64> {
    (!s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
        .then(|| s.parse().ok())
        .flatten()
}

/// `YYYY-MM-DD[(T| )HH:MM[:SS[.fff]]][Z|±HH[:]MM]`; no zone = local time in
/// Dart, treated as UTC here (mobile servers send UTC).
fn parse_iso8601(raw: &str) -> Option<i64> {
    let (date, rest) = raw.split_at(raw.len().min(10));
    let mut d = date.split('-');
    let (y, mo, da) = (num(d.next()?)?, num(d.next()?)?, num(d.next()?)?);
    if date.len() != 10 || d.next().is_some() {
        return None;
    }
    if rest.is_empty() {
        return epoch(y, mo, da, 0, 0, 0);
    }
    let rest = rest.strip_prefix(['T', 't', ' '])?;
    let zone_at = rest.find(['Z', 'z', '+', '-']).unwrap_or(rest.len());
    let (time, zone) = rest.split_at(zone_at);
    let mut t = time.split(':');
    let h = num(t.next()?)?;
    let mi = num(t.next()?)?;
    let s = match t.next() {
        Some(sec) => num(sec.split('.').next()?)?,
        None => 0,
    };
    let offset = match zone {
        "" | "Z" | "z" => 0,
        z => {
            let sign = if z.starts_with('-') { -1 } else { 1 };
            let digits: String = z[1..].chars().filter(|c| *c != ':').collect();
            if digits.len() != 4 {
                return None;
            }
            sign * (num(&digits[..2])? * 3600 + num(&digits[2..])? * 60)
        }
    };
    Some(epoch(y, mo, da, h, mi, s)? - offset)
}

/// `Sun, 06 Nov 1994 08:49:37 GMT`.
fn parse_imf_fixdate(raw: &str) -> Option<i64> {
    let parts: Vec<&str> = raw.split_whitespace().collect();
    if parts.len() != 6 || parts[5] != "GMT" {
        return None;
    }
    let month = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ]
    .iter()
    .position(|m| *m == parts[2])? as i64
        + 1;
    let mut t = parts[4].split(':');
    epoch(
        num(parts[3])?,
        month,
        num(parts[1])?,
        num(t.next()?)?,
        num(t.next()?)?,
        num(t.next()?)?,
    )
}
