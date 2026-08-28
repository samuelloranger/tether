// Why every child spawn in this server passes `windowsHide`.
//
// The daemon is started detached (main.ts), which on Windows means
// DETACHED_PROCESS: it owns no console. That is what we want for a background
// service — but it has a consequence for everything it spawns. When a process
// with no console starts a *console* application, Windows does not run it
// headless; it allocates a brand new console for it, and that console is
// visible. So each `git` the git features shell out to opens a console window,
// holds it for as long as git runs, and closes it on exit.
//
// One of those is a flicker. The problem is the rate: readRepoStatus alone runs
// four git commands, gitWatch re-reads the diff and status on every debounced
// filesystem event, and an actively-edited repository produces those
// continuously — so the user gets a stream of terminals opening and closing on
// their desktop for as long as tether is watching a repo they are working in.
//
// CREATE_NO_WINDOW is the flag that says "console application, but no window",
// and `windowsHide: true` is how both node:child_process and Bun.spawn set it.
// Note it does NOT stop a console being allocated — a conhost.exe still appears
// per child, which is why counting conhost processes is a misleading way to
// check this; it stops the console having a *window*.
//
// Spread into the options of every spawn rather than set per call site, so the
// reasoning lives in one place and a new spawn is a one-token change. Harmless
// on POSIX, where the field is simply ignored — hence no platform branch, which
// also keeps the option object's shape identical across platforms.
export const HIDE_CONSOLE = { windowsHide: true } as const;
