# Codex App Server, group context, and deep-link E2E report

Date: 2026-07-18 (Asia/Shanghai)

Primary GUI marker: `E2E_20260718_1641_IRYVB`

Additional isolated markers: `BUNF1Q`, `TA7Q`, `TB9R`, `CG5N`, `QT6P`, `CO9V`

This report records the final acceptance run for the Codex App Server migration, bounded group/topic history, and authenticated local Codex deep-link fallback. All Feishu messages and card clicks described below were performed in the visible macOS Feishu GUI. The evidence PNGs are kept outside the public repository in the matching `E2E_EVIDENCE_E2E_20260718_1641_IRYVB` audit directory so unrelated private conversations are not published.

## Automated verification

- `pnpm test` on the final rebased public branch: 93 files, 569 tests passed (the original feature baseline was 89 files / 528 tests).
- `pnpm typecheck`: passed.
- `pnpm build`: passed.
- `git diff --check`: passed.
- Real Codex CLI process test used `codex-cli 0.144.3`: one App Server handled new thread, resumed thread, interrupt, forced exit, one replacement process, and graceful close without replay or orphan.
- CI matrix is macOS, Ubuntu, and Windows on Node 20; final public run links are recorded in the merged pull request.

## App Server lifecycle

The real `codex` launch agent bridge PID was `34933` during the final GUI run.

- Private first/follow-up, `/new`, `/resume`, topic A, and topic B reused App Server PID `21776`; no `codex exec` child existed.
- `/stop` interrupted the active `sleep 30` turn, rendered the interrupted card, omitted `STOP_TEST_DONE_E2E_20260718_BUNF1Q`, and left PID `21776` alive.
- Restarting the bridge terminated the old profile-owned App Server and the first post-restart topic request lazily created PID `35369`.
- Topic B resumed thread suffix `208b56`; topic A resumed suffix `2e1eb0`. Both survived the bridge restart with the same isolated content.
- At 17:20, visible private message suffix `8d082` started `sleep 30`; PID `35369` was terminated. The card visibly failed with `codex app-server exited unexpectedly with code 0`, and the forbidden completion was never emitted.
- At 17:21, message suffix `a3ca83` started a new task. It created replacement PID `40348`, replied `CRASH_RECOVERY_OK_E2E_20260718_CG5N`, and did not replay the failed turn.
- Final process audit: exactly one direct `codex app-server --listen stdio://` child (`40348`) of bridge `34933`, zero direct `codex exec` children.
- Standalone real-process shutdown verification closed its App Server and found no descendant/orphan; launch-agent restart verification likewise left no old profile-owned App Server.

Evidence: `07-p2p-reuse-and-stop.png`, `12-topic-b-after-bridge-restart.png`, `13-topic-a-after-bridge-restart.png`, `14-app-server-crash-visible-failure.png`, `15-app-server-auto-recovery.png`.

## Private-session and concurrency GUI acceptance

- `PRIVATE_E2E_20260718_BUNF1Q` (message suffix `465c5b`, 16:58) stored `4242`; follow-up suffix `c6fa82` returned it on the same Codex thread.
- `/new` produced a different thread while preserving the shared App Server PID.
- `/resume 5` restored the earlier CARD thread; suffix `a5ab2f3` returned `CARD_OK_E2E_20260718_1641_IRYVB` on thread suffix `960583`.
- Two scopes were launched through GUI 1.46 seconds apart: private suffix `1cab8a2` at 17:34:17 and topic-A suffix `cc4bd0` at 17:34:19. Pool activity reached 2; both `sleep 10` tools overlapped and returned their own `CONCURRENT_*_OK_E2E_20260718_CO9V` values on thread suffixes `960583` and `2e1eb0`, without mixed cards/output.

Evidence: `07-p2p-reuse-and-stop.png`, `23-concurrent-topic-a.png`, `24-concurrent-private.png`.

## Regular group history

Real regular group suffix: `df4769`.

- Non-mention message suffix `b1a6d7` at 16:41:20: `CTX_A_E2E_20260718_BUNF1Q 苹果`.
- Non-mention message suffix `b4d3b7` at 16:41:30: `CTX_B_E2E_20260718_BUNF1Q 蓝色`.
- Neither ordinary message triggered the bot.
- The next visible @Mac Codex request returned exactly A = 苹果 and B = 蓝色, with no marker from another group.
- Late message suffix `e596a5` at 16:42:15 was excluded from the already-triggered turn. The next turn reported `group_context` full with 3 messages / 127 characters and visibly returned `CTX_LATE_E2E_20260718_BUNF1Q 触发后消息`.
- Logs contain context status/count/character totals only; history bodies are absent from context log events.
- Automated bounds/degradation coverage verifies 30 messages, 24,000 characters, 24-hour lookback, pagination, permission failure, and cursor advancement only after accepted `turn/start`.

Evidence: `08-regular-group-context.png`, `09-regular-group-late-next-turn.png`.

## Topic isolation and restart

Real topic group suffix: `d5b0e9f`.

- Topic A scope suffix `omt_193ecb8b3e4f1c80`, first message suffix `bddeb96`, Codex thread suffix `2e1eb0`: returned only `ALPHA-731`.
- Topic B scope suffix `omt_193ecb7914cf1c89`, first message suffix `56cf2e1`, Codex thread suffix `208b56`: returned only `BETA-842_NO_OTHER_SECRET`.
- Replies stayed inside the correct topic detail panel.
- After bridge restart, topic-B suffix `8323ef` resumed `208b56` and returned only `BETA-842`; topic-A suffix `4e0b3f` resumed `2e1eb0` and returned only `ALPHA-731`.

Evidence: `10-topic-a.png`, `11-topic-b.png`, `12-topic-b-after-bridge-restart.png`, `13-topic-a-after-bridge-restart.png`.

## Quote, attachment, authors, and degradation

- A visible context-menu Reply action quoted the earlier crash-recovery request. Message suffix `3ea7d4` at 17:22 returned `QUOTE_OK_E2E_20260718_QT6P CRASH_RECOVERY_GUI_E2E_20260718_CG5N`; the quote was not repeated in group history.
- A screenshot was selected with the macOS file picker and sent through Feishu as the current image attachment. The resulting event logged `[REDACTED_RESOURCE]`; Codex described the screenshot and extracted `CRASH_RECOVERY_OK_E2E_20260718_CG5N`, proving the existing attachment download/vision path still worked.
- Automated tests cover two distinct sender names, sender order, bot author labeling, current/quote/history global message-ID deduplication, metadata-only historical attachments, and degraded permission/API cases.

Evidence: `16-quoted-message-context.png`, `17-current-image-attachment.png`.

## Desktop deep links

- Direct Feishu `open_url` to `codex://threads/...` was clicked and did nothing; failure evidence was saved before implementing the fallback.
- The final button uses a signed, thread-bound, scope/chat/operator-bound callback token. The card payload contains neither an arbitrary URL nor a raw thread ID. The dispatcher verifies signature, scope, chat, operator, policy, expiry, and nonce before invoking a fixed argv opener for the validated `codex://threads/<thread-id>` target.
- A final result/status button click brought ChatGPT/Codex to the exact thread suffix `960583` containing `CARD_OK_E2E_20260718_1641_IRYVB`.
- `/resume` entry 3 opened topic-B thread suffix `208b56` at 17:28:24; a fresh `/resume` card entry 5 opened private thread suffix `0a555c` at 17:33:00. The frontmost app was ChatGPT and screenshots show the expected conversation bodies.
- Completed, running, failed, and interrupted cards render the link; tests also verify old/new card stability, invalid/missing/Claude sessions, and mobile-safe wording.

Evidence: `01-p2p-final-card-deeplink.png`, `02-after-deeplink-click.png`, `03-status-card-before-click.png`, `06-codex-thread-opened.png`, `20-resume-history-card.png`, `21-resume-entry-topic-b-opened.png`, `22-resume-entry-private-opened.png`.

## Permissions and publication

The Feishu app was granted `im:message:readonly` and sensitive `im:message.group_msg`; version 1.0.3 was published at 16:39 before group testing. Access control and mention gating run before history fetch. Failure to read history degrades to the trigger batch and explicit quotes rather than claiming complete history.

## Final checklist

- Persistent per-profile App Server, protocol handshake, reuse, concurrency, interrupt, unexpected-exit failure, recovery, shutdown: passed.
- Real Codex thread IDs and resume/list behavior; no `codex exec` fallback: passed.
- Regular group bounded history, late-message boundary, cursor persistence, low-sensitivity logging: passed.
- Topic isolation by `thread_id` and bridge-restart continuity: passed.
- Current batch / explicit quote / history deduplication and attachment regression: passed.
- Authenticated exact desktop deep links across result, status, resume, failed/interrupted rendering: passed.
- English/Chinese README, permissions, limits, recovery, and desktop/mobile limitations: documented.
- Public fork, pull request, three-platform CI, and merge identifiers: recorded by the final release handoff.
