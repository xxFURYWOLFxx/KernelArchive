# Deploying KernelArchive

Two things move to the server, and they move differently.

**Code** is ~15 MB and changes often. Zip it, copy it, install, restart.
**Data** is ~23 GB and changes only when you re-index. Copy it once.

Read [SECURITY.md](../SECURITY.md) before putting this on a public address.

## What the server needs

| Item | Size | Why |
| --- | --- | --- |
| `local-cache/archive.sqlite` | ~13.8 GB | Every page reads from it |
| `local-cache/binaries/` | ~2.4 GB | Backs file downloads |
| `Archive/` | ~6.8 GB | Original files, and lets the server re-index |
| `local-cache/auth.sqlite` | tiny | **Do not copy.** Create the admin on the server |

Never copy `auth.sqlite`. It holds the admin password hash and live session tokens.
Provisioning on the server keeps both off the wire.

### Why paths matter here

The database records absolute paths from the machine that did the indexing, like
`D:\build-machine\KernelArchive\local-cache\binaries\<sha256>\acpi.sys`. Those do not exist
on the server, so download resolution falls through to two path-independent
lookups: the binary cache rebuilt from `binaries/<sha256>/<name>`, and
`Archive/<relative path>`. Both work anywhere as long as the directories keep their
relative layout under the app root. Put `local-cache` and `Archive` beside each
other exactly as they are here.

## 1. Build the package

```powershell
node scripts/release.mjs --zip
```

Produces `dist/kernelarchive-<stamp>.zip` (~15 MB) containing a pnpm workspace with
the frontend already built.

`node_modules` is deliberately **not** in the zip. pnpm links packages through its
content store, so a copied `node_modules` either points back at the build machine or,
if the links are resolved, flattens into a tree where peer resolution breaks. The
server installs from the lockfile instead, which reproduces the graph exactly and
takes about five seconds.

## 2. Package the data

Stop the API first so the write-ahead log can be folded in, then:

```powershell
node scripts/package-data.mjs
```

This checkpoints the database, verifies it, and writes split archives to
`dist/data/`. Defaults to 1 GB volumes; `--volume 2g` makes them bigger and
`--single` produces one file.

Splitting is the point. A single multi-gigabyte upload that dies at 90% starts over,
while a failed volume is re-sent on its own.

The data compresses well, so the upload is far smaller than the raw size. The
database is mostly repeated JSON and packs about 8.9x; the PE binaries about 2.1x.

`auth.sqlite` is excluded on purpose, along with the `-wal` and `-shm` files that the
checkpoint just made redundant.

## 3. Upload and extract

Copy the release zip and everything in `dist/data/` to the server. From the app root,
for example `C:\kernelarchive`:

```powershell
# extract only the FIRST volume of each set, the rest are pulled in automatically
"C:\Program Files\WinRAR\WinRAR.exe" x kernelarchive-db.part01.rar
"C:\Program Files\WinRAR\WinRAR.exe" x kernelarchive-binaries.part01.rar
"C:\Program Files\WinRAR\WinRAR.exe" x kernelarchive-archive.part01.rar
```

Paths are stored relative, so this recreates `local-cache\` and `Archive\` exactly
where the API expects them.

If you would rather copy the files directly over a LAN or mapped drive, skip the
packaging and use `robocopy` instead, which resumes on interruption:

```powershell
robocopy local-cache C:\kernelarchive\local-cache archive.sqlite /Z
robocopy local-cache\binaries C:\kernelarchive\local-cache\binaries /E /Z /MT:16
robocopy Archive C:\kernelarchive\Archive /E /Z /MT:16
```

Run `node scripts/prepare-data.mjs` first in that case; it does the same checkpoint
without packaging anything.

## 4. Install and configure

```powershell
cd C:\kernelarchive
pnpm install --prod --frozen-lockfile
copy .env.example .env
```

Edit `.env`:

```ini
PORT=4002
HOST=127.0.0.1

KERNELARCHIVE_API_INTERNAL_URL=http://127.0.0.1:4002

KERNELARCHIVE_LOCAL_CACHE_DIR=C:\kernelarchive\local-cache
KERNELARCHIVE_DATA_DB_PATH=C:\kernelarchive\local-cache\archive.sqlite
KERNELARCHIVE_AUTH_DB_PATH=C:\kernelarchive\local-cache\auth.sqlite
KERNELARCHIVE_ARCHIVE_DIR=C:\kernelarchive\Archive

KERNELARCHIVE_ARCHIVE_IMPORT_ENABLED=false

TRUST_PROXY=127.0.0.1
```

`KERNELARCHIVE_ARCHIVE_IMPORT_ENABLED=false` is not optional on a mirror, it is the
single most important line here. The importer judges a file unchanged from its size,
mtime and ctime. Copying or extracting `Archive/` gives every file new timestamps, so
all 20,083 look new and the whole archive is re-indexed. The symbol cache is not part
of the shipped data, so that re-index has no PDBs to read and rewrites your types and
functions from PE exports alone. The symptom is ugly and slow: the server starts
fine, then the counts drain away over the following minutes.

Leave it `true` only on the machine that actually builds the archive.

There is deliberately no domain in there. The API accepts a request whose `Origin`
matches the `Host` it was addressed to, which is the definition of same-origin, so it
works on whatever domain your proxy serves without being told. A page on another
origin still carries its own `Origin` and is still rejected, so CSRF protection is
unchanged.

Set `PUBLIC_APP_URL=https://your-domain` only if you want the session cookie marked
`Secure`, which is worth doing once you are on HTTPS.

`TRUST_PROXY` decides who may set `X-Forwarded-For`, and the rate limiter keys on
that header. It must name your reverse proxy and nothing else, and the proxy must
**overwrite** the header rather than forward whatever the client sent. Otherwise
anyone can rotate the value and reset their own limit.

If the server should not re-index, point `KERNELARCHIVE_ARCHIVE_DIR` at an empty
directory. Downloads still work from the binary cache.

## 5. Create the administrator

```powershell
pnpm --filter @kernelarchive/api create-admin your@email '<password>'
```

Run this on the server. Do not put the password in a script or a deploy log.

## 6. Run both apps

```powershell
# backend, port 4002
pnpm --filter @kernelarchive/api start

# frontend, port 3000
$env:PORT=3000; pnpm --filter @kernelarchive/web start
```

Both are long-lived processes. Put them under a service manager so they survive a
reboot; [NSSM](https://nssm.cc/) or `New-Service` both work on Windows.

Point your proxy at **port 3000 only**. The frontend forwards `/api/v1/*` to the
backend itself, so the API does not need its own public route, and leaving it on
`127.0.0.1` keeps it off the internet.

If you would rather expose the API directly as well, set `TRUSTED_ORIGINS` to the
frontend origin so CORS accepts it.

## Updating

Code only, the usual case:

```powershell
node scripts/release.mjs --zip     # locally
# copy, extract over the old directory, then:
pnpm install --prod --frozen-lockfile
# restart both processes
```

After re-indexing, the data too:

```powershell
node scripts/prepare-data.mjs
robocopy local-cache C:\kernelarchive\local-cache archive.sqlite /Z
robocopy local-cache\binaries C:\kernelarchive\local-cache\binaries /E /Z /MT:16
robocopy Archive C:\kernelarchive\Archive /E /Z /MT:16
```

Restart the API afterwards. It opens the database at boot and its read replicas hold
their own handles, so a replaced file is not picked up until then.

## Disk and memory

Budget ~25 GB of disk: 23 GB of data, a few hundred MB of code and modules, and room
for the write-ahead log to grow between checkpoints.

The API starts four read replicas, each with its own SQLite page cache, plus the main
process. 4 GB of RAM is comfortable; 2 GB works if the server only serves reads.
