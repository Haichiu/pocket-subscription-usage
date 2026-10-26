/**
 * Subscription usage: a page on the rail with how much of your Claude, ChatGPT (Codex), OpenCode Go, Grok, Z.ai, and
 * MiniMax plans is used, and when each limit resets, plus the DeepSeek balance when Pi has a DeepSeek key. The server
 * asks each service with the sign-ins already on this machine, so no key or token reaches the browser. The command
 * `/usage-plans` posts the same usage as a card in the session.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
// A type import is gone when the module runs: only the type checker reads this path. Pi Pocket links the public types
// beside the drop-in, as `_pocket.d.ts`.
import type { Web } from "./_pocket.d.ts";

/** The version of Pi Pocket's extension API this module is written for. */
export const pocketApi = 1;

type Level = "ok" | "warning" | "critical";

interface Limit {
    label: string;
    percent: number;
    resetsAt?: string;
    level: Level;
    /** The limit that holds you back now, when the service says which. */
    binding?: boolean;
}

/** A prepaid account's balance: money left, not a share of a plan used. */
interface Balance {
    currency: string;
    total: number;
    granted: number;
    toppedUp: number;
    /** Whether the service says it can take paid calls now. */
    enough: boolean;
}

type Report =
    | { id: string; name: string; ok: true; limits: Limit[]; notes: string[]; balance?: Balance }
    | { id: string; name: string; ok: false; error: string };

type OkReport = Extract<Report, { ok: true }>;

/**
 * The plan report that a Pi model provider belongs to, and the name that fits the status line. The report's credentials
 * are Pi's sign-in to the provider (Codex's are the Codex CLI's own): a regional or API-key variant with another
 * sign-in shows no quota.
 */
const PROVIDER_REPORTS: Record<string, { report: string; label: string }> = {
    anthropic: { report: "anthropic", label: "Claude" },
    "openai-codex": { report: "openai", label: "Codex" },
    "opencode-go": { report: "opencode-go", label: "OpenCode Go" },
    xai: { report: "xai", label: "Grok" },
    zai: { report: "zai", label: "Z.ai" },
    minimax: { report: "minimax", label: "MiniMax" },
    deepseek: { report: "deepseek", label: "DeepSeek" },
};

/** How long each service may take to answer. */
const TIMEOUT_MS = 15_000;
/** An answer is kept this long: tabs that look at the same time share one call to each service. */
const FRESH_MS = 60_000;
/** Refresh asks the services again, but not more often than this. */
const MIN_GAP_MS = 10_000;
/** The status line accepts a reading up to this age: a session's provider quota is not worth asking the services often. */
const STATUS_MAX_AGE_MS = 5 * 60_000;
/** Grok's own billing, as the Grok CLI reads it: the plan's shared weekly pool. */
const GROK_BILLING = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
/** Grok CLI settings: the plan's name. */
const GROK_SETTINGS = "https://cli-chat-proxy.grok.com/v1/settings";
/** Z.ai's quota and subscriptions, as its own subscription page reads them. */
const ZAI_QUOTA = "https://api.z.ai/api/monitor/usage/quota/limit";
const ZAI_PLANS = "https://api.z.ai/api/biz/subscription/list";
/** MiniMax's Coding Plan lanes, as its own Coding Plan page reads them. */
const MINIMAX_REMAINS = "https://api.minimax.io/v1/api/openplatform/coding_plan/remains";
/** Z.ai's units for a window's length, in minutes (5 is a month, named on its own). */
const ZAI_UNIT_MINUTES: Record<number, number> = { 3: 60, 4: 1440, 6: 10_080 };

/** A command card's width, in characters: it fits a phone's chat column without a wrap. */
const CARD_WIDTH = 38;

/** A limit's name for the card's narrow column: "5-hour session" is "5h session", "Week, all models" is "Week, all". */
function shortLabel(label: string): string {
    return label
        .replace(/(\d+)[- ]hours?/g, "$1h")
        .replace(/(\d+) days?/g, "$1d")
        .replace(/(\d+) minutes?/g, "$1m")
        .replace(", all models", ", all")
        .replace(", shared pool", ", pool")
        .replace(/^Web tools, /, "Web ");
}

/** "4d 17h", "2h 52m", "9m": how long until a reset, from `now`. */
function until(time: number, now: number): string {
    const minutes = Math.max(0, Math.round((time - now) / 60_000));
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    const rest = minutes % 60;

    if (minutes === 0) {
        return "now";
    }

    if (days > 0) {
        return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
    }

    return hours > 0 ? (rest > 0 ? `${hours}h ${rest}m` : `${hours}h`) : `${rest}m`;
}

/** Money in its own currency's sign, or its code and number when that code is not one Node knows. */
function money(amount: number, currency: string): string {
    try {
        return new Intl.NumberFormat("en-US", {
            style: "currency",
            currency: currency || "CNY",
            currencyDisplay: "narrowSymbol",
        }).format(amount);
    } catch {
        return `${currency} ${amount.toFixed(2)}`.trim();
    }
}

/**
 * The usage as a command's card: plain text in a mono font, so it is laid out in columns. Each plan is a titled rule,
 * each limit a row with a gauge of squares (as on the page), how full it is, and how long until it resets. A mark in the
 * margin tells what color tells on the page: `!` for a warning, `!!` for critical, `▸` the limit in force.
 */
export function usageCard(data: { at: number; reports: Report[] }, now = Date.now()): string {
    const rows = data.reports.flatMap((report) => (report.ok ? report.limits : []));
    const label = Math.min(16, Math.max(8, ...rows.map((each) => shortLabel(each.label).length)));
    const resets = rows.map((each) => Date.parse(each.resetsAt ?? ""));
    const reset = Math.max(
        0,
        ...resets.map((at) => (Number.isFinite(at) ? until(at, now).length : 0)),
    );
    // Room for the gauge: what the other columns leave of the width, 6 to 12 blocks.
    const cells = Math.min(12, Math.max(6, CARD_WIDTH - (3 + label + 1 + 1 + 4 + 2 + reset)));
    const width = 3 + label + 1 + cells + 1 + 4 + (reset > 0 ? 2 + reset : 0);
    const marks = new Set<string>();
    const lines: string[] = [];

    const rule = (name: string, tag = "") =>
        `${name} ${"─".repeat(Math.max(3, width - name.length - (tag ? tag.length + 2 : 1)))}${tag ? ` ${tag}` : ""}`;

    for (const report of data.reports) {
        if (!report.ok) {
            lines.push(rule(report.name, "unavailable"), `   ${report.error}`);

            continue;
        }

        lines.push(rule(report.name));

        if (report.balance) {
            const { total, currency, enough } = report.balance;

            lines.push(
                `   ${money(total, currency)} left · ${enough ? "available" : "not enough for calls"}`,
            );
        }

        if (report.limits.length === 0 && !report.balance) {
            lines.push("   No limits reported.");
        }

        for (const limit of report.limits) {
            const percent = Math.round(percentOf(limit.percent));
            const lit =
                percent <= 0
                    ? 0
                    : // At least one square for any use, and all of them only when it is full.
                      Math.min(
                          percent < 100 ? cells - 1 : cells,
                          Math.max(1, Math.round(percent / (100 / cells))),
                      );
            const at = Date.parse(limit.resetsAt ?? "");
            const mark =
                limit.level === "critical"
                    ? "!! "
                    : limit.level === "warning"
                      ? "!  "
                      : limit.binding
                        ? "▸  "
                        : "   ";
            let name = shortLabel(limit.label);

            if (name.length > label) {
                name = `${name.slice(0, label - 1)}…`;
            }

            if (mark.trim() !== "") {
                marks.add(mark.trim());
            }

            lines.push(
                `${mark}${name.padEnd(label)} ${"■".repeat(lit)}${"□".repeat(cells - lit)} ${`${percent}%`.padStart(4)}${
                    Number.isFinite(at) ? `  ${until(at, now).padStart(reset)}` : ""
                }`.trimEnd(),
            );
        }
    }

    if (data.reports.length === 0) {
        lines.push("No plans reported: sign in under Menu → Providers.");
    }

    const key = [
        marks.has("▸") && "▸ in force",
        marks.has("!") && "! warning",
        marks.has("!!") && "!! critical",
    ].filter(Boolean);
    const read = new Date(data.at).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
    });

    const foot = [...key, `read ${read}`].join(" · ");

    // The key and the time on one line when they fit: a card shows its last 12 lines until opened.
    lines.push(
        "─".repeat(width),
        ...(foot.length <= width
            ? [foot]
            : [...(key.length > 0 ? [key.join(" · ")] : []), `Read ${read}`]),
    );

    return lines.join("\n");
}

/** Words this module wrote itself, safe to show. Anything else that goes wrong is told in fixed words. */
class Said extends Error {}

/** A percent from a service: a finite number, else 0. */
function percentOf(value: unknown): number {
    const number = Number(value);

    return Number.isFinite(number) ? Math.max(0, number) : 0;
}

/** Money from a service, which sends it as text: a finite number, else 0. */
function amountOf(value: unknown): number {
    const number = Number(value);

    return Number.isFinite(number) ? Math.max(0, number) : 0;
}

/** A level from the service's own word for it, else from how full the limit is. */
function levelOf(percent: number, said?: unknown): Level {
    if (said === "critical" || said === "exceeded" || said === "limited" || said === "blocked") {
        return "critical";
    }

    if (said === "warning") {
        return "warning";
    }

    return percent >= 90 ? "critical" : percent >= 75 ? "warning" : "ok";
}

/** A reset time from milliseconds since 1970, as Z.ai gives it. */
function resetOfMs(value: unknown): { resetsAt?: string } {
    return resetOf(typeof value === "number" ? value / 1000 : value);
}

/** A reset time as ISO text, from ISO text or seconds since 1970; none when it is not a time. */
function resetOf(value: unknown): { resetsAt?: string } {
    const time =
        typeof value === "number"
            ? value * 1000
            : typeof value === "string"
              ? Date.parse(value)
              : NaN;

    // A date holds up to 8.64e15 ms either way of 1970: past that, `toISOString` would throw.
    return Number.isFinite(time) && Math.abs(time) <= 8.64e15
        ? { resetsAt: new Date(time).toISOString() }
        : {};
}

/** A service's failure in words for its card, which names the service: never what the service sent back. */
function failed(error: unknown): string {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        return `No answer in ${TIMEOUT_MS / 1000} s.`;
    }

    if (error instanceof Said) {
        return error.message;
    }

    return `It could not be read (${error instanceof Error ? error.name : "unknown error"}): try again later.`;
}

function answered(status: number): Said {
    return new Said(
        status === 401 || status === 403
            ? `It refused the sign-in (${status}): sign in again in Menu → Providers.`
            : `It answered ${status}.`,
    );
}

/** Anthropic's names for its limits, as people read them. */
function claudeLabel(limit: Record<string, any>): string {
    const model = limit.scope?.model?.display_name;

    switch (limit.kind) {
        case "session":
            return "5-hour session";
        case "weekly_all":
            return "Week, all models";
        case "weekly_scoped":
            return `Week, ${typeof model === "string" ? model : "one model"}`;
        default:
            return String(limit.kind ?? "Limit").replaceAll("_", " ");
    }
}

/** A Codex limit's window, as people read it: 300 minutes is "5 hours", 10080 a week. */
function windowLabel(minutes: unknown): string {
    if (typeof minutes !== "number" || !(minutes > 0)) {
        return "Limit";
    }

    if (minutes === 10_080) {
        return "Week";
    }

    if (minutes % 1440 === 0) {
        return minutes === 1440 ? "Day" : `${minutes / 1440} days`;
    }

    return minutes % 60 === 0 ? `${minutes / 60} hours` : `${minutes} minutes`;
}

/** A Z.ai window as people read it: unit 3 is hours, 4 days, 5 months, 6 weeks. None for a unit it does not know. */
function zaiWindow(unit: unknown, number: unknown): string | undefined {
    if (typeof unit !== "number" || typeof number !== "number" || !(number > 0)) {
        return undefined;
    }

    if (unit === 5) {
        return number === 1 ? "Month" : `${number} months`;
    }

    const minutes = ZAI_UNIT_MINUTES[unit];

    return minutes === undefined ? undefined : windowLabel(minutes * number);
}

/** "GrokBuild" as "Grok Build". */
const spaced = (name: string) => name.replace(/([a-z])([A-Z])/g, "$1 $2");

/** "video" as "Video". */
const capitalized = (name: string) => `${name.charAt(0).toUpperCase()}${name.slice(1)}`;

/**
 * Ask Codex's own app server (`codex app-server`, JSON-RPC over stdio) for the account's limits. Codex reads and
 * renews its sign-in itself, so no token passes through here. The server is started for one question and stopped.
 */
function askCodex(signal: AbortSignal, children: Set<ChildProcess>): Promise<Record<string, any>> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(signal.reason);

            return;
        }

        const child = spawn("codex", ["app-server"], {
            cwd: homedir(),
            stdio: ["pipe", "pipe", "ignore"],
        });
        let done = false;

        // Kept until it ends: the module going waits for it. `close` comes when it ended, and when it never started (no
        // `codex` to run), when `exit` does not.
        children.add(child);
        child.once("close", () => children.delete(child));

        const finish = (run: () => void) => {
            if (done) {
                return;
            }

            done = true;
            signal.removeEventListener("abort", stop);
            child.stdin.end();
            child.kill();
            // A Codex that does not stop when asked is stopped for good.
            setTimeout(() => {
                if (child.exitCode === null && child.signalCode === null) {
                    child.kill("SIGKILL");
                }
            }, 2000).unref();
            run();
        };

        const stop = () => finish(() => reject(signal.reason));
        const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);

        signal.addEventListener("abort", stop, { once: true });
        child.stdin.on("error", () => {});
        child.stdout.on("error", () => {});
        child.on("error", (error: NodeJS.ErrnoException) =>
            finish(() =>
                reject(
                    error.code === "ENOENT"
                        ? new Said(
                              "The Codex CLI is not installed on the server: install it, then run codex login.",
                          )
                        : error,
                ),
            ),
        );
        child.on("exit", () =>
            finish(() =>
                reject(
                    new Said("Codex stopped before it answered: run codex login, then try again."),
                ),
            ),
        );

        // Nothing in here may throw: a throw in a stream's handler is not this promise's to catch, and would stop the
        // whole server.
        createInterface({ input: child.stdout }).on("line", (line) => {
            try {
                if (done) {
                    return;
                }

                let message: unknown;

                try {
                    message = JSON.parse(line);
                } catch {
                    return;
                }

                if (message === null || typeof message !== "object" || Array.isArray(message)) {
                    return;
                }

                const { id, result, method } = message as {
                    id?: unknown;
                    result?: unknown;
                    method?: unknown;
                };

                // Requests and notifications from Codex carry a method: only answers to ours count.
                if (method !== undefined) {
                    return;
                }

                if (id === 0) {
                    send({ method: "initialized" });
                    send({ method: "account/rateLimits/read", id: 1 });
                } else if (id === 1) {
                    finish(() =>
                        result !== null && typeof result === "object"
                            ? resolve(result as Record<string, any>)
                            : reject(
                                  new Said(
                                      "Codex could not read the limits: run codex login, then try again.",
                                  ),
                              ),
                    );
                }
            } catch (error) {
                finish(() => reject(error));
            }
        });

        send({
            method: "initialize",
            id: 0,
            params: {
                clientInfo: {
                    name: "pi_pocket_usage",
                    title: "Pi Pocket subscription usage",
                    version: "1.0.0",
                },
                capabilities: null,
            },
        });
    });
}

export default function createSubscriptionUsage(_host: unknown, web: Web) {
    // Pi's own models and sign-ins: `getAuth` renews an expiring subscription token under Pi's lock, as Pi does.
    let runtime: Promise<ModelRuntime> | undefined;
    let last: { at: number; reports: Report[] } | undefined;
    let pending: Promise<{ at: number; reports: Report[] }> | undefined;
    // Turning the module off, or a new version of it, stops the reads still running, and Codex with them: the module
    // is gone once every Codex it started ended (one that ignores being asked to stop is killed after 2 s).
    const alive = new AbortController();
    const children = new Set<ChildProcess>();

    web.onDispose(() => {
        alive.abort();

        return Promise.all(
            [...children].map(
                (child) =>
                    new Promise<void>((resolve) => {
                        if (child.exitCode !== null || child.signalCode !== null) {
                            resolve();
                        } else {
                            child.once("close", () => resolve());
                        }
                    }),
            ),
        );
    });

    const models = () =>
        (runtime ??= ModelRuntime.create({ refreshOnCreate: false }).catch((error: unknown) => {
            // A failure is not kept: the next read tries again.
            runtime = undefined;

            throw error;
        }));

    /** Pi's sign-in to a provider, and how it signed in ("OAuth" for a subscription), or none. */
    const signIn = async (provider: string, signal: AbortSignal) => {
        const found = await (await models()).getAuth(provider, { signal });
        const key = found?.auth.apiKey;

        return typeof key === "string" && key !== "" ? { key, source: found?.source } : undefined;
    };

    const credential = async (provider: string, signal: AbortSignal) => {
        const found = await signIn(provider, signal);

        if (found === undefined) {
            throw new Said("Pi is not signed in to it: sign in under Menu → Providers.");
        }

        return found.key;
    };

    async function claude(signal: AbortSignal): Promise<Report> {
        const name = "Claude (Anthropic)";

        try {
            const token = await credential("anthropic", signal);
            const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
                headers: { authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
                redirect: "error",
                signal,
            });

            if (!response.ok) {
                throw answered(response.status);
            }

            const data = (await response.json()) as Record<string, any>;
            let limits: Limit[];

            if (Array.isArray(data.limits)) {
                limits = data.limits
                    .filter((limit: unknown) => limit !== null && typeof limit === "object")
                    .map((limit: Record<string, any>) => {
                        const percent = percentOf(limit.percent);

                        return {
                            label: claudeLabel(limit),
                            percent,
                            ...resetOf(limit.resets_at),
                            level: levelOf(percent, limit.severity),
                            binding: limit.is_active === true,
                        };
                    });
            } else {
                // An older answer: the 5-hour and weekly windows alone.
                limits = [
                    ["five_hour", "5-hour session"],
                    ["seven_day", "Week, all models"],
                ].flatMap(([field, label]) => {
                    const window = data[field!];

                    if (window === null || typeof window !== "object") {
                        return [];
                    }

                    const percent = percentOf(window.utilization);

                    return [
                        {
                            label: label!,
                            percent,
                            ...resetOf(window.resets_at),
                            level: levelOf(percent),
                        },
                    ];
                });
            }

            return {
                id: "anthropic",
                name,
                ok: true,
                limits,
                notes: [
                    data.extra_usage?.is_enabled === true
                        ? "Extra usage is on."
                        : "Extra usage is off.",
                ],
            };
        } catch (error) {
            return { id: "anthropic", name, ok: false, error: failed(error) };
        }
    }

    async function chatGpt(signal: AbortSignal): Promise<Report> {
        const name = "ChatGPT (OpenAI Codex)";

        try {
            const data = await askCodex(signal, children);
            const byId = data.rateLimitsByLimitId;
            const snapshots = (
                byId !== null && typeof byId === "object" ? Object.values(byId) : [data.rateLimits]
            ).filter(
                (each): each is Record<string, any> => each !== null && typeof each === "object",
            );
            const limits: Limit[] = [];
            const notes: string[] = [];

            for (const snapshot of snapshots) {
                // The plan's own limit goes without a name; another one (a model's, say) is named.
                const prefix =
                    snapshot.limitId === "codex" || snapshot.limitId == null
                        ? ""
                        : `${String(snapshot.limitName ?? snapshot.limitId)}, `;

                for (const window of [snapshot.primary, snapshot.secondary]) {
                    if (window === null || typeof window !== "object") {
                        continue;
                    }

                    const percent = percentOf(window.usedPercent);

                    limits.push({
                        label: prefix + windowLabel(window.windowDurationMins),
                        percent,
                        ...resetOf(window.resetsAt),
                        level: snapshot.rateLimitReachedType ? "critical" : levelOf(percent),
                    });
                }
            }

            const plan = snapshots.find((each) => typeof each.planType === "string")?.planType;
            const resets = data.rateLimitResetCredits?.availableCount;
            const credits = snapshots.find((each) => each.credits?.hasCredits === true)?.credits;

            notes.push(
                typeof plan === "string"
                    ? `${plan.charAt(0).toUpperCase()}${plan.slice(1)} plan, from the Codex CLI's sign-in.`
                    : "From the Codex CLI's sign-in.",
            );

            if (data.ordinaryUsageAllowed === false) {
                notes.push("Codex says the plan's usage is used up for now.");
            }

            if (credits) {
                notes.push(
                    credits.unlimited
                        ? "Credits: unlimited."
                        : `Credits: ${String(credits.balance ?? 0)}.`,
                );
            }

            if (typeof resets === "number" && resets > 0) {
                notes.push(`${resets} free full reset${resets === 1 ? "" : "s"} available.`);
            }

            return { id: "openai", name, ok: true, limits, notes };
        } catch (error) {
            return { id: "openai", name, ok: false, error: failed(error) };
        }
    }

    async function openCodeGo(signal: AbortSignal): Promise<Report> {
        const name = "OpenCode Go";

        try {
            const key = await credential("opencode-go", signal);
            const response = await fetch("https://opencode.ai/zen/go/v1/usage", {
                headers: { authorization: `Bearer ${key}` },
                redirect: "error",
                signal,
            });

            if (!response.ok) {
                throw answered(response.status);
            }

            const usage = ((await response.json()) as { usage?: Record<string, any> }).usage ?? {};
            const limits = [
                ["rolling", "5 hours, rolling"],
                ["weekly", "Week"],
                ["monthly", "Month"],
            ].flatMap(([field, label]) => {
                const window = usage[field!];

                if (window === null || typeof window !== "object") {
                    return [];
                }

                const percent = percentOf(window.percent);

                // Its own word for the state ("ok", or a word for over), else how full it is.
                return [
                    {
                        label: label!,
                        percent,
                        ...resetOf(window.resetsAt),
                        level: levelOf(percent, window.status),
                    },
                ];
            });

            return { id: "opencode-go", name, ok: true, limits, notes: [] };
        } catch (error) {
            return { id: "opencode-go", name, ok: false, error: failed(error) };
        }
    }

    /**
     * Grok's shared weekly pool, from the SuperGrok or X Premium sign-in: the one the Grok CLI uses. Without it there is
     * no plan to show (an xAI API key pays as it goes), so the page leaves Grok out.
     */
    async function grok(signal: AbortSignal): Promise<Report | undefined> {
        const name = "Grok (xAI)";

        try {
            const found = await signIn("xai", signal);

            if (found?.source !== "OAuth") {
                return undefined;
            }

            const headers = {
                authorization: `Bearer ${found.key}`,
                "x-xai-token-auth": "xai-grok-cli",
                accept: "application/json",
            };
            // The plan's name is a nice to have: when it cannot be read, the pool still shows.
            const tier = fetch(GROK_SETTINGS, { headers, redirect: "error", signal })
                .then((response) => (response.ok ? response.json() : undefined))
                .then(
                    (settings: Record<string, any> | undefined) =>
                        settings?.subscription_tier_display,
                )
                .catch(() => undefined);
            const response = await fetch(GROK_BILLING, { headers, redirect: "error", signal });

            if (response.status === 412) {
                throw new Said("Grok keeps no personal quota for a team account.");
            }

            if (!response.ok) {
                throw answered(response.status);
            }

            // Grok answers in proto JSON, which leaves out every field that is 0: a missing percent is 0%.
            const config =
                ((await response.json()) as { config?: Record<string, any> }).config ?? {};
            const period = config.currentPeriod ?? {};
            const start = Date.parse(period.start);
            const end = Date.parse(period.end);
            const limits: Limit[] = [];
            const notes: string[] = [];

            if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
                const percent = percentOf(config.creditUsagePercent);

                limits.push({
                    label: `${windowLabel(Math.round((end - start) / 60_000))}, shared pool`,
                    percent,
                    ...resetOf(period.end),
                    level: levelOf(percent),
                });
            }

            const plan = await tier;

            notes.push(
                typeof plan === "string" && plan.trim() !== ""
                    ? `${plan.trim()} plan, from Pi's xAI sign-in.`
                    : "From Pi's xAI sign-in.",
            );

            const products = (Array.isArray(config.productUsage) ? config.productUsage : [])
                .filter(
                    (each: unknown): each is Record<string, any> =>
                        each !== null &&
                        typeof each === "object" &&
                        typeof (each as any).product === "string",
                )
                .map(
                    (each) =>
                        `${spaced(each.product)} ${Math.round(percentOf(each.usagePercent))}%`,
                );

            if (products.length > 0) {
                notes.push(`Of the pool: ${products.join(", ")}.`);
            }

            const cap = percentOf(config.onDemandCap?.val);

            notes.push(cap > 0 ? `Pay as you go: up to ${cap} credits.` : "Pay as you go is off.");

            return { id: "xai", name, ok: true, limits, notes };
        } catch (error) {
            return { id: "xai", name, ok: false, error: failed(error) };
        }
    }

    /** Z.ai's GLM Coding Plan, from Pi's Z.ai key. Without one, the page leaves Z.ai out. */
    async function zai(signal: AbortSignal): Promise<Report | undefined> {
        const name = "Z.ai (GLM Coding Plan)";

        try {
            const found = await signIn("zai", signal);

            if (found === undefined) {
                return undefined;
            }

            const headers = { authorization: `Bearer ${found.key}`, accept: "application/json" };
            // The plan's name is a nice to have: when it cannot be read, the limits still show.
            const product = fetch(ZAI_PLANS, { headers, redirect: "error", signal })
                .then((response) => (response.ok ? response.json() : undefined))
                .then((plans: { data?: unknown } | undefined) => {
                    const list = Array.isArray(plans?.data) ? plans.data : [];
                    const plan =
                        list.find(
                            (each: any) =>
                                each?.status === "VALID" && each?.inCurrentPeriod === true,
                        ) ?? list[0];

                    return plan?.productName;
                })
                .catch(() => undefined);
            const response = await fetch(ZAI_QUOTA, { headers, redirect: "error", signal });

            if (!response.ok) {
                throw answered(response.status);
            }

            const body = (await response.json()) as Record<string, any>;

            // A key with no coding plan gets 200 with success false, and a message that names the plan.
            if (body.success === false) {
                throw new Said(
                    String(body.msg ?? "")
                        .toLowerCase()
                        .includes("coding plan")
                        ? "This key has no GLM Coding Plan: subscribe at z.ai/subscribe."
                        : "It refused to read the quota.",
                );
            }

            const data = body.data ?? body;
            const entries = (Array.isArray(data.limits) ? data.limits : []).filter(
                (each: unknown): each is Record<string, any> =>
                    each !== null && typeof each === "object",
            );
            const limits: Limit[] = [];
            const counts: Limit[] = [];
            const notes: string[] = [];

            for (const entry of entries) {
                const type = entry.type ?? entry.name;
                const window = zaiWindow(entry.unit, entry.number);

                if (window === undefined) {
                    continue;
                }

                if (type === "TOKENS_LIMIT" || type === "CREDIT_LIMIT") {
                    const percent = percentOf(entry.percentage);

                    limits.push({
                        label: window,
                        percent,
                        ...resetOfMs(entry.nextResetTime),
                        level: levelOf(percent),
                    });
                } else if (type === "TIME_LIMIT") {
                    // Web search, web reader, and Zread calls: a count, not tokens.
                    const used = percentOf(entry.currentValue);
                    const total = percentOf(entry.usage);
                    const percent =
                        entry.percentage === undefined && total > 0
                            ? (used / total) * 100
                            : percentOf(entry.percentage);

                    counts.push({
                        label: `Web tools, ${used}/${total}`,
                        percent,
                        ...resetOfMs(entry.nextResetTime),
                        level: levelOf(percent),
                    });
                    notes.push(
                        `Web tools: web search, web reader, and Zread calls, for each ${window.toLowerCase()}.`,
                    );
                }
            }

            const plan = await product;

            return {
                id: "zai",
                name,
                ok: true,
                // The token windows first: they are what holds the work back.
                limits: [...limits, ...counts],
                notes: [
                    typeof plan === "string" && plan.trim() !== ""
                        ? `${plan.trim()}, from Pi's Z.ai key.`
                        : "From Pi's Z.ai key.",
                    ...notes,
                ],
            };
        } catch (error) {
            return { id: "zai", name, ok: false, error: failed(error) };
        }
    }

    /**
     * MiniMax's Coding Plan, from Pi's MiniMax key: text ("general") and each other lane, in its short window and its
     * week. A standard key (`sk-api-`) pays as it goes, and has no plan: then, and without a key, the page leaves
     * MiniMax out.
     */
    async function miniMax(signal: AbortSignal): Promise<Report | undefined> {
        const name = "MiniMax (Coding Plan)";

        try {
            const found = await signIn("minimax", signal);

            if (found === undefined || found.key.startsWith("sk-api-")) {
                return undefined;
            }

            const response = await fetch(MINIMAX_REMAINS, {
                headers: { authorization: `Bearer ${found.key}`, accept: "application/json" },
                redirect: "error",
                signal,
            });

            if (!response.ok) {
                throw answered(response.status);
            }

            const body = (await response.json()) as Record<string, any>;
            const code = body.base_resp?.status_code;

            if (code !== 0) {
                throw new Said(
                    code === 1004
                        ? "It refused the key: sign in again in Menu → Providers."
                        : `It refused to read the plan (code ${Number(code) || "unknown"}).`,
                );
            }

            const lanes = (Array.isArray(body.model_remains) ? body.model_remains : []).filter(
                (each: unknown): each is Record<string, any> =>
                    each !== null && typeof each === "object",
            );
            const limits: Limit[] = [];
            const others: Limit[] = [];
            const notes = ["From Pi's MiniMax key."];

            for (const lane of lanes) {
                const text = lane.model_name === "general";
                const prefix = text ? "" : `${capitalized(String(lane.model_name ?? "other"))}, `;

                for (const window of [
                    {
                        start: lane.start_time,
                        end: lane.end_time,
                        total: lane.current_interval_total_count,
                        remaining: lane.current_interval_usage_count,
                        left: lane.current_interval_remaining_percent,
                        status: lane.current_interval_status,
                    },
                    {
                        start: lane.weekly_start_time,
                        end: lane.weekly_end_time,
                        total: lane.current_weekly_total_count,
                        remaining: lane.current_weekly_usage_count,
                        left: lane.current_weekly_remaining_percent,
                        status: lane.current_weekly_status,
                    },
                ]) {
                    const minutes = Math.round(
                        (Number(window.end) - Number(window.start)) / 60_000,
                    );

                    if (!(minutes > 0)) {
                        continue;
                    }

                    const label = windowLabel(minutes);

                    // Status 3 with nothing in it: a lane the plan leaves out, or (for text in a week) no limit at all.
                    if (
                        window.status === 3 &&
                        !(Number(window.total) > 0) &&
                        Number(window.left) >= 100
                    ) {
                        if (text && label === "Week") {
                            notes.push("Text has no weekly limit.");
                        }

                        continue;
                    }

                    // `usage_count` holds what is left, not what is used: the percent left is the surer field.
                    const used =
                        typeof window.left === "number"
                            ? 100 - window.left
                            : Number(window.total) > 0
                              ? ((Number(window.total) - Number(window.remaining)) /
                                    Number(window.total)) *
                                100
                              : undefined;

                    if (used === undefined || !Number.isFinite(used)) {
                        continue;
                    }

                    const percent = Math.min(100, percentOf(used));

                    (text ? limits : others).push({
                        label: prefix + label,
                        percent,
                        ...resetOfMs(Number(window.end)),
                        level: levelOf(percent),
                    });
                }
            }

            // Text first: it is what the work runs on.
            return { id: "minimax", name, ok: true, limits: [...limits, ...others], notes };
        } catch (error) {
            return { id: "minimax", name, ok: false, error: failed(error) };
        }
    }

    async function deepSeek(signal: AbortSignal): Promise<Report | undefined> {
        const name = "DeepSeek";

        try {
            const key = (await signIn("deepseek", signal))?.key;

            // It is a prepaid account, not a subscription: its card shows only when Pi can read the key.
            if (key === undefined) {
                return undefined;
            }

            const response = await fetch("https://api.deepseek.com/user/balance", {
                headers: { authorization: `Bearer ${key}` },
                redirect: "error",
                signal,
            });

            if (!response.ok) {
                throw answered(response.status);
            }

            const data = (await response.json()) as Record<string, any>;
            const infos = (Array.isArray(data.balance_infos) ? data.balance_infos : []).filter(
                (info: unknown): info is Record<string, any> =>
                    info !== null && typeof info === "object" && !Array.isArray(info),
            );
            const main = infos.find((info) => info.currency === "CNY") ?? infos[0];

            if (main === undefined) {
                throw new Said("The answer named no balance.");
            }

            const total = amountOf(main.total_balance);

            return {
                id: "deepseek",
                name,
                ok: true,
                limits: [],
                notes: [],
                balance: {
                    currency: typeof main.currency === "string" ? main.currency : "",
                    total,
                    granted: amountOf(main.granted_balance),
                    toppedUp: amountOf(main.topped_up_balance),
                    enough:
                        data.is_available === true || (data.is_available !== false && total > 0),
                },
            };
        } catch (error) {
            return { id: "deepseek", name, ok: false, error: failed(error) };
        }
    }

    /** Every service at once, each on its own: one that fails leaves the others' answers. */
    const read = async () => {
        const signal = AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), alive.signal]);
        const reports = (
            await Promise.all([
                claude(signal),
                chatGpt(signal),
                openCodeGo(signal),
                grok(signal),
                zai(signal),
                miniMax(signal),
                deepSeek(signal),
            ])
        )
            .filter((report): report is Report => report !== undefined)
            // The plans that answered first, each group in its own order: what failed goes to the end.
            .sort((a, b) => Number(b.ok) - Number(a.ok));

        last = { at: Date.now(), reports };

        return last;
    };

    /**
     * The last answer while it is fresh, else a new read: one at a time, shared by the page, the command, and the
     * status line. `maxAge` lets the status line accept an older reading, so it asks the services less often.
     */
    const usage = (fresh: boolean, maxAge = FRESH_MS) => {
        const age = last === undefined ? Infinity : Date.now() - last.at;

        if (last !== undefined && (age < MIN_GAP_MS || (!fresh && age < maxAge))) {
            return Promise.resolve(last);
        }

        pending ??= read().finally(() => {
            pending = undefined;
        });

        return pending;
    };

    // GET /api/x/subscription-usage/usage, and ?fresh=1 to ask again now. The owner's alone (the default).
    web.route("GET", "usage", ({ query }) => usage(query.get("fresh") === "1"));

    // GET /api/x/subscription-usage/quota/:source: the quota of the plan that the model in that session belongs to.
    // The model comes from the bound session, never from the browser. A reading up to 5 minutes old is enough, so a
    // status line that checks it often asks the services no more than every 5 minutes; ?fresh=1 reads again (the server
    // still keeps MIN_GAP_MS between reads). A provider with no report, or a report that failed, gives `report: null`.
    if (typeof web.conversationRoute === "function") {
        web.conversationRoute(
            "GET",
            "quota/:source",
            async ({ conversation, query }) => {
                const model = conversation.model;
                const mapped = model === undefined ? undefined : PROVIDER_REPORTS[model.provider];

                if (mapped === undefined) {
                    return {
                        at: last?.at ?? null,
                        model: model ?? null,
                        label: null,
                        report: null,
                    };
                }

                const data = await usage(query.get("fresh") === "1", STATUS_MAX_AGE_MS);
                const report = data.reports.find(
                    (each): each is OkReport => each.id === mapped.report && each.ok,
                );

                return {
                    at: data.at,
                    model: model ?? null,
                    label: mapped.label,
                    report: report ?? null,
                };
            },
            { conversation: "source" },
        );
    }

    // /usage-plans: the same answer as a card in the session. The owner's alone, as the page is: it reads their
    // sign-ins. The card shows to everyone in the session, as each command's card does.
    web.command("usage-plans", {
        description: "Show how much of each plan is used, and when it resets",
        scope: "global",
        handler: async (_args, ctx) => {
            const stopped = new Promise<never>((_, reject) => {
                ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), {
                    once: true,
                });
            });

            stopped.catch(() => {});

            return { type: "card", output: usageCard(await Promise.race([usage(true), stopped])) };
        },
    });
    web.client("subscription-usage");
}
