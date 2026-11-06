package nomos.java;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.regex.Pattern;

/** The workspace file (contracts/nomos.schema.json) and the rules and practices of spec. */
final class Config {
    static final String LANGUAGE = "java";

    /** The input is unusable: exit code 3. */
    static final class ConfigError extends Exception {
        private static final long serialVersionUID = 1L;

        ConfigError(String message) {
            super(message);
        }
    }

    private static List<Map<String, Object>> rules;
    private static List<Map<String, Object>> practices;

    /** The rules of spec/rules, generated into rules.json by npm run spec-json in conformance/runner. */
    static synchronized List<Map<String, Object>> specRules() {
        if (rules == null) rules = resource("rules.json");
        return rules;
    }

    /** The practice catalog of spec/practices.yaml (practices.json). */
    static synchronized List<Map<String, Object>> specPractices() {
        if (practices == null) practices = resource("practices.json");
        return practices;
    }

    private static List<Map<String, Object>> resource(String name) {
        try (InputStream in = Config.class.getResourceAsStream(name)) {
            if (in == null) throw new IllegalStateException(name + " is missing from the analyzer");
            List<Map<String, Object>> list = new ArrayList<>();
            for (Object item : Json.array(Json.parse(new String(in.readAllBytes(), StandardCharsets.UTF_8)))) list.add(Json.object(item));
            return list;
        } catch (IOException | Json.ParseError e) {
            throw new IllegalStateException(name + ": " + e.getMessage(), e);
        }
    }

    final List<Object> analyzers;
    final Map<String, Object> ruleSettings;
    final List<Object> practiceIds;
    final Map<String, Object> paradigms;
    final List<Object> layers;
    final Map<String, Object> categoryWeights;
    final Map<String, Double> severityPenalties = new LinkedHashMap<>();
    final Map<String, Double> confidenceFactors = new LinkedHashMap<>();
    final double decayPerKloc;
    final double minKloc;

    Config(Map<String, Object> raw) {
        analyzers = Json.array(raw.get("analyzers"));
        ruleSettings = Json.object(raw.get("rules"));
        practiceIds = raw.get("practices") instanceof List<?> ? Json.array(raw.get("practices")) : null;
        paradigms = Json.object(raw.get("paradigms"));
        layers = Json.array(raw.get("layers"));
        Map<String, Object> scoring = Json.object(raw.get("scoring"));
        categoryWeights = Json.object(scoring.get("categoryWeights"));
        severityPenalties.put("info", 0.0);
        severityPenalties.put("minor", 1.0);
        severityPenalties.put("major", 3.0);
        severityPenalties.put("critical", 8.0);
        Json.object(scoring.get("severityPenalties")).forEach((k, v) -> severityPenalties.put(k, number(v)));
        confidenceFactors.put("low", 0.25);
        confidenceFactors.put("medium", 0.6);
        confidenceFactors.put("high", 1.0);
        Json.object(scoring.get("confidenceFactors")).forEach((k, v) -> confidenceFactors.put(k, number(v)));
        double decay = number(scoring.get("decayPerKloc"));
        decayPerKloc = decay != 0 ? decay : 20;
        double min = number(scoring.get("minKloc"));
        minKloc = min != 0 ? min : 0.2;
    }

    static double number(Object value) {
        return value instanceof Number n ? n.doubleValue() : 0;
    }

    /** The include and exclude globs of this language. */
    List<List<String>> scope() {
        for (Object a : analyzers) {
            Map<String, Object> entry = Json.object(a);
            if (LANGUAGE.equals(entry.get("language"))) return List.of(strings(entry.get("include")), strings(entry.get("exclude")));
        }
        return List.of(List.of(), List.of());
    }

    static List<String> strings(Object value) {
        List<String> list = new ArrayList<>();
        for (Object o : Json.array(value)) if (o instanceof String s) list.add(s);
        return list;
    }

    /** D-011: the functional style is opt-in, as in the other analyzers. */
    Set<String> enabledParadigms() {
        Object own = paradigms.get(LANGUAGE);
        if (own instanceof List<?>) return new HashSet<>(strings(own));
        return new HashSet<>(List.of("oop", "structural"));
    }

    /** For each rule outside the selected practices, the message for skippedRules (D-051); null selects all. */
    Map<String, String> outsidePractices() {
        if (practiceIds == null) return null;
        Set<String> selected = new HashSet<>(strings(practiceIds));
        Map<String, List<String>> owners = new TreeMap<>();
        for (Map<String, Object> practice : specPractices()) {
            for (String rule : strings(practice.get("rules"))) owners.computeIfAbsent(rule, k -> new ArrayList<>()).add((String) practice.get("id"));
        }
        Map<String, String> outside = new TreeMap<>();
        owners.forEach((rule, owned) -> {
            if (owned.stream().noneMatch(selected::contains)) {
                List<String> names = new ArrayList<>(owned);
                names.sort(null);
                outside.put(rule, "Rule belongs to practice " + String.join(" or ", names) + ", which is not selected; 'practices' in nomos.json selects them");
            }
        });
        return outside;
    }

    Map<String, Object> rule(String id) {
        return Json.object(ruleSettings.get(id));
    }

    Object threshold(Map<String, Object> rule, String name) {
        Map<String, Object> own = Json.object(rule((String) rule.get("id")).get("threshold"));
        if (own.containsKey(name)) return own.get(name);
        return Json.object(rule.get("threshold")).get(name);
    }

    double number(Map<String, Object> rule, String name) {
        return number(threshold(rule, name));
    }

    Map<String, Object> layerOf(String module) {
        for (Object l : layers) {
            Map<String, Object> layer = Json.object(l);
            for (String pattern : strings(layer.get("patterns"))) {
                StringBuilder expression = new StringBuilder();
                String[] parts = pattern.split("\\*", -1);
                for (int i = 0; i < parts.length; i++) {
                    if (i > 0) expression.append(".*");
                    expression.append(Pattern.quote(parts[i]));
                }
                if (Pattern.compile(expression.toString(), Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE).matcher(module).matches()) return layer;
            }
        }
        return null;
    }

    /** Reads the file named by --config; no path gives the defaults. */
    static Config load(String file) throws ConfigError {
        if (file == null || file.isEmpty()) return new Config(Map.of());
        String text;
        try {
            text = Files.readString(Path.of(file), StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new ConfigError("config file not found: " + file);
        }
        if (text.startsWith("﻿")) text = text.substring(1);
        Object raw;
        try {
            raw = Json.parse(text);
        } catch (Json.ParseError e) {
            throw new ConfigError(file + ": " + e.getMessage());
        }
        Map<String, Object> map = Json.object(raw);
        Object version = map.get("schemaVersion");
        if (!(version instanceof String v) || !v.startsWith("1.")) {
            throw new ConfigError(file + ": expected schemaVersion 1.x, found '" + (version instanceof String s ? s : "") + "'");
        }
        if (map.get("practices") instanceof List<?>) {
            Set<String> known = new HashSet<>();
            for (Map<String, Object> p : specPractices()) known.add((String) p.get("id"));
            for (String practice : strings(map.get("practices"))) {
                if (!known.contains(practice)) throw new ConfigError(file + ": unknown practice '" + practice + "'");
            }
        }
        return new Config(map);
    }

    static String lower(String s) {
        return s.toLowerCase(Locale.ROOT);
    }
}
