use crate::agents_md::LoadedAgentsMd;
use crate::agents_md::load_project_instructions;
use crate::config::Config;
use crate::environment_selection::TurnEnvironmentSnapshot;
use codex_extension_api::UserInstructions;
use codex_protocol::config_types::TrustLevel;
use codex_protocol::config_types::WindowsSandboxLevel;
use codex_protocol::protocol::TurnEnvironmentSelection;
use std::io;
use std::sync::Arc;
use tokio::sync::Mutex;

/// Owns the inputs and cached result of AGENTS.md discovery for a session.
pub(crate) struct AgentsMdManager {
    user_instructions: Option<UserInstructions>,
    cache: Mutex<AgentsMdCache>,
    guard_cache: Mutex<Option<GuardedInstructions>>,
}

/// What the guard layer decided about one instruction block.
///
/// The instructions gate runs once per model step, and the block is usually
/// identical across the whole session; re-reviewing it every step would ask the
/// guard the same question repeatedly and put a verdict line under every step.
struct GuardedInstructions {
    /// The block that was submitted for review.
    reviewed: String,
    /// What the step should use instead: the original, a rewrite, or nothing
    /// at all when the guard denied it.
    result: Option<Arc<LoadedAgentsMd>>,
}

#[derive(Default)]
struct AgentsMdCache {
    selections: Option<Vec<TurnEnvironmentSelection>>,
    active_project_trust_level: Option<TrustLevel>,
    windows_sandbox_level: Option<WindowsSandboxLevel>,
    loaded: Option<Arc<LoadedAgentsMd>>,
}

impl AgentsMdManager {
    pub(crate) fn new(user_instructions: Option<UserInstructions>) -> Self {
        Self {
            user_instructions: user_instructions
                .filter(|instructions| !instructions.text.trim().is_empty()),
            cache: Mutex::new(AgentsMdCache::default()),
            guard_cache: Mutex::new(None),
        }
    }

    #[tracing::instrument(name = "agents_md.refresh", skip_all)]
    pub(crate) async fn refresh(
        &self,
        config: &Config,
        environments: &TurnEnvironmentSnapshot,
        windows_sandbox_level: WindowsSandboxLevel,
    ) -> io::Result<()> {
        let selections = environments
            .turn_environments()
            .map(|environment| environment.selection.clone())
            .collect::<Vec<_>>();
        let active_project_trust_level = config.active_project.trust_level;
        {
            let mut cache = self.cache.lock().await;
            if cache.selections.as_ref() == Some(&selections)
                && cache.active_project_trust_level == active_project_trust_level
                && cache.windows_sandbox_level == Some(windows_sandbox_level)
            {
                return Ok(());
            }
            cache.selections = None;
            cache.active_project_trust_level = None;
            cache.windows_sandbox_level = None;
            cache.loaded = None;
        }

        let loaded = load_project_instructions(
            config,
            self.user_instructions.clone(),
            environments,
            windows_sandbox_level,
        )
        .await?
        .map(Arc::new);
        let mut cache = self.cache.lock().await;
        cache.selections = Some(selections);
        cache.active_project_trust_level = active_project_trust_level;
        cache.windows_sandbox_level = Some(windows_sandbox_level);
        cache.loaded = loaded;
        Ok(())
    }

    pub(crate) async fn get_loaded(&self) -> Option<Arc<LoadedAgentsMd>> {
        self.cache.lock().await.loaded.clone()
    }

    pub(crate) fn user_instructions(&self) -> Option<UserInstructions> {
        self.user_instructions.clone()
    }

    /// The guard's standing decision about `reviewed`, when it has already
    /// decided on exactly that block. `Some(None)` means it denied it.
    pub(crate) async fn guarded_instructions(
        &self,
        reviewed: &str,
    ) -> Option<Option<Arc<LoadedAgentsMd>>> {
        let cache = self.guard_cache.lock().await;
        cache
            .as_ref()
            .filter(|guarded| guarded.reviewed == reviewed)
            .map(|guarded| guarded.result.clone())
    }

    /// Remembers what the guard decided about one instruction block.
    pub(crate) async fn store_guarded_instructions(
        &self,
        reviewed: String,
        result: Option<Arc<LoadedAgentsMd>>,
    ) {
        *self.guard_cache.lock().await = Some(GuardedInstructions { reviewed, result });
    }
}
