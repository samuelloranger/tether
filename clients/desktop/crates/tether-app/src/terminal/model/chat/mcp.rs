//! The machine's saved HTTP MCP servers. Headers can hold tokens, so the whole list is one
//! secret in the app's secret store (DPAPI on Windows, the Secret Service on Linux).

use std::sync::Arc;

use tether_core::acp::session_setup::McpServer;
use tether_core::secrets::SecretStore;

#[derive(Clone)]
pub struct McpLibrary {
    store: Arc<dyn SecretStore>,
    account: String,
}

impl McpLibrary {
    /// `scope` is the machine's `host:port`; the account keeps only the characters a secret name allows.
    pub fn new(store: Arc<dyn SecretStore>, scope: &str) -> Self {
        let hex: String = scope.bytes().map(|b| format!("{b:02x}")).collect();
        Self {
            store,
            account: format!("mcp-servers-{hex}"),
        }
    }

    /// An unreadable store reads as empty: the dialog then offers to add one, and saving reports the real error.
    pub fn list(&self) -> Vec<McpServer> {
        self.store
            .get(&self.account)
            .ok()
            .flatten()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, servers: &[McpServer]) -> Result<(), String> {
        if servers.is_empty() {
            return self.store.delete(&self.account).map_err(|e| e.to_string());
        }
        let bytes = serde_json::to_vec(servers).map_err(|e| e.to_string())?;
        self.store
            .set(&self.account, &bytes)
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tether_core::acp::session_setup::McpHeader;
    use tether_core::secrets::MemorySecretStore;

    #[test]
    fn the_list_round_trips_through_the_secret_store_and_never_a_plain_file() {
        let store = Arc::new(MemorySecretStore::default());
        let library = McpLibrary::new(store.clone(), "box.local:22");
        assert!(library.list().is_empty());
        let servers = vec![McpServer {
            name: "docs".into(),
            url: "https://x.test/mcp".into(),
            headers: vec![McpHeader {
                name: "Authorization".into(),
                value: "Bearer t".into(),
            }],
        }];
        library.save(&servers).unwrap();
        assert_eq!(library.list(), servers);
        assert!(McpLibrary::new(store.clone(), "other:22").list().is_empty());
        library.save(&[]).unwrap();
        assert!(library.list().is_empty());
    }
}
