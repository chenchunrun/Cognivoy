"""Shared language directives for prompt-driven LLM calls.

This helper centralizes the "stay in the requested language" instruction so
different modules can share the same behavior without depending on book-only
utilities.
"""

from __future__ import annotations

import re

_LANGUAGE_LABELS: dict[str, str] = {
    "zh": "中文（简体）",
    "zh-cn": "中文（简体）",
    "zh-tw": "繁體中文",
    "en": "English",
    "ja": "日本語",
    "ko": "한국어",
    "es": "Español",
    "fr": "Français",
    "de": "Deutsch",
    "ru": "Русский",
    "pt": "Português",
    "it": "Italiano",
}


def normalize_language(language: str | None) -> str:
    return (language or "en").strip().lower() or "en"


_ZH_EXPLICIT = re.compile(
    r"(?:请|用|使用|以|改用|回复|回答|输出).{0,8}(?:中文|汉语)|"
    r"(?:中文|汉语).{0,8}(?:回复|回答|输出)|"
    r"(?:reply|respond|answer|write|output).{0,16}in\s+(?:simplified\s+)?chinese",
    re.IGNORECASE,
)
_EN_EXPLICIT = re.compile(
    r"(?:please\s+)?(?:reply|respond|answer|write|output)\s+(?:to\s+me\s+)?in\s+english|"
    r"(?:请|用|使用|以|改用|回复|回答|输出).{0,8}(?:英文|英语)|(?:英文|英语).{0,8}(?:回复|回答|输出)",
    re.IGNORECASE,
)


def infer_response_language(text: str | None, fallback: str | None = "en") -> str:
    """Choose the reader-facing language from the current user turn.

    Explicit language requests win. Otherwise a natural Chinese utterance
    follows Chinese and an English utterance follows English. Code, punctuation
    and ambiguous/other-language input retain the caller's saved preference.
    """
    value = (text or "").strip()
    fallback_code = normalize_language(fallback)
    if not value:
        return fallback_code
    if _EN_EXPLICIT.search(value):
        return "en"
    if _ZH_EXPLICIT.search(value):
        return "zh"
    han_count = len(re.findall(r"[\u3400-\u4dbf\u4e00-\u9fff]", value))
    latin_words = re.findall(r"[A-Za-z]+(?:['’-][A-Za-z]+)?", value)
    latin_letters = sum(len(word) for word in latin_words)
    # Two Han characters are enough for ordinary short turns such as “继续”.
    if han_count >= 2:
        return "zh"
    # Avoid classifying one-letter variables, paths and symbol-only code as
    # English. One normal word (or several short words) is a useful signal.
    if latin_letters >= 3:
        return "en"
    return fallback_code


def language_label(language: str | None) -> str:
    code = normalize_language(language)
    if code in _LANGUAGE_LABELS:
        return _LANGUAGE_LABELS[code]
    base = code.split("-", 1)[0]
    return _LANGUAGE_LABELS.get(base, language or "English")


def language_directive(language: str | None) -> str:
    """Return a strict reader-facing language instruction for prompts."""
    code = normalize_language(language)
    label = language_label(code)
    if code.startswith("zh"):
        return (
            "\n\n[语言要求 / Language] "
            f"请严格使用{label}撰写所有面向读者的文本（标题、正文、解释、提示、过渡句、"
            "题干、选项等），即使参考资料、JSON 字段名或英文术语出现在 prompt 中也"
            "不得切换语言；保留必要的专有名词原文（如人名、产品名、公式中的变量符号"
            f"等）即可，其余一律使用{label}。"
        )
    if code == "en":
        return (
            "\n\n[Language] Write ALL reader-facing text (titles, prose, "
            "explanations, hints, transitions, quiz stems, options, etc.) in "
            "English. Do NOT switch languages even if the source material, "
            "JSON keys, or examples in this prompt are in another language. "
            "Keep proper nouns (people, products, formula symbols) in their "
            "original form."
        )
    return (
        f"\n\n[Language] Write ALL reader-facing text strictly in {label}. "
        "Do NOT switch languages even if the source material, JSON keys, or "
        "examples in this prompt are in a different language. Keep proper "
        "nouns (people, products, formula symbols) in their original form."
    )


def append_language_directive(system_prompt: str | None, language: str | None) -> str:
    """Append the language directive to an existing system prompt."""
    base = (system_prompt or "").rstrip()
    directive = language_directive(language).strip()
    if not base:
        return directive
    return f"{base}\n\n{directive}"


__all__ = [
    "append_language_directive",
    "language_directive",
    "language_label",
    "infer_response_language",
    "normalize_language",
]
