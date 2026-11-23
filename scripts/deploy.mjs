import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

function run(command, args) {
    const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status || 1);
}

run("npm", ["run", "build"]);
run("netlify", ["deploy", "--no-build", "--prod", "--filter", "vector-express",
    "--dir", fileURLToPath(new URL("../dist", import.meta.url)),
    "--functions", fileURLToPath(new URL("../functions", import.meta.url))]);
