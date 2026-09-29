# Windows system file collector

Builds the `Archive/` folder that KernelArchive indexes. It fetches Windows releases
and pulls the kernel components out of each one, so you end up with a tree of real
system binaries per build instead of collecting them by hand from installed machines.

## What it does

For each release in `releases.json`:

1. Looks the build up through the UUP dump JSON API to get the file catalog and
   signed download links.
2. Downloads the payloads, accepting them only from Microsoft hosts and checking each
   one against the SHA-1 the catalog published.
3. Converts the payloads into an install image using the hash-pinned UUP dump
   converter.
4. Mounts that image read-only with DISM and copies out the drivers, the kernel
   components, and the boot loaders under `Windows\Boot`.
5. Unmounts, cleans up, and moves to the next release.

The result lands in the output folder as one directory per build, which is exactly
the layout `KERNELARCHIVE_ARCHIVE_DIR` expects.

## Requirements

Windows, run as administrator, because DISM has to mount images. Python 3 and:

```bash
pip install -r requirements.txt
```

Budget plenty of disk. Each release needs tens of gigabytes of working space while it
converts and mounts, even though the extracted output is far smaller.

## Usage

```bash
python windows_sys_collector.py --output ..\..\Archive
```

`run_as_admin.bat` does the same thing with the elevation prompt handled for you.

Useful options:

| Option | Purpose |
| --- | --- |
| `--release` | Collect specific builds instead of all of them |
| `--start-from` | Resume part-way through the list after an interruption |
| `--architecture` | Pick amd64 or x86 |
| `--drivers-only` | Skip everything except drivers |
| `--include-driverstore` | Also pull from the driver store |
| `--work-dir` | Where to do the conversion and mounting |
| `--keep-images` | Keep the converted images rather than deleting them |
| `--retry-failed` | Retry only the releases that failed last run |
| `--cleanup` | Remove leftover mounts and working files |

`releases.json` is the catalog it works from: one entry per Windows release with its
build number, edition, language and a rough disk estimate. Edit it to add or remove
builds.

## What it collects

Drivers from `System32\drivers` and `SysWOW64\drivers`, the kernel components in
`System32` (ntoskrnl, the secure kernel, hal, the loaders and the KD transports),
and every Portable Executable under `Windows\Boot`: `bootmgfw.efi`, `bootmgr.efi`,
`memtest.efi`, the `_EX` variants and the boot-time debugger transports.

The boot loaders publish no export table, so their public PDBs are the only way to
get anything out of them. Those PDBs are published, but stripped of type records,
so a loader contributes function names and addresses rather than structure layouts.

Localised subdirectories under `Windows\Boot` are skipped. Each one holds a `.mui`
resource copy of every loader, which would multiply the same binaries by the number
of shipped languages without adding a symbol. `Windows\Boot\PCATootmgr` is also
left alone: it is a boot sector with a compressed payload, not a PE.

## Notes

Nothing here is redistributed. The script downloads from Microsoft, verifies what it
receives, and extracts locally on your machine. The archive it produces is yours, and
whether you can share it onward is governed by Microsoft's terms, not this tool.

A full run takes hours and a lot of bandwidth. It is designed to be interrupted and
resumed rather than completed in one sitting.
