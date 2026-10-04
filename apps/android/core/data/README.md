# Android data layer

Create one SessionRepository, InteractionRepository, WorkspaceRepository and SyncEngine per paired host. Bind each engine to that host ConnectionManager.rcpClient. watchSession/unwatchSession controls visible conversation streams; bind resumes their durable cursors and recreates the three host-wide subscriptions when the secure channel changes. closeAll disposes the engine. Pending interactions are cleared when disconnected; mutating routes must require a current RCP client.

PushTokenRegistrar persists FCM tokens and host-offline preferences. Provide a relayForHost lookup so registrations reuse foreground relay sockets; start/stop follows foreground visibility. updateToken schedules a bounded registration attempt even when called by Firebase outside an activity. Failed registrations retain the token for the next startup/connection attempt. registerWithRelay allows an immediate retry when authentication finishes.

SettingsService uses the host-authoritative notification and self-device APIs. A successful rotateApprovalKey response means pending PC confirmation only. Remove local pairing material after devices.unpair is acknowledged. DiagnosticsRepository accepts fixed event codes, truncates host identifiers, and retains at most 200 entries.

Implementation work on 2026-10-04 intentionally did not run builds, tests, CI, or phone checks, following the user code-first instruction. The integration branch provides InteractionCodecs and app composition separately.
