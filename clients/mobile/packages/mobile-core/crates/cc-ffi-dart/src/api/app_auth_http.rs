use super::core::CoreFailure;
use flutter_rust_bridge::frb;
use std::collections::HashMap;

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

#[frb(opaque)]
pub struct AppAuthHttp(cc_core::AppAuthHttp);

impl AppAuthHttp {
    pub fn open(user_agent: Option<String>) -> Result<Self, CoreFailure> {
        cc_core::AppAuthHttp::new(user_agent.as_deref())
            .map(Self)
            .map_err(|error| CoreFailure::from(cc_core::CoreFailure::from(error)))
    }

    pub async fn request(&self, request: AppAuthRequest) -> Result<AppAuthResponse, CoreFailure> {
        let response = self
            .0
            .request(cc_core::AppAuthRequest {
                origin: request.origin,
                method: request.method,
                path: request.path,
                body: request.body,
                token: request.token,
                proof: request.proof,
                client_version: request.client_version,
            })
            .await
            .map_err(|error| CoreFailure::from(cc_core::CoreFailure::from(error)))?;
        Ok(AppAuthResponse {
            status: response.status,
            headers: response.headers,
            body: response.body,
        })
    }
}
