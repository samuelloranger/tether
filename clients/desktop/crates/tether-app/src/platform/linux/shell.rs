use std::process::Stdio;

use tether_core::hostcmd::host_command;

pub fn open_url(url: &str) {
    if !tether_core::links::is_openable(url) {
        return;
    }
    match host_command("xdg-open")
        .arg(url)
        .stdout(Stdio::null())
        .spawn()
    {
        // xdg-open can outlive the call; reap it off the UI thread so it doesn't linger as a zombie.
        Ok(mut child) => {
            std::thread::spawn(move || {
                let _ = child.wait();
            });
        }
        Err(e) => tracing::debug!("xdg-open failed: {e}"),
    }
}
