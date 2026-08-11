// Builds a deployable release of KernelArchive.
//
// The output is a pnpm workspace with the frontend already built. The server runs
// one `pnpm install --prod` and then starts both apps. That is deliberately not a
// bundled node_modules: pnpm links packages through its content store, so copying
// node_modules produces either symlinks pointing at the build machine or, if they
// are dereferenced, a flattened tree where peer resolution breaks. Installing from
// the lockfile on the target is the only reliable way to reproduce the graph.
//
// Data lives outside this package. See prepare-data.mjs.
//
//   node scripts/release.mjs              build and stage into dist/release
//   node scripts/release.mjs --zip        also produce dist/kernelarchive-<stamp>.zip
//   node scripts/release.mjs --tar        produce a .tar.gz instead
//   node scripts/release.mjs --skip-build stage whatever is already built
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const repo_root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out_root = join(repo_root, "dist", "release");
const flags = new Set(process.argv.slice(2));

function run(command, args, cwd = repo_root) {
  execFileSync(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
}

function directory_size(path) {
  let total = 0;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const next = join(current, entry.name);
      if (entry.isDirectory()) { walk(next); continue; }
      try { total += statSync(next).size; } catch { /* vanished mid-walk */ }
    }
  };
  if (existsSync(path)) { walk(path); }
  return total;
}

function human(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

// node_modules is never copied: the target installs it. .next/cache is build scratch
// worth hundreds of MB that the server has no use for.
function skip(source) {
  const normalized = source.replace(/\\/g, "/");
  return !/\/node_modules(\/|$)/.test(normalized) && !/\/\.next\/cache(\/|$)/.test(normalized);
}

function copy(from, to = from) {
  const source = join(repo_root, from);
  if (!existsSync(source)) { throw new Error(`missing build input: ${from}`); }
  const target = join(out_root, to);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true, filter: skip });
}

if (!flags.has("--skip-build")) {
  // next build does not clear what next dev leaves behind, and everything under
  // .next gets copied, so a release built after a dev session carries dev-only
  // chunks. Start from nothing so the package holds a pure production build.
  console.log("> clearing previous build output");
  rmSync(join(repo_root, "apps/web/.next"), { force: true, recursive: true });
  console.log("> building");
  run("pnpm", ["turbo", "build"]);
}

if (!existsSync(join(repo_root, "apps/web/.next/BUILD_ID"))) {
  throw new Error("apps/web/.next is not a completed production build. Run without --skip-build.");
}

console.log("> staging");
rmSync(out_root, { force: true, recursive: true });
mkdirSync(out_root, { recursive: true });

// Workspace manifests, so the target can install the exact locked versions.
copy("package.json");
copy("pnpm-lock.yaml");
copy("pnpm-workspace.yaml");
copy("tsconfig.base.json");
copy(".env.example");

// API runs its TypeScript through tsx, so it ships as source.
copy("apps/api/src");
copy("apps/api/package.json");
copy("apps/api/tsconfig.json");

// Web ships already built. next start serves .next and public.
copy("apps/web/.next");
copy("apps/web/public");
copy("apps/web/package.json");
copy("apps/web/next.config.mjs");

// Workspace packages both apps import.
copy("packages/shared");
copy("packages/ui");
copy("packages/config");

// doctor.mjs reports what the API will actually see. It is the first thing worth
// running when a deployment looks healthy but serves nothing, so it ships too.
copy("scripts/doctor.mjs");

// A backfill run on the server leaves gigabytes in the WAL, and folding it back into
// the database is this script's job.
copy("scripts/prepare-data.mjs");

// The PDB extractor is only needed to index new binaries, not to serve the archive.
if (existsSync(join(repo_root, "tools/pdb-dump/pdb_dump.exe"))) {
  copy("tools/pdb-dump/pdb_dump.exe");
}

copy("docs/DEPLOY.md", "DEPLOY.md");

const package_version = JSON.parse(readFileSync(join(repo_root, "package.json"), "utf8")).version ?? "0.0.0";
writeFileSync(join(out_root, "release.json"), `${JSON.stringify({
  name: "kernelarchive",
  version: package_version,
  built_with_node: process.version,
  bytes: directory_size(out_root),
}, null, 2)}\n`);

console.log(`  ${human(directory_size(out_root))}`);
console.log(`  -> ${relative(repo_root, out_root)}`);

if (flags.has("--zip") || flags.has("--tar")) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  console.log("> compressing");
  // tar reads an absolute Windows path as a remote host:path spec, so it runs from
  // the staging directory and writes one level up under a relative name.
  const name = flags.has("--tar") ? `kernelarchive-${stamp}.tar.gz` : `kernelarchive-${stamp}.zip`;
  run("tar", flags.has("--tar") ? ["-czf", `../${name}`, "."] : ["-a", "-cf", `../${name}`, "."], out_root);
  const archive = join(repo_root, "dist", name);
  console.log(`  -> ${relative(repo_root, archive)} (${human(statSync(archive).size)})`);
}
