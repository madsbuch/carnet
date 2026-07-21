# Carnet

Notes are markdown files in a folder you own — typically your Dropbox folder. Carnet is a
small [Tauri](https://tauri.app) app (macOS + Android) that reads and writes those files
directly. There is no server and no database; Dropbox does all the syncing.

## What it does

- **`[wiki-links]`** — writing `[some-name]` links to `some-name.md` anywhere in the folder
  tree (same folder as the current note wins if there are several). Clicking a link that
  doesn't resolve creates the file next to the current note. `[projects/carnet]` addresses an
  exact path from the root.
- **Graph** — a force-directed graph of every link between notes, colored by top-level
  folder. Notes that are linked but don't exist yet show up gray. Click a node to open it.
- **Daily notes** — `yyyy-MM-dd.md`. Carnet opens today's note on launch (creating it in the
  folder where your daily notes already live) and `t` jumps back to it.
- **TODOs** — `- [ ]` checkboxes are clickable in the rendered view and write straight back
  to the file.
- **Backlinks** — every note lists the notes that link to it.
- **Quick open** — `⌘K` (or `/`): fuzzy filename matching plus full-text search; type a new
  name to create a note.
- **Sync-aware** — notes re-read when the app regains focus; if a save collides with an edit
  synced from another device you choose which version wins.

The interface is one page: the note, four buttons, a file tree behind the hamburger. Purpose
lives in file names (`projects/carnet/carnet-tasks.md`), not in menus.

## Keyboard

| Key | Action |
|-----|--------|
| `⌘K` or `/` | quick open / search |
| `e` or double-click | edit ↔ preview |
| `t` | today's daily note |
| `g` | graph |
| `b` | file tree |
| `⌘S` | save now (auto-save runs anyway) |
| `esc` | close whatever is open |

## Development

Prereqs: [bun](https://bun.sh), [Rust](https://rustup.rs), Xcode command line tools.

```sh
bun install
bun run dev        # tauri dev with hot-reloaded UI
bun test           # link parsing / graph logic tests
```

## macOS

```sh
bun run build
```

The app lands in `src-tauri/target/release/bundle/macos/Carnet.app` (and a `.dmg` next to
it). On first launch, pick your notes folder — Carnet suggests `~/Dropbox` if it exists.

## Android

Tauri 2 builds the same app for Android. One-time setup on your machine
([full guide](https://tauri.app/start/prerequisites/#android)): install Android Studio /
SDK + NDK, set `ANDROID_HOME` and `NDK_HOME`, then:

```sh
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
bun tauri android init
bun tauri android dev      # run on a connected device
bun tauri android build    # release apk/aab
```

Two Android-specific notes:

1. **Storage permission.** Carnet reads a folder of your choosing, so after
   `android init`, add to `src-tauri/gen/android/app/src/main/AndroidManifest.xml`:

   ```xml
   <uses-permission android:name="android.permission.MANAGE_EXTERNAL_STORAGE" />
   ```

   and grant "All files access" to Carnet in Android settings after installing.

2. **Getting Dropbox files onto the phone.** The Dropbox app doesn't mirror files to local
   storage. Use [FolderSync](https://foldersync.io/) (or Dropsync) to two-way sync your
   Dropbox to e.g. `/storage/emulated/0/Dropbox`, then point Carnet at that folder.

## Layout

```
src/links.ts        [wiki-link] parsing + resolution, task toggling (shared, pure)
src/graph-data.ts   link graph, search, daily-note logic (shared, pure)
src/client/         the UI: app.ts, graph.ts (canvas), wiki.ts (marked extension)
src/dev.ts          dev-only hot-reload server for `tauri dev`
src-tauri/          Rust: filesystem commands (list/read/write, conflict detection)
```

All note intelligence lives in the shared TypeScript modules; Rust only does file IO. The
save path is conflict-checked: if a file's mtime moved since you loaded it (Dropbox synced
an edit from elsewhere), nothing is overwritten until you choose.
