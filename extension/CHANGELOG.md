# Changelog

The language packs (`nomos-csharp`, `nomos-go`, `nomos-typescript`, `nomos-python`, `nomos-java`, `nomos-kotlin`, `nomos-ruby`) are released together with the core and carry the same version.

## Unreleased

- **Nothing runs by itself.** Opening the Nomos side bar no longer starts an analysis or opens the graph; **Analyze** and the graph button do. An empty side bar says so and offers the analysis.
- **Settings menu**: the gear on the side bar (`Nomos: Settings`) switches the metrics above the code, how findings look in the editor and the analysis on save, and leads to the practices and to all settings. Switching the metrics off hides them at once.
- **Class diagrams**: the free functions of a module are one «utility» class with static operations, so a module of functions only has a diagram too; the export can take the whole project; the **Export…** button on the graph page is gone, the export button on the tab stays.
- **Graph**: the names on an opened bundle no longer overlap.
- **Language packs**: each has the Nomos icon; when a pack cannot be installed from the Marketplace, Nomos says why and offers to install it from a VSIX file.
- **C#**: after installing the .NET Install Tool, Nomos waits for it before asking for .NET, instead of failing with "command 'dotnet.acquire' not found".

## 0.1.1

- **Compact graph view**, on by default, with a **Compact** switch on the graph panel. Links of different kinds between two nodes form one bundle that opens in place (`Esc` closes it); links in both directions are drawn as one line; the type graph shows one trunk to each other module; the module graph folds modules by folder.
- **Double-click on the graph** opens the node in another extension that registers a command for it (Nomos Score does). Without such an extension a single click works as before, without delay.
- **An event after each analysis** in the API of the extension, for other extensions (Nomos Agents uses it).
- **Extension icon** on the Marketplace page.

## 0.1.0

First release.

- Findings in the side bar and as hints in the editor, metrics above declarations, a dependency graph next to the code, a class diagram of a module, paradigms and skipped rules for each module.
- Analyzers in language packs: C#, Go, TypeScript and JavaScript, Python, Java, Kotlin, Ruby. Nomos offers the pack when the folder has files of a language without one.
- Works without `nomos.json`; a `nomos.json` in the folder root replaces the defaults.
- Practices to check against, English and Russian interface.
