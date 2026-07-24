// @xterm/headless 6.0.0 platform-detection reads navigator.userAgent.includes()
// / navigator.platform at import time. Under Hermes those are undefined -> crash.
// Provide string stubs BEFORE xterm is imported. Must be the FIRST import in index.ts.
const nav = (globalThis as any).navigator ?? ((globalThis as any).navigator = {});
if (typeof nav.userAgent !== 'string') nav.userAgent = 'ReactNative';
if (typeof nav.platform !== 'string') nav.platform = 'ReactNative';

export {};
