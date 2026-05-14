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

interface CastEntry {
    readonly relPath: string;
}

interface CastCandidateData {
    readonly entries: CastEntry[];
}

interface CastInfo {
    readonly relPath: string;
    readonly absPath: string;
    bytes: number;
}

export const castHandler: ArtifactHandler = {
    detect(ctx: HandlerContext): HandlerCandidate | null {
        const entries: CastEntry[] = [];
        for (const rel of ctx.bundle.files) {
            if (/\.cast$/i.test(rel)) {
                entries.push({ relPath: rel });
            }
        }
        if (entries.length === 0) {
            return null;
        }
        const detailParts: string[] = ["Asciinema player"];
        if (entries.length > 1) {
            detailParts.push(`first: ${path.posix.basename(entries[0].relPath)}`);
        } else {
            detailParts.push(entries[0].relPath);
        }
        return {
            id: "asciinema-cast",
            icon: "$(play-circle)",
            label:
                entries.length === 1
                    ? "Open .cast recording"
                    : "Open .cast recordings",
            description: `${entries.length} ${
                entries.length === 1 ? "file" : "files"
            }`,
            detail: detailParts.join(" · "),
            priority: 10,
            data: { entries } satisfies CastCandidateData,
        };
    },

    async open(ctx: HandlerContext, candidate: HandlerCandidate): Promise<void> {
        const extracted = ctx.extracted;
        if (!extracted) {
            // Dispatcher guarantees extraction has happened before invoking
            // open() for a cast candidate — this is a defensive guard.
            throw new Error(
                "Cast handler requires the artifact to be extracted to disk."
            );
        }
        const data = candidate.data as CastCandidateData;
        const casts: CastInfo[] = [];
        for (const entry of data.entries) {
            const abs = path.join(extracted.rootDir.fsPath, entry.relPath);
            let size = 0;
            try {
                const stat = await fs.stat(abs);
                size = stat.size;
            } catch {
                // ignore — entries that can't be stat'd still appear in the
                // picker, just without size metadata.
            }
            casts.push({ relPath: entry.relPath, absPath: abs, bytes: size });
        }

        const chosen = await pickCast(casts);
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
