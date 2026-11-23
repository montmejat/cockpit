// The cockpit server. A project's folder gets that project's server (project-server.ts); a
// workspace's folder (workspace.ts) gets the workspace's host (workspace-host.ts), which is no
// project of its own and runs a project server for each of its projects.
//   npm run serve -- <project dir, or a workspace's folder> [--port 4173] [--host 127.0.0.1]

import { resolve } from "node:path";
import { isWorkspace } from "./workspace.ts";

const args = process.argv.slice(2);
const dir = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
if (dir && !process.env.COCKPIT_CHILD && isWorkspace(resolve(dir))) await import("./workspace-host.ts");
else await import("./project-server.ts");
