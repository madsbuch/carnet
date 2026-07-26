# Carnet audit — 10,000 notes, phone, and never losing data

> **Status: all findings below are fixed.** This document is kept as the record of
> what was wrong and how it was measured. Jump to [After](#after) for the numbers
> as they stand now. Anything still outstanding is listed there too.

Against three requirements: the app must work with 10,000+ notes, be snappy on a
phone, and never lose data.

Every number below is measured, not estimated, on a generated 10,002-note /
16.3 MB vault (`bench/gen-vault.ts`) — except where marked *(estimated)*.
Desktop numbers are one x86 core; the phone column multiplies by 5, which is a
fair ratio for string-heavy JS in an Android WebView. Reproduce with:

```sh
bun run bench/gen-vault.ts /tmp/vault10k 10000
bun run bench/hot-paths.ts /tmp/vault10k
```

---

## Verdict

**Data loss: the app can lose data today, and the most likely way is the one you
would hit every evening.** While you are typing inside a block editor, nothing
is ever saved. `host.update()` is called from commit, Enter, delete and checkbox
paths, but the textarea's own `input` listener
(`src/client/blockview.ts:424-427`) only resizes the box and updates the counter.
It never marks the note dirty and never schedules a save. Type 600 words into one
paragraph on your phone and the file on disk still holds the old text; the only
copy is a DOM textarea. Anything that ends the process without a blur — an OOM
kill, a crash, force-stop, battery death — takes all of it. Source mode
(`src/client/app.ts:889-897`) does autosave on every keystroke; block mode, the
mode you actually write in on a phone, does not. Below that sit eight more
paths, listed in order of how likely you are to meet them.

**10,000 notes: the app does not work at that size.** `buildGraph` takes
**79.6 seconds** on a fast desktop core — call it six and a half minutes on a
phone — and it runs synchronously on the UI thread, so the whole app is frozen
for the duration. It runs on cold start and again on every note you open after
any save, because `doSave()` calls `invalidate()` (`src/client/app.ts:182`) and
the next `renderBacklinks()` rebuilds the graph from scratch. The cause is
`resolveLink()` (`src/links.ts:147`) scanning all 10,000 paths for each of 50,000
links. It is a clean O(n²) — 500 notes 192 ms, 1,000 → 771 ms, 2,000 → 3.0 s,
4,000 → 12.4 s, 10,000 → 79.6 s. A prototype that indexes paths by basename
first produces **byte-identical output in 228 ms — 349× faster**.

**Phone: no, for the same reasons plus its own.** Every note you open rebuilds
the entire 10,002-element sidebar DOM (144 ms measured in Chromium, ~700 ms on a
phone) whether or not the sidebar is visible — and on a phone it never is, since
the hamburger opens the quick-open view instead. Pressing `g` starts a
force-directed simulation of 10,002 nodes and 49,992 edges that runs at
**0.5 fps on a phone** and issues ~60,000 un-batched canvas draw calls per frame,
with no cap and no way out but killing the app. A 4,000-item checklist takes
**10 seconds on a phone** to open, or to tick one box. And the memory those
caches and DOM nodes hold is what makes the OOM kill in the data-loss paragraph
likely rather than theoretical — the scale problem is what *causes* the data
loss.

---

## Critical — data can be lost

Ordered by how likely you are to hit it in ordinary use.

**1. Typing in a block never schedules a save** — `src/client/blockview.ts:424`
The textarea `input` handler calls `sizeTextarea` and `syncCounter` only. Of the
four call sites of `host.update()` (lines 256, 503, 538/547, 581) none is
reached by typing. Until you blur, press Enter, tap another block, hit ⌘S or
background the app, the note on disk is unchanged and `dirty` is `false`.
*Fix:* call `host.update(this.pendingContent())` from the input handler, debounced
~300 ms — `pendingContent()` already computes exactly the right text.

**2. A failed Dropbox push is dropped forever** — `src/client/app.ts:220`
`pushToDropbox` catches upload errors into a 3-second toast. `dirty` was already
cleared by `doSave`, the rev is unchanged, and nothing ever retries. Edit a note
on the underground and that edit never reaches Dropbox; when another device next
touches the file, the pull loop force-writes the mirror
(`src/client/dropboxmode.ts:67`) over your only copy.
*Fix:* a persisted outbox of unpushed paths, drained on reconnect and at startup.

**3. A note created against an incomplete mirror overwrites the real one** —
`src/client/app.ts:275`, `src/client/dropbox.ts:285`
`dropboxmode.start()` swallows `initialSync` failures and starts the app anyway
(`src/client/dropboxmode.ts:238-242`), and a 10,000-note initial sync is minutes
long (6 concurrent downloads, one HTTP request each). Open a note that exists on
Dropbox but hasn't landed yet: `readNote` returns null, so `loadNote` **creates
it empty**. Type one word, and the push runs with `baseRev` undefined — which
`upload()` turns into `mode: overwrite`, not a conditional update. The real note
is gone with no conflict prompt. Launching during initial sync does this to
today's daily note automatically.
*Fix:* block note creation until the mirror is known-complete, and never upload
with `overwrite` for a path the server may already have.

**4. A missing rev silently becomes an unconditional overwrite** —
`src/client/dropboxsync.ts:283`
`this.client.upload(rel, content, baseRev || undefined)` → `overwrite` mode
whenever the rev map lost that key. The rev map is a single JSON blob written
behind a 500 ms debounce whose errors are swallowed
(`src/client/dropboxsync.ts:100-111`), so an app kill during a sync loses recent
revs. Same silent-overwrite outcome as #3.

**5. ⌘Q loses unsaved edits on macOS** — `src/client/app.ts:967`
`onCloseRequested` is correct — Tauri v2 does `await handler(evt)` before
destroying the window, so the red button is safe. But `tauri.conf.json` defines
no custom menu, so ⌘Q goes through the default predefined quit item, which
terminates the app without emitting `close-requested`. The 800 ms save debounce
and any open block editor go with it.
*Fix:* handle `RunEvent::ExitRequested` in Rust, or bind ⌘Q to a flush-then-exit.

**6. `write_note` never fsyncs** — `src-tauri/src/lib.rs:173`
`fs::write(&tmp, …)` then `fs::rename` with no `sync_all()` on the temp file and
none on the parent directory. The rename can be durable while the data is not.
ext4's `auto_da_alloc` covers the common overwrite case but not the
create-then-first-save case, and f2fs — what Android actually uses for `/data` —
has no equivalent heuristic. Power loss or an OS kill can leave a 0-byte note
where a real one was, *after* `write_note` returned `Ok` and the dirty dot
cleared. **Measured cost of fixing it: +3 ms per save, against an 800 ms
debounce.** There is no reason not to.

**7. Two writers share one temp path** — `src-tauri/src/lib.rs:172`
The temp name is derived only from the note name, so it is the same for every
writer. User saves go through `saveQueue` (`src/client/app.ts:136`), but the
Dropbox pull loop's mirror writes do not — they call `backend.writeNote`
directly. A pull and a save landing on the same note can interleave
`O_TRUNC`+`write_all`+`rename` and publish a spliced file, or fail with ENOENT.
*Fix:* include a unique suffix in the temp name (measured in the same 3 ms above).

**8. Invalid UTF-8 is destroyed on round trip** — `src-tauri/src/lib.rs:48`
`read_text` uses `from_utf8_lossy`. Verified at the byte level: input
`23 20 54 ff fe 0a` reads back as `23 20 54 ef bf bd ef bf bd 0a` — the original
bytes are replaced by U+FFFD and cannot be recovered. Save such a file once and
the damage is permanent. The hash guard cannot catch it, because line 150
compares a lossily-decoded disk read against an equally lossy client hash.
*Fix:* refuse to write a file whose on-disk bytes aren't valid UTF-8.

**9. `write_state` truncates before writing** — `src-tauri/src/lib.rs:255`
Plain `fs::write` on the blob holding your vault path, Dropbox tokens and the
whole rev map — rewritten every 500 ms during a sync. Interrupt it and what
survives is an unparseable JSON prefix, which `CachedStore.load()` discards
silently, taking every rev with it and feeding straight into #4.
*Fix:* the same temp+fsync+rename used for notes.

**10. `loadNote` can drop an edit begun during its awaits** — `src/client/app.ts:290`
`blockView.flush()` runs before `await save()` and `await readNote(path)`, but
the old note's DOM is still on screen and tappable throughout — seconds, on a
phone. A block edit started in that window is pointed at the old note's line
numbers, and `note = n` at line 290 followed by `renderAll()` clears `active`
without committing.

Two lower-probability ones, for completeness: `djb2` is 32-bit
(`src-tauri/src/lib.rs:53`), so the authoritative conflict check has a ~1-in-4-billion
chance per save of reporting "unchanged" for a changed file — about **0.085
expected silent overwrites over five years** at 10,000 notes × 20 saves/day.
And editing any block of a CRLF file rewrites that block with bare `\n` while the
rest keeps `\r\n` (verified), leaving mixed endings and a diff on every note you
touch.

---

## Critical — breaks at 10,000 notes

**1. `buildGraph` is quadratic and blocks the UI thread** — `src/links.ts:147`

| notes | buildGraph |
|------:|-----------:|
|   500 |     192 ms |
| 1,000 |     771 ms |
| 2,000 |     3.0 s |
| 4,000 |    12.4 s |
|10,002 |  **79.6 s** |

`resolveLink` filters all 10,000 paths per link (1.6 ms per call, linear in vault
size) × 49,992 links. It runs on cold start and after every save→navigate, via
`doSave` → `invalidate()` (`app.ts:182`) → `renderBacklinks` → `getGraph`
(`app.ts:102`). A prototype indexing paths by lowercased basename gives
**identical nodes and edges in 228 ms (349×)**; it is about 25 lines.

**2. The whole vault is re-read and re-parsed constantly** — `src-tauri/src/lib.rs:118`
`read_all_notes` ships every note's full text in one IPC call: 17.2 MB of JSON,
74 ms to read + 21 ms to serialize + 58 ms to parse on desktop *(Android's
shared-storage layer will be materially worse — 10,000 small-file opens through
the FUSE shim, estimated)*. It is thrown away by `invalidate()` on **every
save**. Worse, `getAllNotes` caches the resolved value, not the promise
(`app.ts:99`) — verified: three concurrent calls issue three full vault reads.
`getGraph` (`app.ts:103`) has the same bug, so two concurrent calls run
`buildGraph` twice.
*Fix:* cache the promise; invalidate incrementally (one note changed ≠ the vault
changed); keep a path+mtime index instead of full content.

**3. Checkbox mapping is quadratic in a note** — `src/client/blockview.ts:246`
`postprocess` calls `taskLinesIn(src, …)` once per block containing a checkbox,
and each call splits and fence-masks the **whole** note.

| tasks in note | desktop | phone (~5×) |
|--------------:|--------:|------------:|
|           500 |   42 ms |      0.2 s |
|         1,000 |  162 ms |      0.8 s |
|         2,000 |  592 ms |      3.0 s |
|         4,000 |  2.1 s |   **10.4 s** |

This runs on opening the note, on tapping any block, and on ticking any single
box (`rerenderKeepScroll`, line 257). A long TODO list is unusable.
*Fix:* compute the line mask and task lines once per render, not once per block.

**4. The graph view freezes the app** — `src/client/graph.ts:267` (sim), `:347` (draw)
10,002 nodes / 49,992 edges. Measured simulation tick: **379 ms average**
(2.6 fps desktop, ~0.5 fps phone), and it gets *worse* as gravity compresses the
layout — pair checks climb from 1.8M to 6.5M per frame over 25 frames. `draw()`
issues one `beginPath`+`stroke` per edge: **59,994 un-batched canvas draw calls
every frame**. `alpha` needs 881 frames to settle, and the rAF loop never stops
while the graph is open. `g` is a single unguarded keystroke (`app.ts:940`).
*Fix:* batch all edges into one path; cap or cluster nodes; stop the loop when
`alpha` settles.

**5. `wikiExists` rescans the vault per link** — `src/client/blockview.ts:219`
Every render calls `resolveLink` per wiki link. An index note with 50 links =
500,000 path scans per render. Fixed for free by the same index as #1.

---

## Mobile

Everything above, times ~5. Beyond that:

**The sidebar is rebuilt on every navigation, and on a phone it is never shown** —
`src/client/app.ts:430`. Measured in Chromium: **144 ms** to build 10,032
elements and 10,002 click closures; ~700 ms on a phone. `renderTree()` is called
from `renderAll()` (every note open), from `refreshFromDisk()` (every focus), and
from `loadNote`'s early return. Collapsed `<details>` still build all their
children. *Fix:* build it lazily when the sidebar opens; virtualize, or at least
add `content-visibility: auto`.

**Focus fires the vault re-walk twice** — `src/client/app.ts:948-961`. `focus` and
`visibilitychange` both call `refreshFromDisk()`, which invalidates every cache,
re-lists 10,000 notes and re-renders the tree. Switching to another app and back
costs it twice, concurrently. *Fix:* debounce and guard against re-entry.

**Per-keystroke work on long notes** — `src/client/app.ts:901`. Every keystroke in
a block bubbles to `updateNoteCount()` → `pendingContent()` (splits and rejoins
the whole note) → `countLabel()` (a Unicode-property regex over the whole note
plus a code-point spread). Measured: 2 KB 0.07 ms, 100 KB 2.5 ms, 200 KB 3.7 ms,
500 KB 15.4 ms — so ~19 ms per keystroke on a phone at 200 KB and ~77 ms at
500 KB. Fine for ordinary notes, bad for long ones. *Fix:* count the block live
and the note on a rAF/idle callback.

**Memory** — the 17 MB note cache plus the graph plus 10,000 DOM nodes and
closures is what makes an OOM kill plausible, and an OOM kill is what turns
finding #1 into lost writing.

---

## Not a problem

Things that sound alarming and are actually fine — don't spend time here:

- **Quick open and search.** A keystroke costs 3.0 ms desktop / ~15 ms phone over
  10,000 paths; worst-case full-text search (no hits, whole vault scanned) is
  12.9 ms / ~65 ms, and it's debounced 150 ms. `fuzzyScore` is fine as written.
- **The Rust file I/O.** `list_notes` 12 ms, `read_all_notes` 74 ms, serialize
  21 ms for the whole vault. The backend is not the bottleneck; the JS is.
- **`safe_join`** (`src-tauri/src/lib.rs:24`). Probed with `../etc/passwd`,
  `/etc/passwd`, `a/../../b` — all correctly rejected. Symlinks are skipped in
  `walk`. `state_path` validation is tight.
- **Window close.** Tauri v2 awaits the `onCloseRequested` handler before
  destroying (verified in `@tauri-apps/api/window.js:1632-1641`), so the red
  button flushes correctly. Only ⌘Q bypasses it (#5 above).
- **Write-then-rename.** The atomicity reasoning is right as far as it goes; what
  it's missing is the fsync (#6), not the structure.
- **The minimap.** Bails when hidden, coalesces on a 60 ms timer, passive scroll
  listener, desktop-only. Well behaved.
- **Block-to-source line mapping** — the riskiest logic in the app, since it
  splices raw lines under a rendered view. Fuzzed over ~534,000 generated
  markdown inputs (nested lists, fences inside list items, blockquoted lists,
  hard-wrapped paragraphs, setext headings, mixed markers) checking that
  `segmentBlocks` tiles the source exactly, that `groupForRender` agrees with
  marked's element count, and that checkbox indices line up with `taskLinesIn`.
  **No failures.** The "marked disagreed with our segmentation" fallback
  (`blockview.ts:199`) and the checked-state agreement guard (`:248`) are doing
  their job — this part is sound.
- **Orphaned `.carnet-tmp` files** are invisible to `list_notes` (the dotfile
  filter) — they accumulate but are harmless.

One thing outside the three requirements, worth a look sometime:
`assetProtocol.scope.allow` is `["**"]` in `tauri.conf.json`, so the asset
protocol can read any file on the machine, not just the vault.

---

## After

Same vault, same harness, after the fixes.

| what the app does | before | after |
|---|---:|---:|
| backlinks under the open note | 79.6 s (whole graph rebuilt) | **0.03 ms** (reverse index) |
| cost a save adds to the next navigation | 79.6 s (caches dropped) | **0.02 ms** (index edited in place) |
| build the link structure, once per session | 79.6 s | **181 ms** |
| resolve one wiki link | 1.6 ms | **0.001 ms** |
| graph view, per frame | 379 ms (2.6 fps) | **2 ms** (~450 fps), then the loop parks |
| graph view, nodes drawn | 10,002 nodes / 49,992 edges | **92 / 367** around the open note |
| graph view, canvas draw calls per frame | 59,994 | **~2** batched paths + one arc per node |
| open a 4,000-item checklist, or tick one box | 2.1 s | **0.9 ms** |
| sidebar tree per navigation | 144 ms, always | **0 ms** unless it's on screen |
| focus the app with nothing changed | full vault re-read | **one directory walk**, no JS |
| note counter | every keystroke | debounced 200 ms |
| longest a keystroke can stay unwritten | unbounded | **5 s**, and ~1 s in practice |
| durable write cost | — | +3 ms per save (fsync) |

Reproduce with `bun run bench/hot-paths.ts /tmp/vault10k`.

### Still true, and deliberate

- **Loading the vault is ~250 ms desktop / ~1.3 s phone**, once per session, the first time
  something needs every note's text (backlinks, search, or the graph). It happens after the
  note itself is on screen, and never again unless files change outside the app. Splitting it
  into chunks would remove the last hitch; it is the obvious next thing if the phone still
  feels slow on launch.
- **`⌘Q` flushing is not verifiable here.** Rust defers the exit, asks the webview to flush,
  and force-quits after 2 s regardless (so the app can never become unquittable). The deferral
  path needs a real macOS run to confirm — `src-tauri/src/lib.rs:659`.
- **The Android numbers are desktop × 5.** That ratio is fair for string-heavy JS in a WebView,
  but shared-storage I/O on Android goes through a FUSE shim this machine doesn't have. The
  file-reading numbers specifically could be worse there.
- **`assetProtocol.scope.allow` is still `["**"]`** in `tauri.conf.json` — outside the three
  requirements, so left alone, but worth tightening to the vault sometime.

## Fix order

Data loss first, then what unblocks 10,000 notes, then polish.

| # | Fix | Size | Notes |
|---|-----|------|-------|
| 1 | Autosave while typing in a block (`blockview.ts:424`) | small | Independent. Biggest single risk. |
| 2 | fsync + unique temp name in `write_note`; same for `write_state` | small | Independent. +3 ms measured. |
| 3 | Never upload with `overwrite`; block note creation until the mirror is complete | medium | Fixes #3 and #4 together. |
| 4 | Persisted outbox for failed pushes | medium | Depends on 3 (shares the rev/state work). |
| 5 | Reject writes to files that aren't valid UTF-8 | small | Independent. |
| 6 | Flush on ⌘Q via `RunEvent::ExitRequested` | small | Independent. |
| 7 | **Index paths by basename; use it in `resolveLink`** | small | Independent. 79.6 s → 228 ms. Do this before anything else perf. |
| 8 | Cache the promise in `getAllNotes`/`getGraph`; stop invalidating everything on every save | small | Depends on 7 to be worth measuring. |
| 9 | Hoist the line mask out of `postprocess`'s per-block loop | small | Independent. |
| 10 | Batch graph edges into one path; stop the rAF loop when settled; cap nodes | medium | Independent. |
| 11 | Build the sidebar tree lazily / virtualize it | medium | Independent. |
| 12 | Debounce `refreshFromDisk`; guard re-entry | small | Independent. |
| 13 | Move the note counter off the keystroke path | small | Independent. |
| 14 | Widen `djb2` to 64-bit; normalize line endings on write | small | Both sides must change together. |

1, 2, 5, 6, 7, 9 and 12 are all small and independent — that batch alone
removes the worst data-loss path and the 79-second freeze.
