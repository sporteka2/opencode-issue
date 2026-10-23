---
description: Поиск дубликатов ишью перед созданием
---

Перед созданием ишью найди дубликаты через CLI платформы. Репозиторий и платформа определяются автоматически из git remote.

Репозиторий: ${owner}/${repo} (${platform}) — подставляется автоматически

Настройки языка (из конфига):
- previewLanguage: ${previewLanguage || "ru"} — язык предпросмотра (ru|en)
- submitLanguage: ${submitLanguage || "en"} — язык отправки (ru|en)

## GitHub (gh CLI)
```bash
gh api /search/issues?q=repo:OWNER/REPO+type:issue+state:open+KEYWORDS
```

## Codeberg (tea CLI - Gitea)
```bash
tea issues search --repo OWNER/REPO --state open --keyword KEYWORDS
# или для поиска по названию:
tea issues list --repo OWNER/REPO --state open | grep -i KEYWORDS
```

## Ответ (JSON)
```json
{
  "platform": "github|codeberg",
  "searched": true,
  "duplicates": [
    { "number": 123, "title": "...", "url": "https://...", "similarity": "exact|high|medium", "reason": "..." }
  ],
  "recommendation": "create|skip|review",
  "confidence": 0.0-1.0,
  "translatedTitle": "Translated title in submit language",
  "translatedBody": "Translated body in submit language"
}
```