# Subscription usage

A drop-in extension for [Pi Pocket](https://github.com/TannerMidd/pi-pocket). It adds a page to the rail. The page shows how much of your Claude, ChatGPT (Codex), and OpenCode Go plans you used, and when each limit resets. When Pi has a DeepSeek key, it also shows the DeepSeek balance, in money left rather than a percentage.

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
    - DeepSeek: with the API key that Pi has, it asks [`GET /user/balance`](https://api-docs.deepseek.com/api/get-user-balance) for the money left, whether the key can take calls, and what makes up the balance (granted and topped up). Its card shows only when Pi has a DeepSeek key, so an account that does not use DeepSeek sees no card.
- **In the browser:** it adds a page and a rail button, for the owner only. The page shows the usage, and the DeepSeek balance. No key or token goes to the browser.

It runs no tools and changes nothing in your sessions.

## License

MIT
