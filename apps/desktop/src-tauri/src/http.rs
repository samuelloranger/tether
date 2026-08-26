use std::time::Duration;

use reqwest::multipart;
use reqwest::Client;
use serde_json::Value;
use tether_core::host_client::{HttpMethod, HttpRequest};
use tether_core::workspace::UploadPlan;

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

pub async fn execute(client: &Client, request: &HttpRequest) -> Result<HttpResponse, String> {
    let mut builder = match request.method {
        HttpMethod::Get => client.get(&request.url),
        HttpMethod::Post => client.post(&request.url),
        HttpMethod::Delete => client.delete(&request.url),
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

/// Multipart upload — shell owns reading the local file; core only supplied the plan.
pub async fn execute_upload(
    client: &Client,
    plan: &UploadPlan,
    file_bytes: Vec<u8>,
    filename: &str,
) -> Result<HttpResponse, String> {
    let part = multipart::Part::bytes(file_bytes)
        .file_name(filename.to_string())
        .mime_str("application/octet-stream")
        .map_err(|error| error.to_string())?;
    let form = multipart::Form::new()
        .part("file", part)
        .text("filename", filename.to_string());
    let mut builder = client.post(&plan.url);
    for (name, value) in &plan.headers {
        // Let reqwest set multipart Content-Type with boundary.
        if name.eq_ignore_ascii_case("content-type") {
            continue;
        }
        builder = builder.header(name, value);
    }
    let response = builder
        .multipart(form)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status().as_u16();
    let text = response.text().await.map_err(|error| error.to_string())?;
    let body = if text.trim().is_empty() {
        Value::Null
    } else {
        serde_json::from_str(&text).unwrap_or(Value::String(text))
    };
    Ok(HttpResponse { status, body })
}
