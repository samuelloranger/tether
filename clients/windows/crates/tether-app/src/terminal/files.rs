use std::sync::Arc;

use crate::terminal::{driver::MsgSink, model::SendJob, remote::Remote};

pub async fn run_send<R: Remote>(_remote: Arc<R>, _job: SendJob, _send: MsgSink) {}
