# Carnet

Notes are markdown files in a folder you own — typically your Dropbox folder. Carnet is a
small [Tauri](https://tauri.app) app (macOS + Android) that reads and writes those files
directly. There is no server and no database; Dropbox does all the syncing.

## What it does

- **`[wiki-links]`** — writing `[some-name]` links to `some-name.md` anywhere in the folder
  tree (same folder as the current note wins if there are several). Clicking a link that
  doesn't resolve creates the file next to the current note. `[projects/carnet]` addresses an
  exact path from the root. Typing `[` in any editor pops a fuzzy type-ahead over your notes;
  picking one completes the link.
- **Graph** — a force-directed graph of every link between notes, colored by top-level
  folder. Notes that are linked but don't exist yet show up gray. Click a node to open it.
- **Daily notes** — `yyyy-MM-dd.md`. Carnet opens today's note on launch (creating it in the
  folder where your daily notes already live) and `t` jumps back to it.
- **TODOs** — `- [ ]` checkboxes are clickable in the rendered view and write straight back
  to the file.
- **Backlinks** — every note lists the notes that link to it.
- **Counts** — a faint `words · chars` line under the note, and the same under the block
  you're editing, live as you type. Markdown's own dressing (`#`, `- [x]`, fences, `---`)
  never counts as a word; CJK counts per character.
- **Quick open** — `⌘K` (or `/`): fuzzy filename matching plus full-text search; type a new
  name to create a note.
- **Sync-aware** — notes re-read when the app regains focus; if a save collides with an edit
  synced from another device you choose which version wins.

The interface is one page: the note, four buttons, a file tree behind the hamburger. Purpose
lives in file names (`projects/carnet/carnet-tasks.md`), not in menus. On phone-sized
screens the hamburger opens a full-screen files view instead — search on top, the tree
below — since a drawer is cramped there.

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

On first launch the app walks through the Android setup itself: a checklist that opens the
"All files access" settings screen, points at FolderSync, detects the synced folder, and
ticks each step off as it's done. Two notes on what's behind that:

1. **Storage permission.** Carnet reads a folder of your choosing, so after
   `android init`, add to `src-tauri/gen/android/app/src/main/AndroidManifest.xml`:

   ```xml
   <uses-permission android:name="android.permission.MANAGE_EXTERNAL_STORAGE" />
   ```

   The setup screen sends the user to the right settings page (and won't proceed until
   the switch is flipped).

2. **Getting Dropbox files onto the phone.** The Dropbox app doesn't mirror files to local
   storage. Use a sync app — Dropsync, [FolderSync](https://foldersync.io/), or similar —
   to two-way sync your Dropbox to e.g. `/storage/emulated/0/Dropbox`. The setup screen is
   agnostic to which app you pick: it offers any top-level storage folder that holds
   markdown files.

### Real-time Dropbox sync (Android)

Folder-sync apps poll on an interval (FolderSync's default is 15 minutes), so a note edited
on another device can take that long to show up. On Android the setup screen offers a second
option — **connect Dropbox directly** — that skips the sync app entirely: Carnet keeps a local
mirror of your Dropbox folder and uses Dropbox's long-poll API to pull changes within seconds,
pushing your own saves straight back. Desktop is unaffected and still uses a plain folder (the
Dropbox client there is already near-instant).

To use it you supply your own Dropbox **app key** (one-time, so the app isn't tied to a shared
key):

1. Create a [Scoped app](https://www.dropbox.com/developers/apps) with **App folder** access
   (recommended). The app is then confined to its own `/Apps/<your app>/` folder and can never
   see the rest of your Dropbox — least privilege, so a leaked token can't reach anything else.
   Your notes live in that folder. Choose **Full Dropbox** instead only if you need to sync an
   existing folder elsewhere in your account in place.
2. On the app's **Permissions** tab, tick `files.metadata.read`, `files.content.read` and
   `files.content.write`. All three are required — `list_folder` and the long-poll need the
   metadata scope, download needs content read, upload/delete need content write.
3. Paste the app key into the setup screen. Optionally set a **subfolder to sync** (e.g.
   `/notes`, relative to the app folder; leave blank to sync the whole app folder). Then
   authorize.

Because paths are relative to the app's root, App folder and Full Dropbox use the exact same
code — the choice is purely how much of your Dropbox the token can reach. Auth is OAuth2 with
PKCE and no redirect — Dropbox shows a code you paste back — so there's no server and no secret.
Only `.md` notes under the chosen folder sync (attachments still ride whatever folder sync you
have).

Authorizing sends you to the browser, and Android may kill Carnet while it's in the
background, so the app comes back to a freshly loaded page. Anything that has to outlive that
— the notes folder, the app key, the half-finished PKCE handshake, the sync cursor — is
written to a file in the app's own data directory rather than to the webview's `localStorage`,
which the system is free to discard.

The pasted code is the fragile step, so: pressing **Authorize Dropbox…** again keeps the
previous handshakes alive (a code copied from an older browser tab is still accepted), the
code box is cleared when a new authorization starts, and the finish button is held while the
exchange is in flight — a second tap would re-send a single-use code and fail a connection
that was working. If Dropbox still rejects the code, it has expired or been used: authorize
again and paste the new one promptly.

Under the hood this is
[`src/client/dropbox.ts`](src/client/dropbox.ts) (API client) and
[`dropboxsync.ts`](src/client/dropboxsync.ts) (the pull/push engine), both unit-tested in
[`src/dropbox.test.ts`](src/dropbox.test.ts).

## CI builds

Every push to `main` runs [.github/workflows/build.yml](.github/workflows/build.yml): tests, a
universal macOS `.dmg` (Apple Silicon + Intel), and an installable Android `.apk`. Both are
published to the rolling **[latest release](../../releases/latest)**, with stable public
download links (no GitHub login, no artifact expiry):

- **macOS:** <https://github.com/madsbuch/carnet/releases/latest/download/Carnet.dmg>
- **Android:** <https://github.com/madsbuch/carnet/releases/latest/download/carnet.apk>
  (open this URL straight from your phone to install)

They're also on each run's **Artifacts** if you need a specific commit's build.

- **macOS:** the `.dmg` is unsigned/un-notarized, so the first launch needs right-click → Open
  (or `xattr -dr com.apple.quarantine /Applications/Carnet.app`).
- **Android:** the APK already carries the storage permission (CI patches the generated manifest);
  the first-run setup walks through granting "All files access". Without signing secrets
  the APK is signed with a throwaway key, so each new build needs uninstall-then-install. For
  in-place updates, create a keystore once and add it as repository secrets:

  ```sh
  keytool -genkeypair -keystore carnet.jks -alias carnet -keyalg RSA -keysize 2048 -validity 10000
  base64 -i carnet.jks | pbcopy   # → secret ANDROID_KEYSTORE_B64
  ```

  Secrets: `ANDROID_KEYSTORE_B64` (the base64 above), `ANDROID_KEYSTORE_PASSWORD`, and
  `ANDROID_KEY_ALIAS` (`carnet` if you used the command as-is). Keep `carnet.jks` somewhere safe —
  losing it means reinstalling instead of updating.

## Layout

```
src/links.ts        [wiki-link] parsing + resolution, task toggling (shared, pure)
src/graph-data.ts   link graph, search, daily-note logic (shared, pure)
src/counts.ts       word / character counting (shared, pure)
src/client/         the UI: app.ts, graph.ts (canvas), wiki.ts (marked extension)
src/dev.ts          dev-only hot-reload server for `tauri dev`
src-tauri/          Rust: filesystem commands (list/read/write, conflict detection)
icon/               app icon sources; regenerate with `python3 icon/generate.py`
                    then `bun tauri icon icon/app-icon.json`
```

All note intelligence lives in the shared TypeScript modules; Rust only does file IO. The
save path is conflict-checked: if a file's mtime moved since you loaded it (Dropbox synced
an edit from elsewhere), nothing is overwritten until you choose.
