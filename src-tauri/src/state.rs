// Managed backend state. For now just the content-search cancellation tokens
// (spec §5.8.1 / design §3.4): each in-flight search registers an AtomicBool
// keyed by its searchId; `cancel_search` flips it and the scan loop stops.

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub struct SearchState {
    tokens: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl SearchState {
    /// Register (replacing any prior) a cancel token for a search id.
    pub fn register(&self, search_id: &str) -> Arc<AtomicBool> {
        let token = Arc::new(AtomicBool::new(false));
        if let Ok(mut map) = self.tokens.lock() {
            map.insert(search_id.to_string(), token.clone());
        }
        token
    }

    pub fn cancel(&self, search_id: &str) {
        if let Ok(map) = self.tokens.lock() {
            if let Some(token) = map.get(search_id) {
                token.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        }
    }

    pub fn unregister(&self, search_id: &str) {
        if let Ok(mut map) = self.tokens.lock() {
            map.remove(search_id);
        }
    }
}
