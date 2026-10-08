use std::process::{Command, Stdio};

pub fn open_url(url: &str) {
    if !tether_core::links::is_openable(url) {
        return;
    }
    match Command::new("xdg-open")
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
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
