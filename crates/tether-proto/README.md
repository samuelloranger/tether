# tether-proto

**Legacy.** This crate holds the wire protocol (`schema/wire.proto`, `frame.rs`)
for the removed Bun server's WebSocket gateway. v5 is a native iOS SSH client
with no server and no custom wire protocol; nothing on the shipping path uses
it. It is retained only as a `tether-core` build dependency and is slated for
removal in the `crates/` cleanup (the dead server/transport modules go with it).

Do not build new work on this schema.
