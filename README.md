# pi-ollama-usage

Ollama Cloud usage monitor extension for [pi coding agent](https://github.com/earendil-works/pi-mono).

Displays Ollama Cloud 5-hour and weekly quota usage in pi's footer in real time. Also provides a `/ollama` command and `ollama_usage` tool for LLM-callable quota checks.

## Features

- **Footer integration**: Replaces pi's footer with token stats + `5h:xx% Wk:xx%` usage with exclamation mark alerts for over-consumption
- **`/ollama` command**: Detailed bar chart view with reset countdowns
- **`ollama_usage` tool**: LLM can proactively check remaining quota before expensive operations
- **Auto-activates**: Only takes over the footer when using an ollama-cloud provider model — doesn't affect other providers

## Install

```bash
pi install git:github.com/inouemoby/pi-ollama-usage
```

Or via `settings.json`:

```json
{
  "packages": ["git:github.com/inouemoby/pi-ollama-usage@main"]
}
```

## Login

Run in pi:

```
/ollama-login
```

Enter your Ollama Cloud `aid` and `__Secure-session` cookie values when prompted.

Or set via environment variable:

```bash
export OLLAMA_CLOUD_SESSION="aid=xxx; __Secure-session=xxx"
```

To get your cookies: open [ollama.com](https://ollama.com) in a browser, log in, then go to DevTools → Application → Cookies and copy the values.

## Commands

| Command | Description |
|---------|-------------|
| `/ollama` | Show detailed usage (bar chart + percentages + reset countdown) |
| `/ollama-login` | Set cookies (interactive or command-line args) |
| `/ollama-logout` | Clear saved cookies |

## Preview

```
~/project (main) • my-session
↑303k ↓3.1k 3.8%/1.0M (auto) 5h:18.7% Wk:3.3%   (ollama-cloud) deepseek-v4-pro • medium
```

- Normal = on track
- `!` = usage above expected rate
- `!!` = usage exceeds 1.5× expected rate — critical

## License

MIT
