use std::path::PathBuf;

use anyhow::Result;
use codex_uds::UnixListener;
use pretty_assertions::assert_eq;
use tempfile::tempdir;
use tokio::io::AsyncBufReadExt;
use tokio::io::AsyncWriteExt;
use tokio::io::BufReader;

use super::*;

fn context() -> ActivityContext {
    ActivityContext::new(
        "thread-ipc",
        "session-1",
        "turn-1",
        PathBuf::from("/repo"),
        "gpt-5",
        "codex_cli_rs",
        None,
    )
}

fn tool_call() -> GuardedAction {
    GuardedAction::ToolCall {
        tool_name: "Bash".to_string(),
        matcher_aliases: Vec::new(),
        call_id: "call-1".to_string(),
        tool_input: serde_json::json!({ "command": "rm -rf /" }),
    }
}

/// Serves `replies.len()` connections, answering each with the given line and
/// returning the requests it saw.
fn serve(
    mut listener: UnixListener,
    replies: Vec<Option<String>>,
) -> tokio::task::JoinHandle<Vec<String>> {
    tokio::spawn(async move {
        let mut requests = Vec::new();
        for reply in replies {
            let Ok(stream) = listener.accept().await else {
                break;
            };
            let mut reader = BufReader::new(stream);
            let mut line = String::new();
            if reader.read_line(&mut line).await.is_ok() {
                requests.push(line);
            }
            if let Some(reply) = reply {
                let mut stream = reader.into_inner();
                let _ = stream.write_all(reply.as_bytes()).await;
                let _ = stream.flush().await;
            }
        }
        requests
    })
}

#[tokio::test]
async fn relays_the_action_and_enforces_the_returned_verdict() -> Result<()> {
    let dir = tempdir()?;
    let socket_path = dir.path().join("guardian.sock");
    let listener = UnixListener::bind(&socket_path).await?;
    let served = serve(
        listener,
        vec![Some(
            r#"{"verdict":{"decision":"deny","reason":"destructive command"}}"#.to_string() + "\n",
        )],
    );

    let guardian = IpcGuardian::new(
        &socket_path,
        Duration::from_secs(5),
        /*fail_closed*/ true,
    );
    let verdict = guardian.review(&context(), &tool_call()).await?;

    assert_eq!(
        verdict,
        Verdict::Deny {
            reason: "destructive command".to_string()
        }
    );
    let requests = served.await?;
    assert_eq!(requests.len(), 1);
    assert!(requests[0].contains(r#""type":"review""#));
    assert!(requests[0].contains(r#""tool_name":"Bash""#));
    assert!(requests[0].contains(r#""thread_id":"thread-ipc""#));
    Ok(())
}

#[tokio::test]
async fn returns_rewrite_verdicts_verbatim() -> Result<()> {
    let dir = tempdir()?;
    let socket_path = dir.path().join("guardian.sock");
    let listener = UnixListener::bind(&socket_path).await?;
    let served = serve(
        listener,
        vec![Some(
            r#"{"verdict":{"decision":"rewrite","payload":{"command":"ls"},"note":"sanitized"}}"#
                .to_string()
                + "\n",
        )],
    );

    let guardian = IpcGuardian::new(
        &socket_path,
        Duration::from_secs(5),
        /*fail_closed*/ true,
    );
    let verdict = guardian.review(&context(), &tool_call()).await?;

    assert_eq!(
        verdict,
        Verdict::Rewrite {
            payload: serde_json::json!({ "command": "ls" }),
            note: Some("sanitized".to_string()),
        }
    );
    served.await?;
    Ok(())
}

#[tokio::test]
async fn reports_unavailable_when_no_daemon_is_listening() -> Result<()> {
    let dir = tempdir()?;
    let guardian = IpcGuardian::new(
        dir.path().join("absent.sock"),
        Duration::from_secs(1),
        /*fail_closed*/ true,
    );

    let err = guardian
        .review(&context(), &tool_call())
        .await
        .expect_err("connect to a missing socket must fail");

    assert!(matches!(err, GuardianError::Unavailable(_)));
    assert_eq!(guardian.failure_posture(), FailurePosture::FailClosed);
    assert_eq!(
        Verdict::on_error(&err, guardian.failure_posture()).label(),
        "deny"
    );
    Ok(())
}

#[tokio::test]
async fn a_dropped_connection_is_a_transport_error_not_a_verdict() -> Result<()> {
    let dir = tempdir()?;
    let socket_path = dir.path().join("guardian.sock");
    let listener = UnixListener::bind(&socket_path).await?;
    let served = serve(listener, vec![None]);

    let guardian = IpcGuardian::new(
        &socket_path,
        Duration::from_secs(5),
        /*fail_closed*/ true,
    );
    let err = guardian
        .review(&context(), &tool_call())
        .await
        .expect_err("a closed connection must not read as allow");

    assert!(matches!(err, GuardianError::Unavailable(_)));
    served.await?;
    Ok(())
}

#[tokio::test]
async fn recording_never_fails_the_caller() -> Result<()> {
    let dir = tempdir()?;
    let guardian = IpcGuardian::new(
        dir.path().join("absent.sock"),
        Duration::from_secs(1),
        /*fail_closed*/ true,
    );

    // No daemon, no panic, no error surface: recording is log-only.
    guardian.record(&context(), &Activity::SessionStarted).await;
    Ok(())
}
