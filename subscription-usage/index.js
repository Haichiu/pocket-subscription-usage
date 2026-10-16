// Subscription usage's browser module: a rail button (with the fullest limit on it once one passes 80%), a launcher
// action, and a page with each plan's limits, how full each is, and when it resets. The server module asks the
// services; this only shows what it says.

export const pocketApi = 1;

/** Three bars of rising height, as a 24×24 stroked path like the app's own icons. */
const BARS = "M5 20v-5M12 20V9M19 20V4M3 20h18";
/** How often the page reads again while it shows, and the rail's badge in the background. */
const PAGE_EVERY_MS = 60_000;
const BADGE_EVERY_MS = 5 * 60_000;

/** "in 2d 4h", "in 3h 10m", "in 12m": how long until a limit resets. */
function untilThen(time) {
    const minutes = Math.max(0, Math.round((time - Date.now()) / 60_000));
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);

    if (minutes === 0) {
        return "now";
    }

    return days > 0
        ? `in ${days}d ${hours}h`
        : hours > 0
          ? `in ${hours}h ${minutes % 60}m`
          : `in ${minutes}m`;
}

const when = (time) =>
    new Date(time).toLocaleString(undefined, {
        weekday: "short",
        hour: "numeric",
        minute: "2-digit",
    });

/** The fullest limit across the plans that answered, in percent. */
const fullest = (data) =>
    Math.max(
        0,
        ...(data?.reports ?? []).flatMap((report) =>
            report.ok ? report.limits.map((each) => Number(each.percent) || 0) : [],
        ),
    );

export default function setup(pocket) {
    const { html, useEffect, useState, Loader } = pocket;

    pocket.style("look.css");

    function LimitRow({ limit }) {
        const reset = Date.parse(limit.resetsAt ?? "");

        return html`<div class=${`su-row su-${limit.level}`}>
            <span class="su-label">
                ${limit.label}${limit.binding ? html` <span class="su-binding">· the one in force</span>` : ""}
            </span>
            <span class="su-percent">${Math.round(limit.percent)}%</span>
            <span class="su-bar" aria-hidden="true">
                <span style=${`width:${Math.min(100, Math.max(0, limit.percent))}%`}></span>
            </span>
            ${
                Number.isFinite(reset) &&
                html`<span class="su-reset">Resets ${untilThen(reset)} · ${when(reset)}</span>`
            }
        </div>`;
    }

    function PlanCard({ report }) {
        return html`<section class="su-card">
            <h3>${report.name}</h3>
            ${
                report.ok
                    ? html`${report.limits.length === 0 ? html`<p class="muted small">No limits reported.</p>` : ""}
                      ${report.limits.map((limit) => html`<${LimitRow} limit=${limit} />`)}
                      ${(report.notes ?? []).map((note) => html`<p class="muted small">${note}</p>`)}`
                    : html`<div class="error-box small">${report.error}</div>`
            }
        </section>`;
    }

    /** The page: loading, then a card per plan, or what went wrong, with Refresh. Reads again every minute. */
    function Usage() {
        const [data, setData] = useState(null);
        const [error, setError] = useState(null);
        const [busy, setBusy] = useState(false);

        const load = async (fresh, signal) => {
            setBusy(true);

            try {
                const next = await pocket.api(`usage${fresh ? "?fresh=1" : ""}`, undefined, {
                    signal,
                });

                setData(next);
                setError(null);
                badge(next);
            } catch (failure) {
                if (!signal?.aborted) {
                    setError(failure.message);
                }
            } finally {
                if (!signal?.aborted) {
                    setBusy(false);
                }
            }
        };

        useEffect(() => {
            const stop = new AbortController();

            void load(false, stop.signal);
            const timer = setInterval(() => void load(false, stop.signal), PAGE_EVERY_MS);

            return () => {
                stop.abort();
                clearInterval(timer);
            };
        }, []);

        if (!data && error) {
            return html`<div class="su">
                <div class="error-box">${error}</div>
                <div><button class="button" onClick=${() => load(true)}>Try again</button></div>
            </div>`;
        }

        if (!data) {
            return html`<${Loader} label="Asking Claude, ChatGPT, and OpenCode Go" />`;
        }

        return html`<div class="su">
            ${data.reports.map((report) => html`<${PlanCard} report=${report} />`)}
            ${error && html`<div class="error-box small">${error}</div>`}
            <div class="su-foot">
                <button class="button" disabled=${busy} onClick=${() => load(true)}>
                    ${busy ? "Refreshing…" : "Refresh"}
                </button>
                <span class="muted small">Read at ${new Date(data.at).toLocaleTimeString()}</span>
            </div>
        </div>`;
    }

    const rail = pocket.rail({
        id: "usage",
        title: "Subscription usage",
        iconPath: BARS,
        page: "usage",
    });

    /** The rail's button shows the fullest limit once one passes 80%. */
    function badge(data) {
        const top = Math.round(fullest(data));

        rail.update({ badge: top >= 80 ? top : null });
    }

    pocket.page({ id: "usage", title: "Subscription usage", component: Usage });
    pocket.launcher({
        id: "usage",
        label: "Subscription usage",
        detail: "Claude, ChatGPT, and OpenCode Go limits",
        iconPath: BARS,
        keywords: [
            "anthropic",
            "claude",
            "openai",
            "chatgpt",
            "codex",
            "opencode",
            "quota",
            "limits",
            "usage",
        ],
        page: "usage",
    });

    // A reading in the background for the badge, while this tab is open; the server keeps answers a minute.
    const check = () =>
        pocket.api("usage").then(
            (data) => {
                try {
                    badge(data);
                } catch {
                    // A badge that cannot be drawn waits for the next reading.
                }
            },
            () => {},
        );
    const timer = setInterval(check, BADGE_EVERY_MS);

    void check();
    pocket.onDispose(() => clearInterval(timer));
}
