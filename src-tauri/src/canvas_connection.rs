//! Binds the canvas-only transport to one captured paired owner and epoch.
//! This is an internal connection, not a Tauri command or browser bridge.
use crate::{canvas_upstream::{CanvasAsset, CanvasMedia, CanvasUpstream}, content::{expected_gateway, ExpectedGateway}, SharedState};
use zeroize::Zeroizing;

pub(crate) struct CanvasConnection {
    state: SharedState,
    gateway: ExpectedGateway,
    upstream: CanvasUpstream,
}

impl CanvasConnection {
    pub(crate) fn current(&self) -> Result<(), String> {
        self.gateway.canvas_connection_current(&self.state)
    }

    pub(crate) async fn open(state: SharedState, expected_instance: &str) -> Result<Self, String> {
        let gateway = expected_gateway(&state, expected_instance)?;
        gateway.canvas_connection_current(&state)?;
        let (status, response) = gateway.canvas_session_mint(&state).await?;
        match status {
            200 => {},
            401 => return Err("CANVAS_PAIRING_REQUIRED".into()),
            403 => return Err("CANVAS_NOT_GRANTED".into()),
            _ => return Err("CANVAS_SERVICE_UNAVAILABLE".into()),
        }
        // The reference is already held in zeroizing storage and is never
        // passed to the UI or persisted.
        let reference = response.ok_or("CANVAS_BOOTSTRAP_INVALID")?;
        let upstream = CanvasUpstream::bootstrap(gateway.paired_base(), gateway.pinned_fingerprint(), reference).await?;
        // Includes the captured connection epoch, not merely Desktop identity.
        gateway.canvas_connection_current(&state)?;
        Ok(Self { state, gateway, upstream })
    }

    pub(crate) async fn list(&self) -> Result<Zeroizing<Vec<u8>>, String> {
        self.gateway.canvas_connection_current(&self.state)?;
        let response = self.upstream.list().await?;
        self.gateway.canvas_connection_current(&self.state)?;
        Ok(response)
    }

    pub(crate) async fn load(&self, id: &str) -> Result<Zeroizing<Vec<u8>>, String> {
        self.gateway.canvas_connection_current(&self.state)?;
        let response = self.upstream.load(id).await?;
        // Never publish a completed read from a retired owner or epoch.
        self.gateway.canvas_connection_current(&self.state)?;
        Ok(response)
    }

    pub(crate) async fn asset(&self, path: &str) -> Result<CanvasAsset, String> {
        self.gateway.canvas_connection_current(&self.state)?;
        let response = self.upstream.asset(path).await?;
        self.gateway.canvas_connection_current(&self.state)?;
        Ok(response)
    }

    pub(crate) async fn media(&self, id: &str, range: Option<&str>) -> Result<CanvasMedia, String> {
        self.current()?;
        let response = self.upstream.media(id, range).await?;
        self.current()?;
        Ok(response)
    }

    pub(crate) async fn media_chunk(&self, media: &mut CanvasMedia) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
        self.current()?;
        let chunk = media.chunk().await?;
        self.current()?;
        Ok(chunk)
    }

}
