import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = fileURLToPath(new URL("../dist", import.meta.url));

function run(command, args, cwd = root) {
    const result = spawnSync(command, args, { cwd, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status || 1);
}

run("npm", ["run", "build"]);
run("netlify", ["deploy", "--cwd", root, "--no-build", "--prod", "--site", process.env.NETLIFY_SITE_ID || "vector-express",
    "--dir", dist, "--functions", fileURLToPath(new URL("../functions", import.meta.url))], dist);
