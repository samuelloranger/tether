use std::path::Path;
use std::sync::{Arc, OnceLock};

use tether_core::upload::{jpeg_name, preflight, remote_path};

use crate::terminal::driver::MsgSink;
use crate::terminal::model::Msg;
use crate::terminal::model::{SendJob, SendSource};
use crate::terminal::remote::Remote;

pub trait ImageCodec: Send + Sync {
    fn to_jpeg(&self, bytes: &[u8]) -> Option<Vec<u8>>;
}

pub struct NoCodec;
impl ImageCodec for NoCodec {
    fn to_jpeg(&self, _bytes: &[u8]) -> Option<Vec<u8>> {
        None
    }
}

static CODEC: OnceLock<Arc<dyn ImageCodec>> = OnceLock::new();

pub fn set_codec(c: Arc<dyn ImageCodec>) {
    let _ = CODEC.set(c);
}

fn codec() -> Arc<dyn ImageCodec> {
    CODEC.get().cloned().unwrap_or_else(|| Arc::new(NoCodec))
}

fn file_name(p: &Path) -> String {
    p.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| p.display().to_string())
}

pub fn plan(src: &SendSource) -> Result<String, (String, String)> {
    match src {
        SendSource::Bytes { name, data } => preflight(false, data.len() as u64)
            .map(|_| name.clone())
            .map_err(|r| (name.clone(), r)),
        SendSource::Path(p) => {
            let name = file_name(p);
            let meta = std::fs::metadata(p).map_err(|e| (name.clone(), e.to_string()))?;
            if meta.is_dir() {
                return preflight(true, 0)
                    .map(|_| name.clone())
                    .map_err(|r| (name, r));
            }
            match jpeg_name(&name) {
                Some(jpg) => Ok(jpg),
                None => preflight(false, meta.len())
                    .map(|_| name.clone())
                    .map_err(|r| (name, r)),
            }
        }
    }
}

pub fn prepare(src: SendSource, codec: &dyn ImageCodec) -> Result<(String, Vec<u8>), String> {
    let (name, data) = match src {
        SendSource::Bytes { name, data } => (name, data),
        SendSource::Path(p) => (file_name(&p), std::fs::read(&p).map_err(|e| e.to_string())?),
    };
    let original_name = name.clone();
    let (name, data) = match jpeg_name(&name) {
        Some(jpg) => match codec.to_jpeg(&data) {
            Some(jpeg) => (jpg, jpeg),
            None => (original_name, data),
        },
        None => (name, data),
    };
    preflight(false, data.len() as u64)?;
    Ok((name, data))
}

pub async fn run_send<R: Remote>(remote: Arc<R>, job: SendJob, send: MsgSink) {
    run_send_with(remote, job, send, codec()).await
}

pub async fn run_send_with<R: Remote>(
    remote: Arc<R>,
    job: SendJob,
    send: MsgSink,
    codec: Arc<dyn ImageCodec>,
) {
    let mut plans = Vec::new();
    for src in &job.sources {
        let p = plan(src);
        let stop = p.is_err();
        plans.push(p);
        if stop {
            break;
        }
    }
    let names = plans
        .iter()
        .map(|p| match p {
            Ok(n) => n.clone(),
            Err((n, _)) => n.clone(),
        })
        .collect();
    send(Msg::SendStarted { names });
    let dir = remote.uploads_dir().await.or(job.fallback_dir.clone());
    for (index, (src, planned)) in job.sources.into_iter().zip(plans).enumerate() {
        send(Msg::SendFileStarted { index });
        if let Err((_, reason)) = planned {
            return send(Msg::SendFileFailed { reason });
        }
        let codec = codec.clone();
        let prepared = tokio::task::spawn_blocking(move || prepare(src, codec.as_ref()))
            .await
            .unwrap_or_else(|e| Err(e.to_string()));
        let (name, data) = match prepared {
            Ok(p) => p,
            Err(reason) => return send(Msg::SendFileFailed { reason }),
        };
        let target = remote_path(dir.as_deref(), &name);
        match remote.upload(&target, data).await {
            Ok(()) => send(Msg::SendFileDone { remote: target }),
            Err(e) => {
                return send(Msg::SendFileFailed {
                    reason: e.sentence(),
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::terminal::model::Msg;
    use crate::terminal::testkit::FakeRemote;
    use std::sync::Mutex;

    struct Jpeg(Option<Vec<u8>>);
    impl ImageCodec for Jpeg {
        fn to_jpeg(&self, _b: &[u8]) -> Option<Vec<u8>> {
            self.0.clone()
        }
    }

    fn file(dir: &tempfile::TempDir, name: &str, len: u64) -> PathBuf {
        let p = dir.path().join(name);
        std::fs::File::create(&p).unwrap().set_len(len).unwrap();
        p
    }

    #[test]
    fn plan_names_files_and_refuses_folders_and_oversize_before_reading() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            plan(&SendSource::Path(file(&dir, "a.png", 10))),
            Ok("a.png".into())
        );
        assert_eq!(
            plan(&SendSource::Path(file(&dir, "IMG.HEIC", 10))),
            Ok("IMG.jpg".into())
        );
        assert_eq!(
            plan(&SendSource::Path(dir.path().to_path_buf()))
                .unwrap_err()
                .1,
            tether_core::upload::FOLDER_REFUSAL
        );
        let big = file(&dir, "big.mov", 214 * 1024 * 1024);
        assert_eq!(
            plan(&SendSource::Path(big)).unwrap_err().1,
            "That's 214 MB — Tether sends up to 200 MB at a time."
        );
    }

    #[test]
    fn attachable_images_and_other_files_go_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("notes.txt");
        std::fs::write(&p, b"hi").unwrap();
        assert_eq!(
            prepare(SendSource::Path(p), &Jpeg(Some(vec![9]))),
            Ok(("notes.txt".into(), b"hi".to_vec()))
        );
    }

    #[test]
    fn other_images_are_reencoded_and_undecodable_ones_go_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("shot.heic");
        std::fs::write(&p, b"heic").unwrap();
        assert_eq!(
            prepare(SendSource::Path(p.clone()), &Jpeg(Some(vec![1, 2]))),
            Ok(("shot.jpg".into(), vec![1, 2]))
        );
        assert_eq!(
            prepare(SendSource::Path(p), &Jpeg(None)),
            Ok(("shot.heic".into(), b"heic".to_vec()))
        );
    }

    #[test]
    fn the_limit_applies_after_reencoding() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("huge.tiff");
        std::fs::write(&p, b"tiff").unwrap();
        let encoded = vec![0u8; (tether_core::upload::BYTE_LIMIT + 1) as usize];
        assert!(
            prepare(SendSource::Path(p), &Jpeg(Some(encoded)))
                .unwrap_err()
                .starts_with("That's")
        );
    }

    fn recorder() -> (MsgSink, Arc<Mutex<Vec<String>>>) {
        let log = Arc::new(Mutex::new(Vec::new()));
        let l = log.clone();
        let sink: MsgSink = Arc::new(move |m: Msg| {
            let line = match m {
                Msg::SendStarted { names } => format!("started {}", names.join(",")),
                Msg::SendFileStarted { index } => format!("file {index}"),
                Msg::SendFileDone { remote } => format!("done {remote}"),
                Msg::SendFileFailed { reason } => format!("failed {reason}"),
                other => format!("{other:?}"),
            };
            l.lock().unwrap().push(line);
        });
        (sink, log)
    }

    #[tokio::test]
    async fn sends_in_order_one_upload_each_into_the_uploads_folder() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.png");
        std::fs::write(&a, b"aa").unwrap();
        let b = dir.path().join("b.png");
        std::fs::write(&b, b"bbb").unwrap();
        let remote = Arc::new(FakeRemote::default());
        let (sink, log) = recorder();
        let job = SendJob {
            sources: vec![SendSource::Path(a), SendSource::Path(b)],
            fallback_dir: Some("/srv/proj".into()),
        };
        run_send_with(remote.clone(), job, sink, Arc::new(NoCodec)).await;
        assert_eq!(
            *log.lock().unwrap(),
            [
                "started a.png,b.png",
                "file 0",
                "done /home/sam/.tether/uploads/a.png",
                "file 1",
                "done /home/sam/.tether/uploads/b.png",
            ]
        );
        let uploads: Vec<_> = remote
            .log()
            .into_iter()
            .filter(|l| l.starts_with("upload"))
            .collect();
        assert_eq!(
            uploads,
            [
                "upload /home/sam/.tether/uploads/a.png 2",
                "upload /home/sam/.tether/uploads/b.png 3"
            ]
        );
    }

    #[tokio::test]
    async fn without_an_uploads_folder_the_session_directory_is_used() {
        let remote = Arc::new(FakeRemote::default());
        *remote.uploads_dir.lock().unwrap() = None;
        let (sink, log) = recorder();
        let job = SendJob {
            sources: vec![SendSource::Bytes {
                name: "paste-1.png".into(),
                data: vec![1],
            }],
            fallback_dir: Some("/srv/proj".into()),
        };
        run_send_with(remote, job, sink, Arc::new(NoCodec)).await;
        assert!(
            log.lock()
                .unwrap()
                .contains(&"done /srv/proj/paste-1.png".to_string())
        );
    }

    #[tokio::test]
    async fn a_failure_stops_the_queue() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.png");
        std::fs::write(&a, b"a").unwrap();
        let b = dir.path().join("b.png");
        std::fs::write(&b, b"b").unwrap();
        let c = dir.path().join("c.png");
        std::fs::write(&c, b"c").unwrap();
        let remote = Arc::new(FakeRemote::default());
        remote.upload_results.lock().unwrap().extend([
            Ok(()),
            Err(tether_core::connect::ConnectError::Transport(
                "scp: disk full".into(),
            )),
        ]);
        let (sink, log) = recorder();
        let job = SendJob {
            sources: vec![
                SendSource::Path(a),
                SendSource::Path(b),
                SendSource::Path(c),
            ],
            fallback_dir: None,
        };
        run_send_with(remote.clone(), job, sink, Arc::new(NoCodec)).await;
        let log = log.lock().unwrap().clone();
        assert_eq!(
            log.last().unwrap(),
            &format!(
                "failed {}",
                tether_core::connect::ConnectError::Transport("scp: disk full".into()).sentence()
            )
        );
        assert_eq!(
            remote
                .log()
                .iter()
                .filter(|l| l.starts_with("upload"))
                .count(),
            2
        );
    }

    #[tokio::test]
    async fn a_folder_in_the_batch_stops_the_queue_there() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.png");
        std::fs::write(&a, b"a").unwrap();
        let sub = dir.path().join("photos");
        std::fs::create_dir(&sub).unwrap();
        let remote = Arc::new(FakeRemote::default());
        let (sink, log) = recorder();
        let job = SendJob {
            sources: vec![SendSource::Path(a), SendSource::Path(sub)],
            fallback_dir: None,
        };
        run_send_with(remote, job, sink, Arc::new(NoCodec)).await;
        assert_eq!(
            *log.lock().unwrap(),
            [
                "started a.png,photos",
                "file 0",
                "done /home/sam/.tether/uploads/a.png",
                "file 1",
                "failed Tether sends files, not folders.",
            ]
        );
    }
}
