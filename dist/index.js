import { Plugin } from "@opencode/plugin";
import { writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
export default Plugin.define({
    id: "issue-creator",
    setup: async (ctx) => {
        const directory = ctx.location.directory;
        async function run(cmd, args) {
            const { stdout } = await execFileAsync(cmd, args, {
                cwd: directory,
                maxBuffer: 10 * 1024 * 1024,
            });
            return stdout;
        }
        // Значения по умолчанию: без переменной окружения инструмент тоже работает.
        // checkModel не задан — generate.text возьмёт текущую базовую модель сервера.
        const DEFAULT_ISSUE_OPTIONS = {
            duplicateCheck: true,
            checkClosed: true,
            previewLanguage: "ru",
            submitLanguage: "en",
        };
        async function getIssueOptions() {
            const config = process.env.OPENCODE_ISSUE_CONFIG;
            if (!config)
                return DEFAULT_ISSUE_OPTIONS;
            try {
                return { ...DEFAULT_ISSUE_OPTIONS, ...JSON.parse(config) };
            }
            catch {
                return DEFAULT_ISSUE_OPTIONS;
            }
        }
        async function getRepoInfo(explicit) {
            if (explicit?.owner && explicit?.repo) {
                return { owner: explicit.owner, repo: explicit.repo, platform: explicit.platform ?? "github" };
            }
            try {
                const url = (await run("git", ["remote", "get-url", "origin"])).trim();
                let platform = "github";
                if (url.includes("codeberg.org") || url.includes("gitea")) {
                    platform = "codeberg";
                }
                const match = url.match(/[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
                if (match) {
                    return { owner: match[1], repo: match[2], platform };
                }
            }
            catch {
                // ignore
            }
            // Запасной вариант: gh сам определяет репозиторий (даже если git remote не origin).
            try {
                const out = (await run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])).trim();
                const match = out.match(/^([^/]+)\/([^/]+)$/);
                if (match) {
                    return { owner: match[1], repo: match[2], platform: "github" };
                }
            }
            catch {
                // ignore
            }
            // Последний запасной вариант: owner/repo в OPENCODE_ISSUE_CONFIG.
            try {
                const config = process.env.OPENCODE_ISSUE_CONFIG;
                if (config) {
                    const parsed = JSON.parse(config);
                    if (parsed.owner && parsed.repo) {
                        return { owner: parsed.owner, repo: parsed.repo, platform: parsed.platform === "codeberg" ? "codeberg" : "github" };
                    }
                }
            }
            catch {
                // ignore
            }
            return null;
        }
        // Резервная инструкция, если в проекте нет .opencode/instructions/issue-duplicate-check.md.
        const DEFAULT_DUPLICATE_CHECK_INSTRUCTION = `Ты проверяешь новое ишью на дубликаты перед созданием.

Тебе дан список существующих ишью репозитория и новое ишью (заголовок + описание).

1. Сравни новое ишью с существующими. Дубликат — та же проблема по смыслу, даже если слова другие.
2. Для каждого дубликата укажи similarity: "exact" (то же самое), "high" (то же почти), "medium" (похоже).
3. Итоговая рекомендация: "skip" — точный дубликат, создавать не надо; "review" — похоже, стоит проверить глазами; "create" — дубликатов нет.
4. Переведи заголовок и описание на язык отправки (submitLanguage) — именно этот текст уйдёт в ишью.

Отвечай ТОЛЬКО JSON, без markdown-ограды и без комментариев.`;
        // Список существующих ишью через CLI платформы — иначе ИИ не с чем сравнивать.
        async function fetchExistingIssues(platform, owner, repo, state, limit = 50) {
            if (platform === "codeberg") {
                const out = await run("tea", [
                    "issues",
                    "list",
                    "--repo",
                    `${owner}/${repo}`,
                    "--state",
                    state,
                    "--limit",
                    String(limit),
                    "--output",
                    "json",
                ]);
                const parsed = JSON.parse(out);
                const list = Array.isArray(parsed) ? parsed : (parsed.issues ?? []);
                return list.map((i) => ({ number: i.number ?? i.index ?? 0, title: i.title, url: i.url ?? "" }));
            }
            // GitHub: REST API работает и без авторизации (публичные репозитории),
            // а `gh issue list` уходит в GraphQL, где токен обязателен.
            try {
                const out = await run("gh", [
                    "api",
                    `/repos/${owner}/${repo}/issues?state=${state}&per_page=${limit}`,
                    "--jq",
                    "[.[] | select(.pull_request == null) | {number, title, url}]",
                ]);
                return JSON.parse(out);
            }
            catch (e) {
                console.error("[opencode-issue] REST issue list failed, trying gh issue list:", e);
            }
            const out = await run("gh", [
                "issue",
                "list",
                "--repo",
                `${owner}/${repo}`,
                "--state",
                state,
                "--limit",
                String(limit),
                "--json",
                "number,title,url",
            ]);
            return JSON.parse(out);
        }
        async function loadDuplicateCheckInstruction() {
            try {
                const instruction = readFileSync(join(directory, ".opencode/instructions/issue-duplicate-check.md"), "utf-8");
                if (instruction.trim())
                    return instruction;
            }
            catch {
                // ignore — используем встроенную инструкцию
            }
            return DEFAULT_DUPLICATE_CHECK_INSTRUCTION;
        }
        async function checkDuplicatesWithAI(options, title, body, owner, repo, platform, previewLanguage, submitLanguage) {
            try {
                const state = options.checkClosed === false ? "open" : "all";
                let existing = [];
                try {
                    existing = await fetchExistingIssues(platform, owner, repo, state);
                }
                catch (e) {
                    console.error("[opencode-issue] Could not list existing issues:", e);
                }
                const instruction = (await loadDuplicateCheckInstruction())
                    .replace(/\$\{owner\}/g, owner)
                    .replace(/\$\{repo\}/g, repo)
                    .replace(/\$\{platform\}/g, platform)
                    .replace(/\$\{previewLanguage(?:\s*\|\|\s*"ru")?\}/g, previewLanguage)
                    .replace(/\$\{submitLanguage(?:\s*\|\|\s*"en")?\}/g, submitLanguage);
                const issuesBlock = existing.length
                    ? existing.map((i) => `#${i.number} ${i.title} ${i.url}`).join("\n")
                    : "(список существующих ишью недоступен — сравни только по заголовку и описанию)";
                const prompt = `${instruction}

Репозиторий: ${owner}/${repo} (${platform})
Язык предпросмотра: ${previewLanguage}
Язык отправки: ${submitLanguage}

Существующие ишью (${existing.length}):
${issuesBlock}

Новое ишью:
Заголовок: ${title}
Описание: ${body}`;
                // Если модель не задана в OPENCODE_ISSUE_CONFIG, не передаём model:
                // generate.text использует текущую базовую модель сервера.
                const result = await ctx.generate.text({
                    ...(options.checkModel ? { model: options.checkModel } : {}),
                    prompt,
                });
                // Модель иногда оборачивает ответ в ```json ... ```
                const raw = result.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
                return JSON.parse(raw);
            }
            catch (e) {
                console.error("Duplicate check failed:", e);
                return null;
            }
        }
        async function openInBrowser(file) {
            const attempts = process.platform === "darwin"
                ? [["open", [file]]]
                : process.platform === "win32"
                    ? [["cmd", ["/c", "start", "", file]]]
                    : [
                        ["xdg-open", [file]],
                        ["open", [file]],
                    ];
            for (const [cmd, args] of attempts) {
                try {
                    await execFileAsync(cmd, args, { timeout: 10000 });
                    console.log("[opencode-issue] Opened with:", cmd);
                    return true;
                }
                catch (e) {
                    console.log("[opencode-issue] Failed", cmd, e);
                }
            }
            return false;
        }
        async function showPreviewAndConfirm(context, russian, english, duplicateResult, owner, repo) {
            const html = generatePreviewHtml(russian, english, duplicateResult);
            const tempFile = join(tmpdir(), `issue-preview-${Date.now()}.html`);
            writeFileSync(tempFile, html);
            console.log("[opencode-issue] Preview file:", tempFile);
            const opened = await openInBrowser(tempFile);
            if (!opened) {
                throw new Error("Could not open browser. Please open manually: " + tempFile);
            }
            try {
                // Ask the user to approve creating the issue. Honours the configured
                // permission rules; a rejection throws and ends the current step.
                await ctx.permission.assert({
                    sessionID: context.sessionID,
                    agent: context.agent,
                    action: "issue.create",
                    resources: [`${owner}/${repo}`],
                    save: [],
                    source: { type: "tool", messageID: context.messageID, id: context.id },
                });
            }
            finally {
                try {
                    unlinkSync(tempFile);
                }
                catch {
                    // ignore
                }
            }
        }
        function generatePreviewHtml(russian, english, duplicateResult) {
            const escapeHtml = (str) => str
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#039;");
            const similarityColor = {
                exact: "#cb2431",
                high: "#d15704",
                medium: "#9a6700",
            };
            let duplicatesTab = "";
            let duplicatesContent = "";
            if (duplicateResult?.duplicates?.length) {
                duplicatesTab =
                    '<button class="tab" onclick="showTab(\'duplicates\')">🔍 Дубликаты (' +
                        duplicateResult.duplicates.length +
                        ")</button>";
                let itemsHtml = "";
                for (const d of duplicateResult.duplicates) {
                    const color = similarityColor[d.similarity] || "#9a6700";
                    itemsHtml +=
                        '<div class="section">' +
                            "<h2>#" +
                            d.number +
                            " \u2014 " +
                            escapeHtml(d.title) +
                            "</h2>" +
                            '<div style="margin-bottom: 8px;">' +
                            '<a href="' +
                            escapeHtml(d.url) +
                            '" target="_blank" style="color: #0366d6;">Открыть в браузере</a>' +
                            '<span style="margin-left: 16px; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; background: ' +
                            color +
                            '; color: white;">' +
                            d.similarity.toUpperCase() +
                            "</span>" +
                            "</div>" +
                            '<div class="field" style="font-family: inherit; font-size: 13px; background: #fafafa;">' +
                            escapeHtml(d.reason) +
                            "</div>" +
                            "</div>";
                }
                duplicatesContent =
                    '<div id="duplicates" class="content">' +
                        '<div class="section">' +
                        "<h2>Рекомендация ИИ: " +
                        duplicateResult.recommendation +
                        " (confidence: " +
                        (duplicateResult.confidence * 100).toFixed(0) +
                        "%)</h2>" +
                        '<div class="field" style="background: #fff5b1; border-color: #d15704;">' +
                        escapeHtml(JSON.stringify(duplicateResult, null, 2)) +
                        "</div>" +
                        "</div>" +
                        itemsHtml +
                        "</div>";
            }
            let html = "";
            html += "<!DOCTYPE html>";
            html += '<html lang="ru">';
            html += "<head>";
            html += '  <meta charset="UTF-8">';
            html += '  <meta name="viewport" content="width=device-width, initial-scale=1.0">';
            html += "  <title>Предпросмотр Issue</title>";
            html += "  <style>";
            html += "    * { box-sizing: border-box; }";
            html +=
                "    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 900px; margin: 0 auto; padding: 20px; background: #f5f5f5; }";
            html +=
                "    .container { background: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); overflow: hidden; }";
            html += "    .header { background: #24292e; color: white; padding: 20px; }";
            html += "    .header h1 { margin: 0; font-size: 24px; }";
            html += "    .tabs { display: flex; flex-wrap: wrap; border-bottom: 1px solid #e1e4e8; }";
            html +=
                "    .tab { padding: 12px 24px; cursor: pointer; font-weight: 500; color: #586069; border-bottom: 3px solid transparent; transition: all 0.2s; }";
            html += "    .tab.active { color: #0366d6; border-bottom-color: #0366d6; background: #f6f8fa; }";
            html += "    .tab:hover:not(.active) { background: #f6f8fa; }";
            html += "    .content { padding: 24px; display: none; }";
            html += "    .content.active { display: block; }";
            html += "    .section { margin-bottom: 24px; }";
            html +=
                "    .section h2 { font-size: 14px; font-weight: 600; color: #586069; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; }";
            html +=
                "    .field { background: #f6f8fa; border: 1px solid #e1e4e8; border-radius: 6px; padding: 16px; font-family: 'SF Mono', Monaco, monospace; font-size: 14px; line-height: 1.5; white-space: pre-wrap; word-wrap: break-word; }";
            html += "    .labels { display: flex; flex-wrap: wrap; gap: 8px; }";
            html +=
                "    .label { background: #e1e4e8; color: #24292e; padding: 4px 12px; border-radius: 12px; font-size: 12px; font-weight: 500; }";
            html +=
                "    .footer { background: #f6f8fa; padding: 16px 24px; border-top: 1px solid #e1e4e8; text-align: center; color: #586069; font-size: 14px; }";
            html += "    .diff { display: flex; gap: 24px; }";
            html += "    .diff-column { flex: 1; }";
            html +=
                "    .diff-header { font-weight: 600; margin-bottom: 8px; padding: 8px 12px; border-radius: 6px 6px 0 0; }";
            html += "    .ru-header { background: #fff5b1; color: #b08800; }";
            html += "    .en-header { background: #d4f5d4; color: #22863a; }";
            html += "    @media (max-width: 700px) { .diff { flex-direction: column; } }";
            html += "  </style>";
            html += "</head>";
            html += "<body>";
            html += '  <div class="container">';
            html += '    <div class="header">';
            html += "      <h1>\uD83D\uDCCB Предпросмотр Issue</h1>";
            html += "    </div>";
            html += '    <div class="tabs">';
            html += "      <button class=\"tab active\" onclick=\"showTab('side-by-side')\">Сравнение</button>";
            html += "      <button class=\"tab\" onclick=\"showTab('russian')\">Русский (оригинал)</button>";
            html += "      <button class=\"tab\" onclick=\"showTab('english')\">English (к отправке)</button>";
            html += duplicatesTab;
            html += "    </div>";
            html += '    <div id="side-by-side" class="content active">';
            html += '      <div class="diff">';
            html += '        <div class="diff-column">';
            html += '          <div class="diff-header ru-header">\uD83C\uDDF7\uD83C\uDDFA Русский (оригинал)</div>';
            html += '          <div class="section">';
            html += "            <h2>Заголовок</h2>";
            html += '            <div class="field">' + escapeHtml(russian.title) + "</div>";
            html += "          </div>";
            html += '          <div class="section">';
            html += "            <h2>Описание</h2>";
            html += '            <div class="field">' + escapeHtml(russian.body) + "</div>";
            html += "          </div>";
            html += "        </div>";
            html += '        <div class="diff-column">';
            html += '          <div class="diff-header en-header">\uD83C\uDDFA\uD83C\uDDF8 English (к отправке)</div>';
            html += '          <div class="section">';
            html += "            <h2>Title</h2>";
            html += '            <div class="field">' + escapeHtml(english.title) + "</div>";
            html += "          </div>";
            html += '          <div class="section">';
            html += "            <h2>Body</h2>";
            html += '            <div class="field">' + escapeHtml(english.body) + "</div>";
            html += "          </div>";
            html += "        </div>";
            html += "      </div>";
            html += "    </div>";
            html += '    <div id="russian" class="content">';
            html += '      <div class="section">';
            html += "        <h2>Заголовок</h2>";
            html += '        <div class="field">' + escapeHtml(russian.title) + "</div>";
            html += "      </div>";
            html += '      <div class="section">';
            html += "        <h2>Описание</h2>";
            html += '        <div class="field">' + escapeHtml(russian.body) + "</div>";
            html += "      </div>";
            html += "    </div>";
            html += '    <div id="english" class="content">';
            html += '      <div class="section">';
            html += "        <h2>Title</h2>";
            html += '        <div class="field">' + escapeHtml(english.title) + "</div>";
            html += "      </div>";
            html += '      <div class="section">';
            html += "        <h2>Body</h2>";
            html += '        <div class="field">' + escapeHtml(english.body) + "</div>";
            html += "      </div>";
            html += "    </div>";
            html += duplicatesContent;
            html += '    <div class="footer">';
            html += '      Подтвердите создание ишью на английском в диалоге разрешения';
            html += "    </div>";
            html += "  </div>";
            html += "  <script>";
            html += "    function showTab(id) {";
            html += "      document.querySelectorAll('.content').forEach(c => c.classList.remove('active'))";
            html += "      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'))";
            html += "      document.getElementById(id).classList.add('active')";
            html += "      event.target.classList.add('active')";
            html += "    }";
            html += "  </script>";
            html += "</body>";
            html += "</html>";
            return html;
        }
        async function createIssue(options, data, labels, assignees, owner, repo, platform) {
            const args = [];
            let cmd;
            if (platform === "codeberg") {
                // У tea другие флаги: --description (не --body), а метки и исполнители
                // передаются одним флагом через запятую.
                cmd = "tea";
                args.push("issues", "create", "--repo", `${owner}/${repo}`, "--title", data.title, "--description", data.body);
                const teaLabels = (labels ?? []).join(",");
                if (teaLabels)
                    args.push("--labels", teaLabels);
                const teaAssignees = (assignees ?? []).join(",");
                if (teaAssignees)
                    args.push("--assignees", teaAssignees);
            }
            else {
                cmd = "gh";
                args.push("issue", "create", "--repo", `${owner}/${repo}`, "--title", data.title, "--body", data.body);
                for (const label of labels ?? [])
                    args.push("--label", label);
                for (const assignee of assignees ?? [])
                    args.push("--assignee", assignee);
            }
            const output = await run(cmd, args);
            return { success: true, output };
        }
        await ctx.tool.transform((editor) => {
            editor.add({
                name: "issue_create",
                description: "Create a GitHub/Codeberg issue from a Russian title and body. Shows a browser preview, optionally checks for duplicates with AI and translates the issue into the submit language.",
                input: {
                    type: "object",
                    properties: {
                        title: { type: "string", description: "Issue title (original language, usually Russian)" },
                        body: { type: "string", description: "Issue body (original language, usually Russian)" },
                        labels: { type: "array", items: { type: "string" }, description: "Labels to attach" },
                        assignees: { type: "array", items: { type: "string" }, description: "Assignees to attach" },
                        preview: { type: "boolean", description: "Show the browser preview and ask for confirmation (default true)" },
                        owner: { type: "string", description: "Repository owner. Optional — detected from git origin, gh, or OPENCODE_ISSUE_CONFIG" },
                        repo: { type: "string", description: "Repository name. Optional — detected from git origin, gh, or OPENCODE_ISSUE_CONFIG" },
                        platform: { type: "string", enum: ["github", "codeberg"], description: "Platform. Optional — auto-detected" },
                    },
                    required: ["title", "body"],
                    additionalProperties: false,
                },
                async execute(args, context) {
                    const options = await getIssueOptions();
                    const repoInfo = await getRepoInfo(args.owner && args.repo ? { owner: args.owner, repo: args.repo, platform: args.platform } : undefined);
                    if (!repoInfo) {
                        throw new Error("Could not detect repository. Pass owner and repo, or run inside a git repo with a remote, or set owner/repo in OPENCODE_ISSUE_CONFIG.");
                    }
                    const { owner, repo, platform } = repoInfo;
                    let duplicateResult = null;
                    if (options.duplicateCheck !== false) {
                        duplicateResult = await checkDuplicatesWithAI(options, args.title, args.body, owner, repo, platform, options.previewLanguage || "ru", options.submitLanguage || "en");
                    }
                    const english = duplicateResult
                        ? { title: duplicateResult.translatedTitle, body: duplicateResult.translatedBody }
                        : { title: args.title, body: args.body };
                    if (args.preview !== false) {
                        await showPreviewAndConfirm(context, args, english, duplicateResult, owner, repo);
                    }
                    const issue = await createIssue(options, english, args.labels, args.assignees, owner, repo, platform);
                    return {
                        content: `Issue created in ${owner}/${repo}:\n${issue.output}`,
                        metadata: { owner, repo, platform },
                    };
                },
            });
        });
    },
});
