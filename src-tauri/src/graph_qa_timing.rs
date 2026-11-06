//! Explicit candidate-build gate. Metadata only; never inspect an Invoke payload/response.
pub(crate) fn enabled() -> bool { option_env!("LUCKYRAY_GRAPH_TIMING") == Some("1") }
pub(crate) fn epoch_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map(|v|v.as_secs_f64()*1000.0).unwrap_or(0.0)
}
/// Measure the query body separately from async command admission. No extra
/// task, lock or data recovery is introduced; forward the original Result.
fn read<T>(command: &'static str, work: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    if !enabled() { return work(); }
    let start = epoch_ms();
    let result = work();
    dispatch(command, start, result.is_ok());
    result
}
pub(crate) fn sync_targets<T>(work: impl FnOnce() -> Result<T, String>) -> Result<T, String> { read("query_managed_vault_sync_targets", work) }
pub(crate) fn connection_status<T>(work: impl FnOnce() -> Result<T, String>) -> Result<T, String> { read("query_conn_state", work) }
pub(crate) fn vault_list<T>(work: impl FnOnce() -> Result<T, String>) -> Result<T, String> { read("query_managed_vault_list", work) }
pub(crate) fn dispatch(command: &str, start: f64, handled: bool) {
    if !enabled() || !command.bytes().all(|c|c.is_ascii_alphanumeric() || b"_:|".contains(&c)) {return;}
    // Dispatch includes sync commands, but only schedules async commands. Its
    // status is handler admission, NOT the command's success (measured in JS).
    let row=serde_json::json!({"command":format!("dispatch.{command}"),"start":start,"end":epoch_ms(),"status":if handled {"ok"}else{"fail"}});
    #[cfg(target_os="android")]
    {
        use std::ffi::CString;
        #[link(name="log")]
        extern "C" {fn __android_log_write(priority:i32,tag:*const std::os::raw::c_char,text:*const std::os::raw::c_char)->i32;}
        if let Ok(text)=CString::new(row.to_string()) {unsafe{__android_log_write(4,b"LR-GRAPH-META\0".as_ptr().cast(),text.as_ptr());}}
    }
    #[cfg(not(target_os="android"))]
    let _=row;
}
