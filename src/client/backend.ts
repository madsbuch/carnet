// Thin adapter over the Tauri IPC commands. All file access happens in Rust.
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";

export interface Note {
  path: string;
  content: string;
  mtime: number;
}

export type SaveResult =
  | { status: "ok"; mtime: number }
  | { status: "conflict"; content: string; mtime: number };

const VAULT_KEY = "carnet.vault";
let root: string | null = localStorage.getItem(VAULT_KEY);

export function vaultRoot(): string | null {
  return root;
}

export function setVault(path: string): void {
  root = path;
  localStorage.setItem(VAULT_KEY, path);
}

export function clearVault(): void {
  root = null;
  localStorage.removeItem(VAULT_KEY);
}

export function vaultValid(path: string): Promise<boolean> {
  return invoke<boolean>("vault_exists", { root: path });
}

export async function browseForVault(): Promise<string | null> {
  const picked = await openDialog({ directory: true, title: "Choose your notes folder" });
  return typeof picked === "string" ? picked : null;
}

/** Android: system bar insets in CSS px (webview draws edge-to-edge there). */
export const safeAreaInsets = () => invoke<{ top: number; bottom: number }>("safe_area_insets");

/** Android: is "All files access" granted? Always true on desktop. */
export const storageReady = () => invoke<boolean>("storage_ready");

/** Android: open the system settings screen for "All files access". */
export const requestStorageAccess = () => invoke<void>("request_storage_access");

/** Android: existing folders that look like a synced Dropbox. */
export const findVaultCandidates = () => invoke<string[]>("find_vault_candidates");

function must(): string {
  if (!root) throw new Error("no vault selected");
  return root;
}

export const listNotes = () => invoke<string[]>("list_notes", { root: must() });

export const readNote = (path: string) => invoke<Note | null>("read_note", { root: must(), path });

export const readAllNotes = () => invoke<Note[]>("read_all_notes", { root: must() });

export const writeNote = (path: string, content: string, baseMtime?: number, baseHash?: string) =>
  invoke<SaveResult>("write_note", {
    root: must(),
    path,
    content,
    baseMtime: baseMtime ?? null,
    baseHash: baseHash ?? null,
  });

/** URL usable in <img src> for a file inside the vault. */
export const assetUrl = (rel: string) => convertFileSrc(must() + "/" + rel);

export { openUrl };
