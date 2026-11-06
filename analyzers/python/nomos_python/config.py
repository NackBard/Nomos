"""The workspace file (contracts/nomos.schema.json) and the rules and practices of spec."""
from __future__ import annotations

import json
import os
import re

_here = os.path.dirname(os.path.abspath(__file__))
_rules = None
_practices = None


def spec_rules() -> list:
    """The rules of spec/rules, generated into rules.json by npm run spec-json in conformance/runner."""
    global _rules
    if _rules is None:
        with open(os.path.join(_here, "rules.json"), encoding="utf-8") as f:
            _rules = json.load(f)
    return _rules


def spec_practices() -> list:
    """The practice catalog of spec/practices.yaml (practices.json)."""
    global _practices
    if _practices is None:
        with open(os.path.join(_here, "practices.json"), encoding="utf-8") as f:
            _practices = json.load(f)
    return _practices


class ConfigError(Exception):
    """The input is unusable: exit code 3."""


def ordinal_key(text: str) -> str:
    return text


class Config:
    """The part of nomos.json this analyzer reads."""

    def __init__(self, raw: dict, language: str = "python") -> None:
        self.language = language
        self.analyzers = raw.get("analyzers") or []
        self.rules = raw.get("rules") or {}
        self.practices = raw.get("practices")
        self.paradigms = raw.get("paradigms") or {}
        self.layers = raw.get("layers") or []
        scoring = raw.get("scoring") or {}
        self.category_weights = scoring.get("categoryWeights") or {}
        self.severity_penalties = {"info": 0, "minor": 1, "major": 3, "critical": 8, **(scoring.get("severityPenalties") or {})}
        self.confidence_factors = {"low": 0.25, "medium": 0.6, "high": 1, **(scoring.get("confidenceFactors") or {})}
        self.decay_per_kloc = scoring.get("decayPerKloc") or 20
        self.min_kloc = scoring.get("minKloc") or 0.2

    def scope(self) -> tuple:
        """The include and exclude globs of this language."""
        for a in self.analyzers:
            if a.get("language") == self.language:
                return a.get("include") or [], a.get("exclude") or []
        return [], []

    def enabled_paradigms(self) -> set:
        """D-011: the functional style is opt-in, as in the other analyzers."""
        return set(self.paradigms.get(self.language, ["oop", "structural"]))

    def outside_practices(self):
        """For each rule outside the selected practices, the message for skippedRules (D-051); None selects all."""
        if self.practices is None:
            return None
        selected = set(self.practices)
        owners: dict = {}
        for practice in spec_practices():
            for rule in practice["rules"]:
                owners.setdefault(rule, []).append(practice["id"])
        outside = {}
        for rule, owned in owners.items():
            if not any(p in selected for p in owned):
                names = " or ".join(sorted(owned))
                outside[rule] = f"Rule belongs to practice {names}, which is not selected; 'practices' in nomos.json selects them"
        return outside

    def threshold(self, rule: dict, name: str):
        own = (self.rules.get(rule["id"]) or {}).get("threshold")
        if own and name in own:
            return own[name]
        return (rule.get("threshold") or {}).get(name)

    def number(self, rule: dict, name: str):
        value = self.threshold(rule, name)
        return value if isinstance(value, (int, float)) and not isinstance(value, bool) else 0

    def layer_of(self, module: str):
        for layer in self.layers:
            for pattern in layer.get("patterns") or []:
                expression = ".*".join(re.escape(part) for part in pattern.split("*"))
                if re.fullmatch(expression, module, re.IGNORECASE):
                    return layer
        return None


def load_config(file, language: str = "python") -> Config:
    """Reads the file named by --config; no path gives the defaults."""
    if not file:
        return Config({}, language)
    try:
        with open(file, encoding="utf-8-sig") as f:
            text = f.read()
    except OSError:
        raise ConfigError(f"config file not found: {file}") from None
    try:
        raw = json.loads(text)
    except ValueError as e:
        raise ConfigError(f"{file}: {e}") from None
    version = raw.get("schemaVersion") if isinstance(raw, dict) else None
    if not isinstance(version, str) or not version.startswith("1."):
        raise ConfigError(f"{file}: expected schemaVersion 1.x, found '{version or ''}'")
    if raw.get("practices"):
        known = {p["id"] for p in spec_practices()}
        for practice in raw["practices"]:
            if practice not in known:
                raise ConfigError(f"{file}: unknown practice '{practice}'")
    return Config(raw, language)
