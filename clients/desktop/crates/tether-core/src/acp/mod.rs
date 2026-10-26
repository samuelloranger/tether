//! The ACP chat client's rules (port of the iOS client's pure logic): the wire decoder, the
//! transcript reducer, the journal, a sans-IO client, and the host commands the chat speaks.

pub mod auth;
pub mod client;
pub mod diff;
pub mod files;
pub mod format;
pub mod grouping;
pub mod host;
pub mod images;
pub mod journal;
pub mod lines;
pub mod mention;
pub mod message;
pub mod question;
pub mod reducer;
pub mod slash;
pub mod tooldetail;

#[cfg(test)]
pub(crate) mod fixture;
