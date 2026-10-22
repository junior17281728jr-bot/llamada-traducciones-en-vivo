/**
 * Join point owned by the app team (src/app/**, src/settings/**, src/history/**, src/theme/**).
 * `AppShell` is mounted by App.tsx inside the session and call providers: it owns login,
 * dialer, history, settings and routing, and renders `CallScreen` (from ../call) during a call.
 */
export { AppShell } from './AppShell';
