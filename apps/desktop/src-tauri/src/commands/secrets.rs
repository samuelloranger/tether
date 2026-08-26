fn secure_entry(host_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new("tether-desktop", &format!("server-password-{host_id}"))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn secure_get_password(host_id: String) -> Result<Option<String>, String> {
    match secure_entry(&host_id)?.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
pub fn secure_set_password(host_id: String, password: String) -> Result<(), String> {
    secure_entry(&host_id)?
        .set_password(&password)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn secure_clear_password(host_id: String) -> Result<(), String> {
    match secure_entry(&host_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn legacy_secure_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new("tether-desktop", "server-password").map_err(|error| error.to_string())
}

#[tauri::command]
pub fn secure_get_legacy_password() -> Result<Option<String>, String> {
    match legacy_secure_entry()?.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
pub fn secure_clear_legacy_password() -> Result<(), String> {
    match legacy_secure_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}
