import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import type {
    ArtifactHandler,
    HandlerCandidate,
    HandlerContext,
} from "./handler-types.js";
import { writeTempCast } from "../temp-storage.js";
import {
    formatBytesShort,
    formatDurationShort,
    parseCastDurationSeconds,
} from "../quickpick-helpers.js";
import { showQuickPick } from "./quickpick.js";

interface CastInfo {
    readonly relPath: string;
    readonly absPath: string;
    bytes: number;
}

interface CastCandidateData {
    readonly casts: CastInfo[];
}

export const castHandler: ArtifactHandler = {
    async detect(ctx: HandlerContext): Promise<HandlerCandidate | null> {
        const casts: CastInfo[] = [];
        for (const rel of ctx.extracted.files) {
            if (!/\.cast$/i.test(rel)) {
                continue;
            }
            const abs = path.join(ctx.extracted.rootDir.fsPath, rel);
            let size = 0;
            try {
                const stat = await fs.stat(abs);
                size = stat.size;
            } catch {
                // ignore
            }
            casts.push({ relPath: rel, absPath: abs, bytes: size });
        }
        if (casts.length === 0) {
            return null;
        }
        const totalBytes = casts.reduce((sum, c) => sum + c.bytes, 0);
        const largest = casts.reduce(
            (max, c) => (c.bytes > max.bytes ? c : max),
            casts[0]
        );
        const detailParts: string[] = ["Asciinema player"];
        if (casts.length > 1) {
            detailParts.push(
                `largest: ${path.posix.basename(largest.relPath)} (${formatBytesShort(
                    largest.bytes
                )})`
            );
        } else {
            detailParts.push(largest.relPath);
        }
        return {
            id: "asciinema-cast",
            icon: "$(play-circle)",
            label:
                casts.length === 1
                    ? "Open .cast recording"
                    : "Open .cast recordings",
            description: `${casts.length} ${
                casts.length === 1 ? "file" : "files"
            }${totalBytes > 0 ? ` · ${formatBytesShort(totalBytes)} total` : ""}`,
            detail: detailParts.join(" · "),
            priority: 10,
            data: { casts } satisfies CastCandidateData,
        };
    },

    async open(ctx: HandlerContext, candidate: HandlerCandidate): Promise<void> {
        const data = candidate.data as CastCandidateData;
        const chosen = await pickCast(data.casts);
        if (!chosen) {
            return;
        }

        const buf = await fs.readFile(chosen.absPath);
        const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        const fileUri = await writeTempCast(
            ctx.extensionContext,
            chosen.relPath,
            u8
        );
        await vscode.commands.executeCommand(
            "vscode.openWith",
            fileUri,
            "asciinema.castPreview"
        );
    },
};

interface CastQuickPickItem extends vscode.QuickPickItem {
    readonly cast?: CastInfo;
}

async function pickCast(casts: CastInfo[]): Promise<CastInfo | undefined> {
    if (casts.length === 1) {
        return casts[0];
    }
    const sorted = [...casts].sort((a, b) =>
        a.relPath.localeCompare(b.relPath)
    );
    const grouped = new Map<string, CastInfo[]>();
    for (const cast of sorted) {
        const dir = path.posix.dirname(cast.relPath);
        const key = dir === "." ? "(artifact root)" : dir;
        const list = grouped.get(key);
        if (list) {
            list.push(cast);
        } else {
            grouped.set(key, [cast]);
        }
    }

    const items: CastQuickPickItem[] = [];
    for (const [dir, list] of grouped) {
        items.push({
            label: dir,
            kind: vscode.QuickPickItemKind.Separator,
        });
        for (const cast of list) {
            const description = await describeCast(cast);
            items.push({
                label: `$(terminal)  ${path.posix.basename(cast.relPath)}`,
                description,
                detail: cast.relPath,
                cast,
            });
        }
    }

    const picked = await showQuickPick(items, {
        title: "Asciinema — select a recording",
        placeholder: "Type to filter — name, path, or size…",
    });
    return picked?.cast;
}

async function describeCast(cast: CastInfo): Promise<string> {
    const sizeStr = formatBytesShort(cast.bytes);
    let durationStr: string | undefined;
    try {
        const fd = await fs.open(cast.absPath, "r");
        try {
            const headBuf = Buffer.alloc(8192);
            const headRead = await fd.read(
                headBuf,
                0,
                headBuf.byteLength,
                0
            );
            const headBytes = new Uint8Array(
                headBuf.buffer,
                headBuf.byteOffset,
                headRead.bytesRead
            );
            durationStr = formatDurationShort(
                parseCastDurationSeconds(headBytes)
            );
        } finally {
            await fd.close();
        }
    } catch {
        // best-effort
    }
    return durationStr ? `${sizeStr} · ~${durationStr}` : sizeStr;
}
