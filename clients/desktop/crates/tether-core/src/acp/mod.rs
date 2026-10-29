//! The ACP chat client's rules (port of the iOS client's pure logic): the wire decoder, the
//! transcript reducer, the journal, a sans-IO client, and the host commands the chat speaks.

pub mod agent;
pub mod auth;
pub mod client;
pub mod defaults;
pub mod diff;
pub mod echo;
pub mod files;
pub mod format;
pub mod grouping;
pub mod host;
pub mod images;
pub mod journal;
pub mod lines;
pub mod mention;
pub mod message;
pub mod options;
pub mod question;
pub mod reducer;
pub mod slash;
pub mod tooldetail;
pub mod verbs;
pub mod workflows;

#[cfg(test)]
pub(crate) mod fixture;

#[cfg(test)]
mod capabilities;
