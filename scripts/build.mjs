import { build } from "esbuild";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";

const { name, workspaces } = JSON.parse(await readFile("package.json", "utf8"));
const isWorkspaceRoot = Array.isArray(workspaces);
await rm("functions", { recursive: true, force: true });

await build({
    entryPoints: [isWorkspaceRoot ? "src/index.js" : "src/api.js"],
    outfile: "functions/api.cjs",
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    logLevel: "info",
});
await mkdir("dist", { recursive: true });
await writeFile("dist/index.html", `<!doctype html><title>${name}</title>`);
