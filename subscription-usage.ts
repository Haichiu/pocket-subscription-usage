/**
 * Subscription usage: a page on the rail with how much of your Claude, ChatGPT (Codex), and OpenCode Go plans is
 * used, and when each limit resets, plus the DeepSeek balance when Pi has a DeepSeek key. The server asks each service
 * with the sign-ins already on this machine, so no key or token reaches the browser.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
// A type import is gone when the module runs: only the type checker reads this path.
import type { ExtensionWeb } from "/mnt/games/Development/pi-pocket/src/server/host.ts";

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

/** How long each service may take to answer. */
const TIMEOUT_MS = 15_000;
/** An answer is kept this long: tabs that look at the same time share one call to each service. */
const FRESH_MS = 60_000;
/** Refresh asks the services again, but not more often than this. */
const MIN_GAP_MS = 10_000;

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

export default function createSubscriptionUsage(_host: unknown, web: ExtensionWeb) {
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

    /** The provider's key, or nothing when Pi has no sign-in for it. */
    const keyOrNone = async (provider: string, signal: AbortSignal) => {
        const found = await (await models()).getAuth(provider, { signal });
        const key = found?.auth.apiKey;

        return typeof key === "string" && key !== "" ? key : undefined;
    };

    const credential = async (provider: string, signal: AbortSignal) => {
        const key = await keyOrNone(provider, signal);

        if (key === undefined) {
            throw new Said("Pi is not signed in to it: sign in under Menu → Providers.");
        }

        return key;
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

    async function deepSeek(signal: AbortSignal): Promise<Report | undefined> {
        const name = "DeepSeek";

        try {
            const key = await keyOrNone("deepseek", signal);

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
                        data.is_available === true ||
                        (data.is_available !== false && total > 0),
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
                deepSeek(signal),
            ])
        ).filter((report): report is Report => report !== undefined);

        last = { at: Date.now(), reports };

        return last;
    };

    // GET /api/x/subscription-usage/usage, and ?fresh=1 to ask again now. The owner's alone (the default).
    web.route("GET", "usage", ({ query }) => {
        const age = last === undefined ? Infinity : Date.now() - last.at;

        if (
            last !== undefined &&
            (age < MIN_GAP_MS || (query.get("fresh") !== "1" && age < FRESH_MS))
        ) {
            return last;
        }

        pending ??= read().finally(() => {
            pending = undefined;
        });

        return pending;
    });
    web.client("subscription-usage");
}
