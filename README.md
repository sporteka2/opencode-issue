# opencode-issue

OpenCode plugin that turns a natural-language request into a proper issue — with a browser preview, AI duplicate detection and translation.

Write the issue in Russian, get a readable issue in your repository — in English, or in whatever language you choose.

```
"создай ишью: заголовок 'Утечка памяти в кэше', описание 'шаги: 1) открыть ... 2) ...'"
        │
        ▼
  ┌─ detect repository ─────── git remote / gh repo view / explicit owner+repo
  ├─ list existing issues ──── gh api /repos/OWNER/REPO/issues (REST, no token needed)
  ├─ AI duplicate check ────── current model → similarity + recommendation
  ├─ translate ─────────────── ru → en (translatedTitle / translatedBody)
  ├─ preview ───────────────── HTML page with RU / EN / Duplicates tabs + confirm
  └─ create ────────────────── gh issue create  │  tea issues create
```

## Features

- **One tool, one request** — `issue_create` takes `title` and `body`; the agent supplies them from conversation.
- **AI duplicate detection** — fetches existing issues via the REST API (works anonymously for public repos) and asks the model to compare. Returns per-issue `similarity` (`exact` / `high` / `medium`), a `recommendation` (`skip` / `review` / `create`) and a `confidence`.
- **Translation** — the title and body are translated to the submission language before the issue is created, so you keep writing in Russian while the repository stays English.
- **Browser preview** — renders a local HTML page with side-by-side `RU` / `EN` tabs and a `Дубликаты` tab with similarity percentages and colours. The issue is created only after confirmation.
- **Two platforms** — GitHub via `gh`, Codeberg (Gitea) via `tea`, including the correct flags for each (`--description` / comma-separated `--labels`, `--assignees` for `tea`; repeatable `--label`, `--assignee` for `gh`).
- **Works without configuration** — sensible defaults; the `OPENCODE_ISSUE_CONFIG` environment variable only overrides them.

## Requirements

| Requirement | Needed for | Notes |
|---|---|---|
| [OpenCode](https://opencode.ai) 2.x | always | the plugin host |
| `gh` | GitHub issues | authenticated, or set `GH_TOKEN` / `GITHUB_TOKEN` |
| `tea` | Codeberg issues | `tea login` |
| a browser (`xdg-open`) | preview + confirmation | set `preview: false` to skip |

GitLab is **not** supported — only GitHub and Codeberg.

## Installation

### From a repository clone (development)

Clone somewhere on disk and link the plugin source into OpenCode's plugin directory:

```bash
git clone https://github.com/sporteka2/opencode-issue.git
cd opencode-issue
npm install
npm run build

ln -s "$(pwd)/src/index.ts" ~/.opencode/plugin/issue-creator.ts
```

Confirm it is picked up — run `opencode plugin list` **from your home directory** (`opencode plugin list` depends on the working directory):

```
ID              VERSION  SOURCE
issue-creator   local    /home/user/.opencode/plugin/issue-creator.ts
```

### As a linked npm package

```bash
cd opencode-issue
npm install
npm link
cd ~/.opencode
npm link opencode-issue        # the package name, not `opencode-issue-plugin`
ln -s ../node_modules/opencode-issue/src/index.ts plugin/issue-creator.ts
```

> The `link` script in `package.json` says `npm link opencode-issue-plugin`, but the package is named `opencode-issue`. The two commands above are the working equivalent.

### After editing the source

OpenCode caches the compiled plugin module in the server process. Editing `src/index.ts` does **not** hot-reload — restart your TUI instance (`Ctrl+C` → `opencode`) before testing a change.

## Usage

Just ask the agent in plain language:

> создай ишью: заголовок "Утечка памяти в кэше", описание "шаги воспроизведения: ..."

Or address the tool explicitly when you need guarantees:

> используй инструмент `issue_create` с title=…, body=…, preview=false

### Tool parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `title` | string | ✅ | Issue title, any language (Russian by default) |
| `body` | string | ✅ | Issue body, any language |
| `labels` | string[] | | Labels to attach |
| `assignees` | string[] | | Assignees to attach |
| `preview` | boolean | | Show the HTML preview and ask for confirmation. Default `true` |
| `owner` | string | | Repository owner, if the current directory is not a git repository |
| `repo` | string | | Repository name |
| `platform` | `"github"` \| `"codeberg"` | | Overrides platform auto-detection |

## Configuration

Everything works from defaults. To change behaviour, set `OPENCODE_ISSUE_CONFIG` to JSON — it is merged over the defaults:

```bash
export OPENCODE_ISSUE_CONFIG='{
  "duplicateCheck": true,
  "checkClosed": true,
  "previewLanguage": "ru",
  "submitLanguage": "en"
}'
```

| Option | Default | Description |
|---|---|---|
| `duplicateCheck` | `true` | Run the AI duplicate check |
| `checkClosed` | `true` | Search all issues (`false` → open only) |
| `checkModel` | — | `{ providerID, id }` of the model used for the check. **Omitted → the server's current model** |
| `previewLanguage` | `ru` | Language the preview is rendered in |
| `submitLanguage` | `en` | Language the issue is submitted in |

`owner`, `repo` and `platform` may also be set through `OPENCODE_ISSUE_CONFIG` as a fallback when repository detection fails.

### Custom duplicate-check prompt

By default the check uses a built-in Russian instruction (compare with existing issues, rate similarity, recommend `skip` / `review` / `create`, translate to the submission language, answer with raw JSON only).

To use your own, create `<project>/.opencode/instructions/issue-duplicate-check.md`. The following placeholders are substituted:

| Placeholder | Value |
|---|---|
| `${owner}` | Repository owner |
| `${repo}` | Repository name |
| `${platform}` | `github` or `codeberg` |
| `${previewLanguage}` | Preview language |
| `${submitLanguage}` | Submission language |

An example ships in `.opencode/instructions/issue-duplicate-check.md`.

## Development

```bash
npm install
npm run build        # tsc → dist/
npm run dev          # tsc --watch
```

`src/opencode-plugin.d.ts` declares the `@opencode/plugin` module, which OpenCode injects at load time and which therefore cannot be resolved by `tsc` on its own. Without that file the build fails with `TS2307: Cannot find module '@opencode/plugin'`.

The compiled output is ESM (`"type": "module"`).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `gh issue create` returns `HTTP 401 Requires authentication` | The token in the keyring is unavailable to a headless process. Export `GH_TOKEN` / `GITHUB_TOKEN`, or create the issue from an interactive terminal. |
| `gh api` returns `HTTP 401` in the same run | Querying `gh api` anonymously works for **public** repositories only. |
| Changes to `src/index.ts` seem ignored | The module is cached in the server process — restart the TUI instance. |
| `opencode plugin list` prints `No plugins found` | Run it from your home directory; plugin discovery is working-directory relative. |
| No repository detected | Pass `owner` / `repo`, run inside a git repository with a remote, or set them in `OPENCODE_ISSUE_CONFIG`. |

## License

MIT

---

## По-русски (кратко)

Плагин для OpenCode: создаёт issue из русского заголовка и описания, проверяет дубликаты через AI, переводит на английский, показывает превью в браузере с вкладками RU / EN / Дубликаты и ждёт подтверждения.

**Установка:** `git clone` → `npm install` → `npm run build` → симлинк `~/.opencode/plugin/issue-creator.ts` на `src/index.ts`. Проверить: `opencode plugin list` из домашнего каталога.

**Использование:** просто скажи агенту «создай ишью: заголовок ..., описание ...», либо явно «используй инструмент `issue_create`».

**Настройка:** необязательна — `OPENCODE_ISSUE_CONFIG` (JSON) переопределяет дефолты: `duplicateCheck`, `checkClosed`, `checkModel` (если не задан — берётся текущая модель сессии), `previewLanguage: "ru"`, `submitLanguage: "en"`. Своя инструкция для проверки дубликатов — `<проект>/.opencode/instructions/issue-duplicate-check.md`.

**Важно:** GitHub → `gh`, Codeberg → `tea` (два разных набора флагов). В фоновом/headless-контексте `gh` может отдать 401 из-за keyring — тогда `export GH_TOKEN=...`. Правки `src/index.ts` подхватываются только после перезапуска TUI.
