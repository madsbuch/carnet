// Dev-only helper: serves the UI with hot reload for `tauri dev`.
// The packaged app has no server — it loads the bundled files from dist/.
import index from "./client/index.html";

const server = Bun.serve({
  port: 1420,
  development: true,
  routes: { "/*": index },
});

console.log(`carnet ui dev server: ${server.url}`);
