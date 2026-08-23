//! End-to-end coverage for the guard layer wired into `codex-core`.

use anyhow::Result;
use codex_guardian::GuardianMode;
use core_test_support::responses::ev_assistant_message;
use core_test_support::responses::ev_completed;
use core_test_support::responses::ev_response_created;
use core_test_support::responses::mount_sse_once;
use core_test_support::responses::sse;
use core_test_support::responses::start_mock_server;
use core_test_support::skip_if_no_network;
use core_test_support::test_codex::test_codex;
use pretty_assertions::assert_eq;

#[tokio::test]
async fn guarding_is_off_by_default_and_writes_nothing() -> Result<()> {
    skip_if_no_network!(Ok(()));

    let server = start_mock_server().await;
    mount_sse_once(
        &server,
        sse(vec![
            ev_response_created("resp-1"),
            ev_assistant_message("msg-1", "hello back"),
            ev_completed("resp-1"),
        ]),
    )
    .await;

    let mut builder = test_codex();
    let test = builder.build(&server).await?;

    assert_eq!(test.config.guardian.mode, GuardianMode::Off);

    test.submit_turn("hello").await?;

    assert!(
        !test.codex_home_path().join("guardian").exists(),
        "the default configuration must not write a guardian directory"
    );

    Ok(())
}
