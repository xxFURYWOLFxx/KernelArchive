# KernelArchive

A searchable index of Windows kernel symbols, type layouts and byte patterns,
derived by analysing Microsoft's public debug symbols and the corresponding system
binaries on your own machine, and pinned to an exact Windows build.

It does not host or redistribute Windows binaries or PDB files. It records facts
about them: names, offsets, sizes and addresses.

**Live at [kernelarchive.com](https://kernelarchive.com)**. Free, no account needed.

---

## Why this exists

Ask anyone, or anything, for the offset of a field in `_EPROCESS` and you will
usually get an answer. It will look right. It may even have been right, for some
build, once.

That is the problem. Kernel structures change between Windows builds, sometimes
between patch levels of the same build. An offset without a build number attached is
a guess. In kernel-mode code a wrong guess does not throw an exception, it bugchecks
the machine.

KernelArchive is the thing you check against. Every type layout, function RVA and
byte pattern here came out of a real binary and a real PDB, and every one of them is
attributed to a specific build. You can look up the layout for `26100.8875 x64` and
be correct, or find out the field does not exist in that build at all.

This is also why the API exists. Language models trained on scraped code carry a
blurred, averaged picture of the kernel: they mix kernel-mode and user-mode APIs,
invent plausible structure fields, and quote offsets from nowhere in particular.
Pointed at this archive instead, a model can look the answer up rather than recall it.

## What is in it

At the time of writing:

| | |
| --- | --- |
| Windows builds | 25 |
| Modules | 15,036 |
| Functions | 6,965,259 |
| Type definitions | 1,492,247 |

Windows 10 1709 through Windows 11 25H2, x86 and x64.

## How it works

Four steps, and nothing clever in any of them.

**1. Collect.** Point it at a folder of Windows system binaries. It walks the tree
and finds every Portable Executable. Gathering those binaries in the first place is
its own job, so [`tools/collector`](tools/collector) does it: fetch each Windows
release, verify it against Microsoft's published hashes, mount it read-only, and copy
the kernel components out.

**2. Identify.** Each binary's version resource gives the product, version, build
number and architecture, so `ntoskrnl.exe` from 22H2 never gets confused with the one
from 24H2. Files are keyed by SHA-256, so the same binary shipping in several builds
is stored once and shared.

**3. Extract.** The PE headers give sections, imports, exports and entry points. The
debug directory gives the PDB identity, which is looked up against Microsoft's public
symbol server. When a PDB comes back, a small DIA-based extractor pulls out the type
records, field offsets and function symbols. When it does not, the module still gets
indexed from its exports alone.

**4. Serve.** Everything lands in a single SQLite database, which the API reads and
the web app browses. Nothing is recomputed per request.

Byte patterns are generated on demand rather than up front. Asking for a pattern
disassembles the function, wildcards the operands that move between builds
(relative calls, jumps, RIP-relative displacements) and keeps the opcodes that do
not, then verifies the result is unique in the image before caching it.

## Using it

Browse [kernelarchive.com](https://kernelarchive.com), or query the API:

```bash
curl "https://kernelarchive.com/api/v1/search?q=PsLookupProcessByProcessId&limit=1"
```

Full documentation, worked examples and rate limits are at
[kernelarchive.com/api-docs](https://kernelarchive.com/api-docs). Machine-readable
entry points for agents: `/api/v1/openapi.json`, `/api/v1/ai/manifest`, `/llms.txt`.

Anonymous clients get 300 requests per minute.

## Stack

Deliberately small. No database server, no queue, no search cluster.

| Layer | What it is |
| --- | --- |
| Web | Next.js 15 (App Router), TypeScript, Tailwind |
| API | Fastify, TypeScript, Zod, OpenAPI |
| Storage | SQLite through Node's built-in `node:sqlite`, WAL mode |
| Symbols | `tools/pdb-dump`, a small C++ DIA SDK extractor |
| Monorepo | pnpm workspaces + Turborepo |

Reads run on a pool of read-only SQLite replicas in worker threads, because the
archive is a ~14 GB file and a cold page read costs seconds of disk I/O. Without
that, one uncached query stalls every other request on the process.

## Running your own

Requires Node 22 or newer (`node:sqlite`) and pnpm.

```bash
pnpm install
cp .env.example .env
pnpm dev
```

Web on `http://localhost:3000`, API on `http://localhost:4002`. Point
`KERNELARCHIVE_ARCHIVE_DIR` at a folder of Windows binaries and the importer indexes
them in the background; progress is at `/progress`.

Indexing needs Windows and the DIA SDK that ships with Visual Studio. Browsing an
archive someone else built does not.

For deploying to a server, including how to move the database without corrupting it,
see [docs/DEPLOY.md](docs/DEPLOY.md). Read [SECURITY.md](SECURITY.md) before putting
it on a public address.

## Known limitations

Honest list. These are the things I would fix next, and any of them is a good place
to start if you want to contribute.

**Pattern generation produces one pattern per build.** Today a pattern is derived
from a single binary and verified against that image. Ask for the same function
across twenty builds and you get twenty patterns, most of which differ only in bytes
that were never stable to begin with. The better approach is to align the function
across builds first, diff the instruction streams, and wildcard everything that moves
so that one pattern covers the whole range. The cross-reference view already fetches
every build's copy of a function, so the data needed to do this is right there.

**Global variables are not indexed.** Only functions and types are extracted. If you
are hunting a global (`PsInitialSystemProcess`, `KdDebuggerDataBlock`, and friends)
you will not find it here yet. The PDB carries the symbols, and the extractor already
walks the symbol table, so this is more a matter of deciding how to model and address
them than of missing information. Genuinely open, and I would welcome the help.

## Accuracy

Type layouts and patterns are produced by automated analysis and can be incomplete or
wrong. Verify against the binary before shipping kernel-mode code. Nothing here is
suitable for anything safety-critical.

## Contributing

Issues and pull requests are welcome, particularly on the two limitations above.
Report security problems privately, see [SECURITY.md](SECURITY.md).

---

## Open source and self-hosted

KernelArchive is open source and self-hosted. There is no company behind it, no
tracking, no accounts, no paid tier. The public instance runs on a server I pay for,
and it stays free for everyone who finds it useful.

If it saved you time and you want to help keep it online, donations are welcome:

**BTC:** `1Fm1f25ZwKLEPb1yseCfPGMBjovfHvTP98`

Entirely optional. The archive stays up either way.

## Licence

Two separate things live here, and only one of them is mine to license.

**The source code in this repository.** No licence has been chosen yet. Until a
licence file lands here, the code is published for reference and no rights are
granted. That will change; the intent is to license it properly.

**The archive data it generates.** Not covered by any licence granted here, whatever
the code ends up under. It contains information derived from Microsoft Windows
binaries and Microsoft public symbol files, and Microsoft retains all applicable
rights in those materials.

This project does not redistribute Windows binaries or PDB files. The collector
downloads them from Microsoft to your machine, and the indexer reads them there. What
gets stored is derived information: symbol names, field offsets, structure sizes and
addresses. If you build an archive and then share it, that is your decision to make
and your responsibility to check.

Windows and Microsoft are trademarks of Microsoft Corporation. This project is not
affiliated with, sponsored by, or endorsed by Microsoft.

None of the above is legal advice.
