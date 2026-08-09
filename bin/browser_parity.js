#!/usr/bin/env node
/**
 * Live Hunt UI (Chrome via puppeteer-core) vs headless parity probe (docs/25).
 *
 * Runs rising_pressure_macro / duo / seed 42 under Application.run, captures
 * parityTickLog (party/RNG/kills post-hop), diffs against Node headless.
 * No stealth plugins, no external scrape — localhost only.
 *
 * Usage:
 *   npm run browser:parity
 *   npm run browser:parity -- --to-tick 780 --speed 20
 *   npm run browser:parity -- --to-tick 2400   # full A1 session (wipe ~2278)
 *   BROWSER_PARITY_URL=http://localhost:8080/hunt-design-lab/index.php npm run browser:parity
 *
 * Requires: system Chrome/Chromium + optional local PHP server (auto-starts
 * when --no-server is not set and nothing answers at the URL).
 * Default URL uses /<project-folder>/ (official name: hunt-design-lab).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { ROOT } = require('../kernel/settings.js');
const {
    runHeadlessHuntToTick
} = require('../kernel/providers/simulator/headless_runner.js');
const {
    formatParityTickLog
} = require('../kernel/apps/game/live_panel.js');
const { setActiveMode, DEFAULT_MODE_ID } = require('../kernel/core/lib/modes.js');
const { stableStringify } = require('../kernel/core/lib/telemetry.js');

/**
 * Usual Apache/nginx layout: parent docroot serves this project folder by name.
 * Official package directory name is `hunt-design-lab`.
 */
const PROJECT_BASE = path.basename(ROOT);
const DEFAULT_URL = `http://localhost:8080/${PROJECT_BASE}/index.php`;
const DEFAULT_HUNT = 'rising_pressure_macro';
const DEFAULT_PARTY = 'rising_pressure_duo';
const DEFAULT_SEED = 42;
// Default past first stair hops + auto parity window (Guardian@645, Scout@656).
// Full A1 session: --to-tick 2400 (party_wipe ends @2278; both members both floors).
const DEFAULT_TO_TICK = 780;
const DEFAULT_SPEED = 20;

function printHelp() {
    console.log(`Browser ↔ headless multi-floor parity (docs/25).

Usage:
  node bin/browser_parity.js [options]
  npm run browser:parity -- [options]

Options:
  --url <url>         Hunt Simulator page (default ${DEFAULT_URL})
  --to-tick <n>       Stop when live tick ≥ n (default ${DEFAULT_TO_TICK})
  --speed <n>         TIME_SPEED while running (default ${DEFAULT_SPEED})
  --seed <n>          Seed (default ${DEFAULT_SEED})
  --hunt <id>         Hunt id (default ${DEFAULT_HUNT})
  --party <id>        Party id (default ${DEFAULT_PARTY})
  --mode <id>         Content mode (default standard)
  --chrome <path>     Chrome/Chromium binary
  --out <file>        Write full JSON report
  --no-server         Do not auto-start php -S
  --headed            Show the browser window
  --timeout-ms <n>    Wall timeout for live run (default 120000)
  -h, --help

Needs: puppeteer-core (devDependency) + system Chrome.
`);
}

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
    const out = {
        url: process.env.BROWSER_PARITY_URL || DEFAULT_URL,
        toTick: DEFAULT_TO_TICK,
        speed: DEFAULT_SPEED,
        seed: DEFAULT_SEED,
        huntId: DEFAULT_HUNT,
        partyId: DEFAULT_PARTY,
        modeId: DEFAULT_MODE_ID,
        chrome:
            process.env.CHROME_PATH ||
            process.env.PUPPETEER_EXECUTABLE_PATH ||
            null,
        out: null,
        noServer: false,
        headed: false,
        timeoutMs: 120000,
        help: false
    };
    const args = argv.slice();
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '-h' || a === '--help') {
            out.help = true;
            continue;
        }
        if (a === '--no-server') {
            out.noServer = true;
            continue;
        }
        if (a === '--headed') {
            out.headed = true;
            continue;
        }
        if (a === '--url') {
            out.url = args[++i];
            continue;
        }
        if (a === '--to-tick' || a === '--toTick') {
            out.toTick = parseInt(args[++i], 10);
            continue;
        }
        if (a === '--speed') {
            out.speed = parseFloat(args[++i]);
            continue;
        }
        if (a === '--seed') {
            out.seed = parseInt(args[++i], 10);
            continue;
        }
        if (a === '--hunt') {
            out.huntId = args[++i];
            continue;
        }
        if (a === '--party') {
            out.partyId = args[++i];
            continue;
        }
        if (a === '--mode') {
            out.modeId = args[++i];
            continue;
        }
        if (a === '--chrome') {
            out.chrome = args[++i];
            continue;
        }
        if (a === '--out') {
            out.out = args[++i];
            continue;
        }
        if (a === '--timeout-ms' || a === '--timeoutMs') {
            out.timeoutMs = parseInt(args[++i], 10);
            continue;
        }
        throw new Error(`Unknown flag: ${a}`);
    }
    return out;
}

/**
 * @param {string} url
 * @returns {Promise<boolean>}
 */
function urlResponds(url) {
    return new Promise((resolve) => {
        let parsed;
        try {
            parsed = new URL(url);
        } catch (_) {
            resolve(false);
            return;
        }
        const req = http.get(
            {
                hostname: parsed.hostname,
                port: parsed.port || 80,
                path: parsed.pathname + parsed.search,
                timeout: 1500
            },
            (res) => {
                res.resume();
                resolve(res.statusCode != null && res.statusCode < 500);
            }
        );
        req.on('error', () => resolve(false));
        req.on('timeout', () => {
            req.destroy();
            resolve(false);
        });
    });
}

/**
 * @returns {string|null}
 */
function findChrome() {
    const candidates = [
        process.env.CHROME_PATH,
        process.env.PUPPETEER_EXECUTABLE_PATH,
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/snap/bin/chromium'
    ].filter(Boolean);
    for (let i = 0; i < candidates.length; i++) {
        if (fs.existsSync(candidates[i])) return candidates[i];
    }
    return null;
}

/**
 * @param {object[]} liveLog
 * @param {object[]} headLog
 * @returns {{ index: number, live: object|null, head: object|null, reason: string }|null}
 */
function firstParityDiff(liveLog, headLog) {
    const n = Math.max(liveLog.length, headLog.length);
    for (let i = 0; i < n; i++) {
        const L = liveLog[i] || null;
        const H = headLog[i] || null;
        if (!L || !H) {
            return {
                index: i,
                live: L,
                head: H,
                reason: !L ? 'live missing row' : 'headless missing row'
            };
        }
        if (L.t !== H.t) {
            return { index: i, live: L, head: H, reason: `tick ${L.t}≠${H.t}` };
        }
        if (L.kills !== H.kills) {
            return {
                index: i,
                live: L,
                head: H,
                reason: `kills ${L.kills}≠${H.kills}`
            };
        }
        if (L.rng !== H.rng) {
            return {
                index: i,
                live: L,
                head: H,
                reason: `rng 0x${(L.rng >>> 0).toString(16)}≠0x${(H.rng >>> 0).toString(16)}`
            };
        }
        if (L.draws !== H.draws) {
            return {
                index: i,
                live: L,
                head: H,
                reason: `draws ${L.draws}≠${H.draws}`
            };
        }
        const scoutL = (L.party || []).find((m) => m && m.n === 'Scout');
        const scoutH = (H.party || []).find((m) => m && m.n === 'Scout');
        if (scoutL && scoutH) {
            if (
                scoutL.x !== scoutH.x ||
                scoutL.y !== scoutH.y ||
                String(scoutL.z) !== String(scoutH.z)
            ) {
                return {
                    index: i,
                    live: L,
                    head: H,
                    reason: `Scout pos (${scoutL.x},${scoutL.y},z${scoutL.z})≠(${scoutH.x},${scoutH.y},z${scoutH.z})`
                };
            }
            if (scoutL.dmg !== scoutH.dmg) {
                return {
                    index: i,
                    live: L,
                    head: H,
                    reason: `Scout dmg ${scoutL.dmg}≠${scoutH.dmg}`
                };
            }
            if (scoutL.k !== scoutH.k) {
                return {
                    index: i,
                    live: L,
                    head: H,
                    reason: `Scout k ${scoutL.k}≠${scoutH.k}`
                };
            }
        }
        const atkL = JSON.stringify(L.atk || []);
        const atkH = JSON.stringify(H.atk || []);
        if (atkL !== atkH) {
            return {
                index: i,
                live: L,
                head: H,
                reason: 'atk[] differs'
            };
        }
    }
    return null;
}

/**
 * @param {object[]} log
 * @param {number} from
 * @param {number} to
 */
function sliceParityWindow(log, from, to) {
    return (log || []).filter(
        (row) => row && row.t >= from && row.t <= to
    );
}

async function main() {
    let opts;
    try {
        opts = parseArgs(process.argv.slice(2));
    } catch (err) {
        console.error(err.message || err);
        process.exit(2);
    }
    if (opts.help) {
        printHelp();
        process.exit(0);
    }

    let puppeteer;
    try {
        puppeteer = require('puppeteer-core');
    } catch (_) {
        console.error(
            'Missing puppeteer-core. Install with:\n  npm install --save-dev puppeteer-core'
        );
        process.exit(2);
    }

    const chromePath = opts.chrome || findChrome();
    if (!chromePath) {
        console.error(
            'No Chrome/Chromium found. Pass --chrome /path/to/chrome'
        );
        process.exit(2);
    }

    /** @type {import('child_process').ChildProcess|null} */
    let phpProc = null;
    const up = await urlResponds(opts.url);
    if (!up) {
        if (opts.noServer) {
            console.error(
                `Nothing responds at ${opts.url}. Start your web server (or omit --no-server).`
            );
            process.exit(2);
        }
        const projectRoot = ROOT || process.cwd();
        let parsedUrl;
        try {
            parsedUrl = new URL(opts.url);
        } catch (_) {
            console.error(`Invalid --url: ${opts.url}`);
            process.exit(2);
        }
        const host = parsedUrl.hostname || 'localhost';
        const port = parsedUrl.port || '8080';
        const urlPath = parsedUrl.pathname || '/';
        // /<project-folder>/... → document root is parent of the project folder
        let docRoot = projectRoot;
        let pathHint = urlPath;
        const base = path.basename(projectRoot);
        if (urlPath === `/${base}` || urlPath.startsWith(`/${base}/`)) {
            docRoot = path.dirname(projectRoot);
        }
        console.error(
            `[browser:parity] starting php -S ${host}:${port} -t ${docRoot} (path ${pathHint})`
        );
        phpProc = spawn(
            'php',
            [
                '-d',
                'memory_limit=512M',
                '-S',
                `${host}:${port}`,
                '-t',
                docRoot
            ],
            { cwd: docRoot, stdio: 'ignore' }
        );
        let ready = false;
        for (let i = 0; i < 50; i++) {
            // eslint-disable-next-line no-await-in-loop
            await new Promise((r) => setTimeout(r, 100));
            // eslint-disable-next-line no-await-in-loop
            if (await urlResponds(opts.url)) {
                ready = true;
                break;
            }
        }
        if (!ready) {
            if (phpProc) phpProc.kill('SIGTERM');
            console.error(
                `PHP server failed to become ready for ${opts.url}. ` +
                    `Is something else on :${port}, or is the path wrong?`
            );
            process.exit(2);
        }
    }

    const cleanup = () => {
        if (phpProc && !phpProc.killed) {
            try {
                phpProc.kill('SIGTERM');
            } catch (_) {
                /* ignore */
            }
        }
    };
    process.on('exit', cleanup);
    process.on('SIGINT', () => {
        cleanup();
        process.exit(130);
    });

    console.error(
        `[browser:parity] chrome=${chromePath} url=${opts.url} toTick=${opts.toTick} speed=${opts.speed}`
    );

    /** Writable dirs — some sandboxes block writing under $HOME. */
    const userDataDir =
        process.env.CHROME_USER_DATA_DIR ||
        path.join('/tmp', `de-chrome-udata-${process.pid}`);
    fs.mkdirSync(userDataDir, { recursive: true });

    let browser;
    try {
        browser = await puppeteer.launch({
            executablePath: chromePath,
            headless: opts.headed ? false : true,
            userDataDir,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--autoplay-policy=no-user-gesture-required'
            ]
        });
    } catch (launchErr) {
        cleanup();
        console.error(
            'Failed to launch Chrome (sandbox / binary permissions?).\n' +
                '  On your machine: ensure google-chrome runs, then:\n' +
                '    npm run browser:parity\n' +
                '  Detail: ' +
                (launchErr && launchErr.message ? launchErr.message : launchErr)
        );
        process.exit(2);
    }

    /** @type {object|null} */
    let liveSnap = null;
    try {
        const page = await browser.newPage();
        page.setDefaultTimeout(opts.timeoutMs);
        page.on('pageerror', (err) => {
            console.error('[pageerror]', err && err.message ? err.message : err);
        });
        page.on('console', (msg) => {
            const type = msg.type();
            if (type === 'error' || type === 'warning') {
                console.error(`[page.${type}]`, msg.text());
            }
        });

        await page.goto(opts.url, { waitUntil: 'networkidle0', timeout: 60000 });
        await page.waitForFunction(
            () =>
                typeof window.__HUNT_TEST__ === 'object' &&
                window.__HUNT_TEST__ &&
                window.__HUNT_TEST__.ready === true,
            { timeout: 60000 }
        );

        await page.evaluate(
            async (cfg) => {
                const api = window.__HUNT_TEST__;
                await api.configure({
                    modeId: cfg.modeId,
                    huntId: cfg.huntId,
                    partyId: cfg.partyId,
                    seed: cfg.seed,
                    speed: cfg.speed,
                    hopAutoPause: false,
                    // Must match headless runHeadlessHuntToTick({ parityTrace: true })
                    // or LIVE parityTickLog stays empty → false "live missing row".
                    parityTrace: true
                });
                await api.play();
            },
            {
                modeId: opts.modeId,
                huntId: opts.huntId,
                partyId: opts.partyId,
                seed: opts.seed,
                speed: opts.speed
            }
        );

        const deadline = Date.now() + opts.timeoutMs;
        while (Date.now() < deadline) {
            // eslint-disable-next-line no-await-in-loop
            liveSnap = await page.evaluate(() => window.__HUNT_TEST__.snapshot());
            if (!liveSnap || !liveSnap.live) {
                // eslint-disable-next-line no-await-in-loop
                await new Promise((r) => setTimeout(r, 100));
                continue;
            }
            if (liveSnap.tick >= opts.toTick) break;
            if (
                liveSnap.sessionState &&
                liveSnap.sessionState !== 'running' &&
                liveSnap.sessionState !== 'idle'
            ) {
                break;
            }
            // eslint-disable-next-line no-await-in-loop
            await new Promise((r) => setTimeout(r, 50));
        }

        if (!liveSnap || !liveSnap.live) {
            throw new Error('Live session never became ready');
        }
        if (liveSnap.tick < opts.toTick) {
            console.error(
                `[browser:parity] stopped early tick=${liveSnap.tick} state=${liveSnap.sessionState}`
            );
        } else {
            // Freeze so snapshot is stable
            await page.evaluate(() => window.__HUNT_TEST__.pause());
            liveSnap = await page.evaluate(() => window.__HUNT_TEST__.snapshot());
        }
    } finally {
        await browser.close();
    }

    setActiveMode(opts.modeId || DEFAULT_MODE_ID);
    const head = await runHeadlessHuntToTick({
        seed: opts.seed,
        huntId: opts.huntId,
        partyId: opts.partyId,
        toTick: opts.toTick,
        parityTrace: true
    });

    // Prefer auto window armed on first floor hop (headless + live when parityTrace on).
    // Fallback covers pre-hop runs / missing arm.
    const win =
        (head.parityWindow && head.parityWindow.from != null
            ? head.parityWindow
            : null) ||
        (liveSnap.parityWindow && liveSnap.parityWindow.from != null
            ? liveSnap.parityWindow
            : null) ||
        { from: 646, to: 670 };
    const from = win.from;
    const to = Math.min(opts.toTick, win.to != null ? win.to : opts.toTick);
    const liveLog = sliceParityWindow(liveSnap.parityTickLog || [], from, to);
    const headLog = sliceParityWindow(head.parityTickLog || [], from, to);
    const diff = firstParityDiff(liveLog, headLog);

    const report = {
        ok: !diff,
        seed: opts.seed,
        huntId: opts.huntId,
        partyId: opts.partyId,
        toTick: opts.toTick,
        live: {
            tick: liveSnap.tick,
            sessionState: liveSnap.sessionState,
            kills: liveSnap.kills,
            deaths: liveSnap.deaths,
            damageTaken: liveSnap.damageTaken,
            damageDealt: liveSnap.damageDealt,
            floorHopLog: liveSnap.floorHopLog,
            party: liveSnap.party,
            parityWindow: liveSnap.parityWindow,
            parityTickLog: liveLog
        },
        headless: {
            tick: head.tickCount,
            sessionState: head.sessionState,
            kills: head.kills,
            deaths: head.deaths,
            damageTaken: head.damageTaken,
            damageDealt: head.damageDealt,
            floorHopLog: head.floorHopLog || null,
            partyPositions: head.partyPositions,
            parityWindow: head.parityWindow,
            parityTickLog: headLog
        },
        firstDiff: diff
            ? {
                  reason: diff.reason,
                  tick: (diff.live && diff.live.t) || (diff.head && diff.head.t),
                  live: diff.live,
                  head: diff.head
              }
            : null
    };

    console.error('[browser:parity] LIVE hops', JSON.stringify(liveSnap.floorHopLog || []));
    console.error(
        `[browser:parity] LIVE t=${liveSnap.tick} kills=${liveSnap.kills} deaths=${liveSnap.deaths} dmgIn=${liveSnap.damageTaken}`
    );
    console.error(
        `[browser:parity] HEAD t=${head.tickCount} kills=${head.kills} deaths=${head.deaths} dmgIn=${head.damageTaken}`
    );
    console.error('[browser:parity] LIVE parity:\n' + formatParityTickLog(liveLog));
    console.error('[browser:parity] HEAD parity:\n' + formatParityTickLog(headLog));
    if (diff) {
        console.error(
            `[browser:parity] FIRST DIFF t${(diff.live && diff.live.t) || (diff.head && diff.head.t)}: ${diff.reason}`
        );
    } else {
        console.error(
            `[browser:parity] OK — parityTickLog matches for t${from}–${to}`
        );
    }

    const outPath =
        opts.out ||
        path.join(
            ROOT || process.cwd(),
            'var',
            'sim',
            `browser_parity_s${opts.seed}_t${opts.toTick}.json`
        );
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, stableStringify(report) + '\n', 'utf8');
    console.error(`[browser:parity] wrote ${outPath}`);

    // Machine-readable one-liner on stdout
    console.log(
        stableStringify({
            ok: report.ok,
            firstDiffTick: report.firstDiff && report.firstDiff.tick,
            firstDiffReason: report.firstDiff && report.firstDiff.reason,
            liveKills: liveSnap.kills,
            headKills: head.kills,
            out: outPath
        })
    );

    cleanup();
    process.exit(report.ok ? 0 : 1);
}

main().catch((err) => {
    console.error('browser_parity FAILED:', err);
    process.exit(1);
});
