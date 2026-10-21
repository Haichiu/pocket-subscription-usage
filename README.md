# Subscription usage

A drop-in extension for [Pi Pocket](https://github.com/TannerMidd/pi-pocket). It adds a page to the rail. The page shows how much of your Claude, ChatGPT (Codex), OpenCode Go, Grok, and Z.ai plans you used, and when each limit resets.

## Install

In Pi Pocket 0.14 or newer, open **Menu → Extensions → Find extensions**, and find **Subscription usage**. The gallery installs it turned off. Read its source, or ask Pi to review it. Then turn it on in **Menu → Extensions**.

You can also copy these files into the extensions folder of Pi Pocket (`~/.pi-pocket/extensions/`), with the same names:

- `subscription-usage.ts`
- `subscription-usage/index.js`
- `subscription-usage/look.css`

## What it does

- **On the server:** it adds one route, `GET usage`, for the owner only. The route asks each service for your usage:
    - Claude and OpenCode Go: with the sign-ins that Pi already has on this computer.
    - ChatGPT (Codex): it starts the Codex CLI (`codex app-server`), which uses its own sign-in. The Codex CLI must be installed and signed in (`codex login`).
    - Grok: with Pi's xAI sign-in for SuperGrok or X Premium (Menu → Providers). It reads the shared weekly pool, as the Grok CLI does. An xAI API key has no plan, so the page leaves Grok out.
    - Z.ai: with Pi's Z.ai key, for a GLM Coding Plan. It reads the 5-hour (and, on bigger plans, weekly) token windows and the monthly count of web search, web reader, and Zread calls. Without a Z.ai key, the page leaves Z.ai out.
- **In the browser:** it adds a page and a rail button, for the owner only. The page shows the usage. No key or token goes to the browser.

It runs no tools and changes nothing in your sessions.

## License

MIT
