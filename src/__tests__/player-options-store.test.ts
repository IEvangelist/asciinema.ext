import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    _readMapForTest,
    clearInstanceOverrides,
    getInstanceOverrides,
    setInstanceOverrides,
} from "../player-options-store.js";

function makeContext() {
    const map = new Map<string, unknown>();
    return {
        globalState: {
            get<T>(key: string): T | undefined {
                return map.get(key) as T | undefined;
            },
            async update(key: string, value: unknown): Promise<void> {
                if (value === undefined) {
                    map.delete(key);
                } else {
                    map.set(key, value);
                }
            },
        },
    };
}

function makeUri(s: string) {
    return { toString: (): string => s };
}

describe("player-options-store", () => {
    it("returns empty when nothing is stored", () => {
        const ctx = makeContext();
        const result = getInstanceOverrides(
            ctx as never,
            makeUri("file:///a.cast") as never
        );
        assert.deepEqual(result, {});
    });

    it("round-trips a partial override", async () => {
        const ctx = makeContext();
        const uri = makeUri("file:///a.cast");
        await setInstanceOverrides(ctx as never, uri as never, {
            speed: 2,
            autoPlay: false,
        });
        const got = getInstanceOverrides(ctx as never, uri as never);
        assert.deepEqual(got, { speed: 2, autoPlay: false });
    });

    it("strips unknown keys and bad values on write", async () => {
        const ctx = makeContext();
        const uri = makeUri("file:///b.cast");
        await setInstanceOverrides(ctx as never, uri as never, {
            speed: -5,
            autoPlay: true,
            foo: "bar",
        } as never);
        const got = getInstanceOverrides(ctx as never, uri as never);
        assert.deepEqual(got, { autoPlay: true });
    });

    it("clears override when set to {}", async () => {
        const ctx = makeContext();
        const uri = makeUri("file:///c.cast");
        await setInstanceOverrides(ctx as never, uri as never, { speed: 2 });
        await setInstanceOverrides(ctx as never, uri as never, {});
        const map = _readMapForTest(ctx as never);
        assert.deepEqual(map, {});
    });

    it("clearInstanceOverrides removes the entry", async () => {
        const ctx = makeContext();
        const uri = makeUri("file:///d.cast");
        await setInstanceOverrides(ctx as never, uri as never, { speed: 2 });
        await clearInstanceOverrides(ctx as never, uri as never);
        assert.deepEqual(_readMapForTest(ctx as never), {});
    });

    it("LRU caps the map at 200 entries", async () => {
        const ctx = makeContext();
        for (let i = 0; i < 210; i++) {
            await setInstanceOverrides(
                ctx as never,
                makeUri(`file:///cast-${i}.cast`) as never,
                { speed: 1 + i / 1000 }
            );
        }
        const map = _readMapForTest(ctx as never);
        assert.equal(Object.keys(map).length, 200);
        assert.ok(map["file:///cast-209.cast"]);
        assert.equal(map["file:///cast-0.cast"], undefined);
    });

    it("recovers gracefully from a corrupt stored payload", () => {
        const ctx = makeContext();
        void ctx.globalState.update(
            "asciinema.playerOverrides.v1",
            "not-an-object"
        );
        const result = getInstanceOverrides(
            ctx as never,
            makeUri("file:///x.cast") as never
        );
        assert.deepEqual(result, {});
    });
});
