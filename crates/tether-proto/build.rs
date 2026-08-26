//! Compile `schema/wire.proto` with a vendored `protoc` so neither developers
//! nor CI need a system protobuf install. Matches the TypeScript side's
//! "committed gen, no buf/protoc in CI" property via a different mechanism:
//! the binary travels inside the `protoc-bin-vendored` crate.

use std::env;
use std::path::PathBuf;

fn main() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let schema_dir = manifest.join("schema");
    let proto = schema_dir.join("wire.proto");
    println!("cargo:rerun-if-changed={}", proto.display());

    // Pass the file name relative to -I (schema_dir). Absolute paths for both
    // the .proto and the include root confuse protoc's prefix check.
    let mut config = prost_build::Config::new();
    config
        .protoc_executable(protoc_bin_vendored::protoc_bin_path().unwrap())
        .compile_protos(&["wire.proto"], &[schema_dir])
        .expect("failed to compile wire.proto");
}
