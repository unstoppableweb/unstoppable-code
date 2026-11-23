//! Hosted HTTP calls for the mobile app's sign-in and recovery flow.
//! The host owns the browser callback, session policy and secure storage.
use crate::{
    auth::{API_BODY_LIMIT, secure_url},
    error::{Error, Result},
    http::{Call, Credentials, Http, Profile},
};
use reqwest::Method;
use std::{collections::HashMap, time::Duration};

pub struct AppAuthRequest {
    pub origin: String,
    pub method: String,
    pub path: String,
    pub body: Vec<u8>,
    pub token: Option<String>,
    pub proof: Option<String>,
    pub client_version: Option<String>,
}

pub struct AppAuthResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

/// Stateless with respect to the signed-in account. The credentials belong
/// only to the request that supplied them.
pub struct AppAuthHttp(Http);

impl AppAuthHttp {
    pub fn new(user_agent: Option<&str>) -> Result<Self> {
        let http = Http::app_auth()?;
        http.set_user_agent(user_agent);
        Ok(Self(http))
    }

    /// Makes one request. The caller owns session validation retries and
    /// interprets HTTP statuses according to the endpoint.
    pub async fn request(&self, request: AppAuthRequest) -> Result<AppAuthResponse> {
        let origin = secure_url(&request.origin, false)?;
        if origin.path() != "/" {
            return Err(Error::new("invalid_origin"));
        }
        let (method, timeout) = match (request.method.as_str(), request.path.as_str()) {
            ("GET", "/api/auth/get-session") => (Method::GET, 30),
            ("GET", "/api/mobile/email-auth") => (Method::GET, 10),
            (
                "POST",
                "/api/auth/sign-out"
                | "/api/mobile/oauth-token"
                | "/api/mobile/oauth-apple-native"
                | "/api/mobile/two-factor/verify"
                | "/api/mobile/email-auth/sign-in"
                | "/api/auth/sign-up/email"
                | "/api/auth/email-otp/verify-email"
                | "/api/auth/email-otp/request-password-reset"
                | "/api/auth/email-otp/reset-password",
            ) => (Method::POST, 30),
            _ => return Err(Error::new("invalid_auth_endpoint")),
        };
        let body = if request.body.is_empty() {
            None
        } else {
            Some(serde_json::from_slice(&request.body).map_err(|_| Error::new("invalid_input"))?)
        };
        let response = self
            .0
            .send(
                &origin,
                Call {
                    method,
                    path: &request.path,
                    body: body.as_ref(),
                    profile: Profile::App,
                    timeout: Some(Duration::from_secs(timeout)),
                    chunk_timeout: None,
                    limit: API_BODY_LIMIT,
                },
                &Credentials {
                    token: request.token,
                    proof: request.proof,
                },
                request.client_version.as_deref(),
            )
            .await?;
        Ok(AppAuthResponse {
            status: response.status,
            headers: response
                .headers
                .into_iter()
                .filter(|(name, _)| matches!(name.as_str(), "content-type" | "retry-after"))
                .collect(),
            body: response.body,
        })
    }
}
