// One-shot version bump: the release version lives in one place only by
// accident, so this script rewrites every copy and leaves Cargo.lock to cargo.
//
//   node scripts/bump-version.mjs 0.1.8

import { readFileSync, writeFileSync } from "node:fs";

const next = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(next ?? "")) {
  console.error("usage: node scripts/bump-version.mjs <x.y.z>");
  process.exit(1);
}

// [file, regexp matching the current version, replacement with $-groups]
// Cargo.toml patterns intentionally stop before the closing quote: `$` would
// have to match across CRLF line endings, and the first match from the top of
// each manifest is the [package] version, never a dependency's.
const targets = [
  ["package.json", /("version": ")[\d.\w-]+(")/, `$1${next}$2`],
  // The lockfile has ~170 dependency "version" fields; only the two root
  // entries directly follow a "name": "mediatool" line.
  [
    "package-lock.json",
    /("name": "mediatool",\s*\r?\n\s*"version": ")[^"]+(")/g,
    `$1${next}$2`,
  ],
  ["crates/mediatool-core/Cargo.toml", /^version = "[\d.\w-]+/m, `version = "${next}`],
  ["crates/mediatool-server/Cargo.toml", /^version = "[\d.\w-]+/m, `version = "${next}`],
  ["src-tauri/Cargo.toml", /^version = "[\d.\w-]+/m, `version = "${next}`],
  ["src-tauri/tauri.conf.json", /("version": ")[\d.\w-]+(")/, `$1${next}$2`],
  [
    "docker/docker-compose.yml",
    /(image: \S*mediatool:)[\d.\w-]+/,
    `$1${next}`,
  ],
  [
    "docker/docker-compose.build.yml",
    /(image: \S*mediatool:)[\d.\w-]+/,
    `$1${next}`,
  ],
];

for (const [file, pattern, replacement] of targets) {
  const before = readFileSync(file, "utf8");
  const after = before.replace(pattern, replacement);
  if (before === after) {
    console.error(`${file}: no version field matched — check the pattern`);
    process.exit(1);
  }
  writeFileSync(file, after);
  console.log(`  ${file} -> ${next}`);
}
console.log("now run: cargo update --workspace (refreshes Cargo.lock)");
