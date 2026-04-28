// Humorous quips shown during long-running progress steps — because watching
// a progress bar is way more fun when it sasses you back.
//
// Both download and extraction phases share these tiers; an extra extraction-
// flavored set is mixed in via `getExtractionQuip` for variety.

const QUIPS_5S: readonly string[] = [
    "☕ Grabbing a coffee… you should too.",
    "🐢 Bits are arriving. Slowly. Politely.",
    "📦 Packaging electrons one by one…",
    "🚚 Your artifact is on a delivery truck somewhere.",
    "🛜 Negotiating with the tubes of the internet…",
    "🐌 Speedrunning this download. Any% glitchless.",
    "🎯 Almost there. Probably. Maybe.",
    "🧵 Following the thread of bytes back to GitHub…",
    "🪄 Convincing the bytes to migrate westward.",
    "📬 Mailbox check… still waiting on the postman.",
];

const QUIPS_15S: readonly string[] = [
    "⏳ Still going. Have you tried stretching?",
    "🧘 Patience is a virtue. So is fast Wi-Fi.",
    "🛰️ Pretty sure these bits went via satellite. Twice.",
    "🦥 Sloths are checking their watches.",
    "📡 Bouncing packets off the moon, hold tight…",
    "🍵 Tea break? I'll keep an eye on the bytes.",
    "🐢💨 Going as fast as a tortoise on roller skates.",
    "🎮 Loading screen achievement unlocked.",
    "🛤️ Bits are riding the slow train. With a layover.",
    "🪟 Watch the spinner spin… mesmerizing, isn't it?",
    "🗂️ Sorting bytes alphabetically. They were a mess.",
];

const QUIPS_30S: readonly string[] = [
    "🥖 You could've baked bread by now.",
    "🏗️ Reticulating splines. (Wait, wrong app.)",
    "🐢 The tortoise has lapped us.",
    "📜 Bits travel by horseback in this region.",
    "🎻 *elevator music intensifies*",
    "🧙 Summoning your artifact from the ether…",
    "🦕 Dinosaurs went extinct faster than this.",
    "📺 Have you considered watching a sitcom?",
    "🪐 At this rate Voyager 2 will deliver it personally.",
    "🐪 Bytes traveling by camel caravan.",
    "🧊 The bits froze. Defrosting…",
    "🎬 This download is now a feature film.",
];

const QUIPS_60S: readonly string[] = [
    "🦴 Civilizations have risen and fallen in less time.",
    "🪦 RIP, my patience. 2024–now.",
    "🛸 At this point I assume aliens intercepted it.",
    "📼 Faster to mail you a USB stick, honestly.",
    "🐌🐌🐌 Sending in reinforcements.",
    "🌌 The heat death of the universe has entered the chat.",
    "🧓 I was young when this download started.",
    "🥱 *yawn* Wake me when it's done.",
    "🪙 Have you tried bribing your router?",
    "🦴 Found some fossils while waiting.",
    "📞 Should I call GitHub and ask politely?",
    "🌙 Counting moons of Jupiter to pass the time…",
    "⛏️ Mining the bytes by hand at this point.",
];

// Extraction-flavored extras — funnier when the phase is local CPU work.
const EXTRACT_EXTRAS_15S: readonly string[] = [
    "🗜️ Unzipping with surgical precision…",
    "📂 Tetris-ing files into folders.",
    "🧩 Reassembling the puzzle bit by bit.",
    "🪗 Decompressing like an over-stuffed accordion.",
    "🧹 Sweeping bytes into their cubbies.",
];

const EXTRACT_EXTRAS_30S: readonly string[] = [
    "🥒 This zip is more pickled than expected.",
    "📚 Cataloguing the artifact's library by genre.",
    "🏛️ Archiving with museum-grade care.",
    "🪤 Caught a few sneaky symlinks. Released them politely.",
];

const EXTRACT_EXTRAS_60S: readonly string[] = [
    "🦣 This zip is positively woolly mammoth-sized.",
    "🏗️ Building a small village out of these files.",
    "🗃️ I have filed a complaint about file count.",
];

function pick(list: readonly string[], seed: number): string {
    return list[seed % list.length];
}

interface Tier {
    readonly threshold: number;
    readonly quips: readonly string[];
}

const DOWNLOAD_TIERS: readonly Tier[] = [
    { threshold: 5_000, quips: QUIPS_5S },
    { threshold: 15_000, quips: QUIPS_15S },
    { threshold: 30_000, quips: QUIPS_30S },
    { threshold: 60_000, quips: QUIPS_60S },
];

const EXTRACT_TIERS: readonly Tier[] = [
    { threshold: 5_000, quips: QUIPS_5S },
    { threshold: 15_000, quips: [...QUIPS_15S, ...EXTRACT_EXTRAS_15S] },
    { threshold: 30_000, quips: [...QUIPS_30S, ...EXTRACT_EXTRAS_30S] },
    { threshold: 60_000, quips: [...QUIPS_60S, ...EXTRACT_EXTRAS_60S] },
];

const QUIP_DURATION_MS = 7_000;

function quipForTiers(
    tiers: readonly Tier[],
    elapsedMs: number
): string | undefined {
    if (elapsedMs < tiers[0].threshold) {
        return undefined;
    }
    let active: Tier = tiers[0];
    for (const tier of tiers) {
        if (elapsedMs >= tier.threshold) {
            active = tier;
        } else {
            break;
        }
    }
    const inTier = elapsedMs - active.threshold;
    const seed = Math.floor(inTier / QUIP_DURATION_MS);
    return pick(active.quips, seed);
}

/**
 * Download-phase quip. Each quip displays for ~7s, with rotation re-aligned
 * at every tier boundary so larger group changes always land on a fresh
 * quip (no abrupt mid-message swap).
 */
export function getDownloadQuip(elapsedMs: number): string | undefined {
    return quipForTiers(DOWNLOAD_TIERS, elapsedMs);
}

/** Extraction-phase quip — same cadence, with a few extra zip-themed jokes. */
export function getExtractionQuip(elapsedMs: number): string | undefined {
    return quipForTiers(EXTRACT_TIERS, elapsedMs);
}
