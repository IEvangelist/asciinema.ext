import * as esbuild from "esbuild";
import { cpSync, mkdirSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const isWatch = process.argv.includes("--watch");

// Copy asciinema-player bundle assets to dist/media/
const mediaDir = resolve(__dirname, "dist", "media");
if (!existsSync(mediaDir)) {
    mkdirSync(mediaDir, { recursive: true });
}

const playerBundleDir = resolve(
    __dirname,
    "node_modules",
    "asciinema-player",
    "dist",
    "bundle"
);

cpSync(
    resolve(playerBundleDir, "asciinema-player.min.js"),
    resolve(mediaDir, "asciinema-player.min.js")
);
cpSync(
    resolve(playerBundleDir, "asciinema-player.css"),
    resolve(mediaDir, "asciinema-player.css")
);

console.log("✔ Copied asciinema-player assets to dist/media/");

/** @type {esbuild.BuildOptions} */
const buildOptions = {
    entryPoints: ["src/extension.ts"],
    bundle: true,
    outfile: "dist/extension.js",
    external: ["vscode"],
    format: "cjs",
    platform: "node",
    target: "node22",
    sourcemap: true,
    minify: !isWatch,
};

if (isWatch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log("👀 Watching for changes...");
} else {
    await esbuild.build(buildOptions);
    console.log("✔ Extension bundled to dist/extension.js");
}
