use std::time::Duration;

use reqwest::Client;
use serde_json::Value;
use tether_core::host_client::{HttpMethod, HttpRequest};

pub fn http_client() -> Client {
    Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .expect("reqwest client")
}

pub struct HttpResponse {
    pub status: u16,
    pub body: Value,
}

pub struct HttpBytesResponse {
    pub status: u16,
    pub body: Vec<u8>,
    pub content_type: Option<String>,
}

pub async fn execute(client: &Client, request: &HttpRequest) -> Result<HttpResponse, String> {
    let mut builder = match request.method {
        HttpMethod::Get => client.get(&request.url),
        HttpMethod::Post => client.post(&request.url),
    };
    for (name, value) in &request.headers {
        builder = builder.header(name, value);
    }
    if let Some(body) = &request.body {
        builder = builder.body(body.clone());
    }
    let response = builder.send().await.map_err(|error| error.to_string())?;
    let status = response.status().as_u16();
    let text = response.text().await.map_err(|error| error.to_string())?;
    let body = if text.trim().is_empty() {
        Value::Null
    } else {
        serde_json::from_str(&text).unwrap_or(Value::String(text))
    };
    Ok(HttpResponse { status, body })
}

pub async fn execute_bytes(
    client: &Client,
    request: &HttpRequest,
) -> Result<HttpBytesResponse, String> {
    let mut builder = match request.method {
        HttpMethod::Get => client.get(&request.url),
        HttpMethod::Post => client.post(&request.url),
    };
    for (name, value) in &request.headers {
        builder = builder.header(name, value);
    }
    if let Some(body) = &request.body {
        builder = builder.body(body.clone());
    }
    let response = builder.send().await.map_err(|error| error.to_string())?;
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let body = response
        .bytes()
        .await
        .map_err(|error| error.to_string())?
        .to_vec();
    Ok(HttpBytesResponse {
        status,
        body,
        content_type,
    })
}
