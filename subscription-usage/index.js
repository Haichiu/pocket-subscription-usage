// Subscription usage's browser module: a rail button (with the fullest limit on it once one passes 80%), a launcher
// action, and a page set like the home screen's fastfetch: a "usage@pi-pocket" card, then each plan's limits as rows of
// small squares (the home screen's color swatches) with how full each is and when it resets. The server module asks the
// services; this only shows what it says.

export const pocketApi = 1;

/** Three bars of rising height, as a 24×24 stroked path like the app's own icons. */
const BARS = "M5 20v-5M12 20V9M19 20V4M3 20h18";
/** A circle with "!" in it, for what went wrong. */
const ALERT = "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M12 7.5v5.5M12 16.5v.01";
/** How often the page reads again while it shows, and the rail's badge in the background. */
const PAGE_EVERY_MS = 60_000;
const BADGE_EVERY_MS = 5 * 60_000;
/** A reset further away than this shows its date, not only its weekday. */
const NEAR_MS = 6 * 86_400_000;
/** The words for a level that needs a look, shown in the limit's line of details. An "ok" level has none. */
const LEVEL_WORDS = { warning: "Warning", critical: "Critical" };
/** The squares in a gauge: each is 5% of a limit. */
const CELLS = 20;
/** Block art for the top of the page, drawn like the home screen's π: three bars of rising height. */
const GLYPH = [
    "              ▗██▖",
    "              ▐██▌",
    "       ▗██▖   ▐██▌",
    "       ▐██▌   ▐██▌",
    "▗██▖   ▐██▌   ▐██▌",
    "▐██▌   ▐██▌   ▐██▌",
    "▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀",
].join("\n");
/** What "In force" on a limit means. */
const IN_FORCE = "The limit that holds you back now";

/** "in 2d 4h", "in 3h 10m", "in 12m" (and "in 19d", "in 2h" with nothing after): how long until a limit resets. */
function untilThen(time) {
    const minutes = Math.max(0, Math.round((time - Date.now()) / 60_000));
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    const rest = minutes % 60;

    if (minutes === 0) {
        return "now";
    }

    return days > 0
        ? `in ${days}d${hours > 0 ? ` ${hours}h` : ""}`
        : hours > 0
          ? `in ${hours}h${rest > 0 ? ` ${rest}m` : ""}`
          : `in ${minutes}m`;
}

/** "Mon 4:08 AM" for a reset this week; "Nov 5, 2:08 AM" for one further away, where a weekday alone is not clear. */
const when = (time) =>
    new Date(time).toLocaleString(
        undefined,
        time - Date.now() > NEAR_MS
            ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
            : { weekday: "short", hour: "numeric", minute: "2-digit" },
    );

/** The fullest limit across the plans that answered, in percent. */
const fullest = (data) =>
    Math.max(
        0,
        ...(data?.reports ?? []).flatMap((report) =>
            report.ok ? report.limits.map((each) => Number(each.percent) || 0) : [],
        ),
    );

/** How many of a gauge's squares are lit: at least one for any use, and not all of them until a limit is full. */
function lit(percent) {
    if (percent <= 0) {
        return 0;
    }

    const n = Math.max(1, Math.round(percent / (100 / CELLS)));

    return percent < 100 ? Math.min(n, CELLS - 1) : CELLS;
}

/** What the card at the top says: the fullest limit, and the next reset, across the plans that answered. */
function glance(data) {
    let top = null;
    let next = null;

    for (const report of data?.reports ?? []) {
        for (const each of report.ok ? report.limits : []) {
            const percent = Number(each.percent) || 0;
            const reset = Date.parse(each.resetsAt ?? "");

            if (!top || percent > top.percent) {
                top = { percent, label: each.label, plan: report.name };
            }

            if (Number.isFinite(reset) && reset > Date.now() && (!next || reset < next.time)) {
                next = { time: reset, label: each.label, plan: report.name };
            }
        }
    }

    return { top, next };
}

export default function setup(pocket) {
    const { html, useEffect, useState, Icon, Loader, Spinner } = pocket;

    pocket.style("look.css");

    function LimitRow({ limit }) {
        const reset = Date.parse(limit.resetsAt ?? "");
        const percent = Number(limit.percent) || 0;
        const word = LEVEL_WORDS[limit.level];
        const on = lit(percent);
        const timed = Number.isFinite(reset);

        return html`<li class=${`su-limit su-${limit.level}`}>
            <span class="su-label">${limit.label}</span>
            <span class="su-gauge" aria-hidden="true">
                ${Array.from(
                    { length: CELLS },
                    (_, at) =>
                        html`<span
                            class=${at < on ? "su-cell su-on" : "su-cell"}
                            style=${`--c:${at}`}
                        ></span>`,
                )}
            </span>
            <span class="su-value"
                >${Math.round(percent)}<span class="su-unit">%</span
                ><span class="su-sr"> used</span></span
            >
            ${
                (word || limit.binding || timed) &&
                html`<p class="su-meta">
                    ${word && html`<span class=${`su-flag su-${limit.level}`}>${word}</span>`}
                    ${
                        word &&
                        (limit.binding || timed) &&
                        html`<span class="su-sep" aria-hidden="true">·</span>`
                    }
                    ${
                        limit.binding &&
                        html`<span class="su-binding" title=${IN_FORCE}>In force</span>`
                    }
                    ${
                        limit.binding &&
                        timed &&
                        html`<span class="su-sep" aria-hidden="true">·</span>`
                    }
                    ${
                        timed &&
                        html`<span class="su-when">
                            Resets <strong>${untilThen(reset)}</strong> · ${when(reset)}
                        </span>`
                    }
                </p>`
            }
        </li>`;
    }

    /** A plan's section: its limits and notes, or why it could not be read. */
    function Plan({ report, index }) {
        const head = `su-plan-${report.id}`;
        const notes = report.ok ? (report.notes ?? []) : [];

        return html`<section class="su-plan" aria-labelledby=${head} style=${`--i:${index}`}>
            <header class="su-plan-head">
                <h3 id=${head}>${report.name}</h3>
                <span class="su-rule" aria-hidden="true"></span>
                ${
                    report.ok
                        ? report.limits.length > 0 &&
                          html`<span class="su-count">
                              ${report.limits.length} limit${report.limits.length === 1 ? "" : "s"}
                          </span>`
                        : html`<span class="su-flag su-failed">Unavailable</span>`
                }
            </header>
            ${
                report.ok
                    ? html`${
                          report.limits.length === 0
                              ? html`<p class="su-empty">No limits reported.</p>`
                              : html`<ul class="su-limits" role="list">
                                    ${report.limits.map(
                                        (limit, at) =>
                                            html`<${LimitRow} key=${at} limit=${limit} />`,
                                    )}
                                </ul>`
                      }
                      ${
                          notes.length > 0 &&
                          html`<div class="su-notes">
                              ${notes.map((note) => html`<p>${note}</p>`)}
                          </div>`
                      }`
                    : html`<p class="su-problem">
                          <${Icon} path=${ALERT} size=${15} />
                          <span>${report.error}</span>
                      </p>`
            }
        </section>`;
    }

    /** The page: loading, then one list of plans, or what went wrong, with Refresh. Reads again every minute. */
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
                <div class="su-state" role="alert">
                    <${Icon} path=${ALERT} size=${16} />
                    <div class="su-state-text">
                        <p class="su-state-title">Could not read your usage</p>
                        <p class="su-state-detail">${error}</p>
                    </div>
                </div>
                <div class="su-actions">
                    <button
                        class="button small"
                        aria-disabled=${busy ? "true" : "false"}
                        onClick=${() => !busy && load(true)}
                    >
                        ${busy ? "Trying again…" : "Try again"}
                    </button>
                </div>
            </div>`;
        }

        if (!data) {
            return html`<div class="su" aria-busy="true">
                <${Loader} label="Asking your plans" />
            </div>`;
        }

        const read = new Date(data.at);
        const stamp = read.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
        const iso = Number.isFinite(read.getTime()) ? read.toISOString() : undefined;
        const { top, next } = glance(data);

        return html`<div class="su" aria-busy=${busy ? "true" : undefined}>
            <div class="su-fetch">
                <pre class="su-glyph" aria-hidden="true">${GLYPH}</pre>
                <div class="su-info">
                    <div class="su-title">
                        <span class="su-host"><b>usage</b>@pi-pocket</span>
                        <button
                            class="button small su-refresh"
                            aria-disabled=${busy ? "true" : "false"}
                            onClick=${() => !busy && load(true)}
                        >
                            ${
                                busy
                                    ? html`<span class="su-spin" aria-hidden="true"
                                          ><${Spinner}
                                      /></span>`
                                    : html`<${Icon} name="reload" size=${14} />`
                            }
                            ${busy ? "Refreshing…" : "Refresh"}
                        </button>
                    </div>
                    <dl class="su-rows">
                        <div class="su-row" style="--i:1">
                            <dt>read</dt>
                            <dd><time datetime=${iso}>${stamp}</time></dd>
                        </div>
                        ${
                            top &&
                            html`<div class="su-row" style="--i:2">
                                <dt>fullest</dt>
                                <dd>
                                    <b>${Math.round(top.percent)}%</b>
                                    <span class="su-quiet">${" "}· ${top.label}, ${top.plan}</span>
                                </dd>
                            </div>`
                        }
                        ${
                            next &&
                            html`<div class="su-row" style="--i:3">
                                <dt>resets</dt>
                                <dd>
                                    <b>${untilThen(next.time)}</b>
                                    <span class="su-quiet"
                                        >${" "}· ${next.label}, ${next.plan}</span
                                    >
                                </dd>
                            </div>`
                        }
                    </dl>
                    ${
                        top &&
                        html`<div class="su-key" style="--i:4" aria-hidden="true">
                            <span class="su-swatch"></span>ok
                            <span class="su-swatch su-warning"></span>warning
                            <span class="su-swatch su-critical"></span>critical
                        </div>`
                    }
                </div>
            </div>
            ${
                error &&
                html`<p class="error-box small" role="alert">Could not refresh: ${error}</p>`
            }
            ${
                data.reports.length === 0
                    ? html`<p class="su-empty">No plans reported.</p>`
                    : data.reports.map(
                          (report, at) =>
                              html`<${Plan} key=${report.id} report=${report} index=${at + 2} />`,
                      )
            }
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
        detail: "Claude, ChatGPT, OpenCode Go, Grok, Z.ai, and MiniMax limits",
        iconPath: BARS,
        keywords: [
            "anthropic",
            "claude",
            "openai",
            "chatgpt",
            "codex",
            "opencode",
            "grok",
            "xai",
            "zai",
            "glm",
            "minimax",
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
