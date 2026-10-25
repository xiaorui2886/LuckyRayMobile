// Synthetic host-only app state adapters; no Tauri or real database.
use std::sync::{Arc,Mutex,atomic::{AtomicU64,Ordering}};
use gateway::GatewayClient;
#[derive(Clone,Copy,PartialEq)] enum ConnectionIntent {Auto,Stopped}
struct Intent; impl Intent {fn get(&self)->ConnectionIntent {ConnectionIntent::Auto}}
#[derive(Clone)] struct Paired {instance_id:String}
struct Db {paired:Paired} impl Db {fn paired(&self)->Result<Option<Paired>,String>{Ok(Some(self.paired.clone()))}}
struct AppState {connection_lifecycle:ConnectionLifecycle,conn_intent:Intent,db:Mutex<Db>,base:String}
type SharedState=Arc<Mutex<AppState>>;
fn connection_controls(s:&SharedState)->(ConnectionLifecycle,()) {(s.lock().unwrap().connection_lifecycle.clone(),())}
fn current_conn_intent(_: &SharedState)->ConnectionIntent {ConnectionIntent::Auto}
fn require_paired(s:&SharedState)->Result<(Paired,GatewayClient),String>{let g=s.lock().unwrap();let p=g.db.lock().unwrap().paired.clone();Ok((p,GatewayClient::new(&"00".repeat(32),&g.base,"synthetic-only")))}
