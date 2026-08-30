# Hunt Design Lab Engine Codebase Audit

**Date:** 2026-08-30  
**Repository:** `dungeon-engine` (Hunt Design Lab)  
**Scope:** Lines of code (LOC), comments, blank lines, and module breakdowns for the modern game engine, alongside a high-level comparison against the legacy reference codebase.

---

## 1. Executive Summary & Macro Totals

| Layer / Category | Files | Code LOC | Comments | Blanks | Total Lines | Description |
| :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| **Engine Kernel Core (Shared Runtime)** | **132** | **67,828** | **21,419** | **5,630** | **94,877** | Headless & browser shared game engine logic (`kernel/core/`, `kernel/providers/`, `kernel/*.js`) |
| **Interactive Client & Web Apps** | **33** | **30,959** | **5,594** | **2,436** | **38,989** | Hunt Simulator client, Designer UI, Hunt Editor, Scenario Lab, Analysis UI (`kernel/apps/`) |
| **CLI Pipelines & Tooling** | **47** | **17,519** | **2,116** | **1,255** | **20,890** | Image processing, batch generators, balance sweeps, scripts (`bin/`, `scripts/`) |
| **Backend Service & Job API** | **19** | **8,117** | **1,329** | **757** | **10,203** | Local PHP API, job executor, catalog mutation controllers (`php/`) |
| **Web Presentation & Templates** | **62** | **26,633** | **1,392** | **2,449** | **30,474** | HTML widgets, PHP page wrappers, SCSS stylesheets (`html/`, `templates/`, `scss/`, `*.php`) |
| **Automated Test Suite & Fixtures** | **79** | **56,989** | **2,605** | **4,502** | **64,096** | Unit tests, simulation parity, pathfinding/combat regression tests (`tests/`) |
| **Schemas & Data Contracts** | **18** | **3,530** | **0** | **19** | **3,549** | JSON Schema definitions for presets, creatures, spells, dungeons (`schemas/`) |
| **Engine Documentation** | **35** | **3,147** | **426** | **1,323** | **4,896** | Live domain contracts, architecture specs, roadmap (`docs/`, `README.md`, `AGENTS.md`) |
| **TOTAL ACTIVE ENGINE SOURCE** | **425** | **214,722** | **34,881** | **18,371** | **267,974** | **All active engine TypeScript/JS/PHP/Python/SCSS/Test source code** |
| **Standard Presets & Catalogs** | **1,721** | **379,904** | **0** | **1,721** | **381,625** | Git-tracked JSON content definitions (`presets/standard/`, `assets/data/`) |
| **TOTAL ACTIVE ENGINE + PRESETS & DATA** | **2,146** | **594,626** | **34,881** | **20,092** | **649,599** | **Combined total of active engine source code and standard presets/catalogs** |
| **Legacy Reference Codebase** | **7,819** | **2,704,564** | **61,309** | **164,064** | **2,929,937** | Reference client, map editor, server, and ported data (`legacy/`, `assets/legacy/`) |


---

## 2. Core Game Engine Modules Breakdown (`kernel/`)

The core engine runtime is partitioned into 14 distinct subsystems. All core systems are designed without DOM/browser dependencies to execute identically in headless Node.js simulations and the browser client.

| # | Module Name | Primary Path | Files | Code LOC | Comments | Blanks | Total Lines | Comment % |
| :---: | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **01** | **Core Framework & Settings** | `kernel/settings.js`, `kernel/engine.js`, `kernel/core/lib/{utils,time,fsm,logic_regulator,presets,modes}.js` | 13 | 2,307 | 1,260 | 256 | 3,823 | 32.9% |
| **02** | **World & Entity Model** | `kernel/core/entities/{tilemap,player,party,creature,gameobject,prop}.js` | 6 | 3,737 | 1,587 | 351 | 5,675 | 27.9% |
| **03** | **Spatial Partitioning & Pathfinding** | `kernel/core/lib/{spatial_index,movement,pathfinder,navmesh,path_budget,shapes}.js` | 6 | 2,432 | 961 | 243 | 3,636 | 26.4% |
| **04** | **Combat & Status Mechanics** | `kernel/core/lib/combat/{damage,resolve,area,chain,conditions,elemental_fields,cooldowns,delayed_cast}.js` | 10 | 4,750 | 1,651 | 386 | 6,787 | 24.3% |
| **05** | **Character, Inventory & Progression** | `kernel/core/lib/character/{stats,progression,inventory,ground_items,equipment_runtime,player_profile,loot_roll}.js` | 10 | 6,706 | 2,588 | 565 | 9,859 | 26.2% |
| **06** | **AI Decision System & Hunt FSMs** | `kernel/core/lib/ai/{hunt_ai,creature_kit,combat_actions,player_states,creature_states,cadence,targeting,strategy}.js` | 11 | 5,924 | 1,915 | 488 | 8,327 | 23.0% |
| **07** | **Dungeon Generator & World Pins** | `kernel/core/lib/dungeon/{procedural,macro,multifloor,tilemap_bake,tilemap_editor,world_pins,world_pin_*}.js` | 33 | 19,423 | 5,074 | 1,522 | 26,019 | 19.5% |
| **08** | **Spawns, Waves & Arena Scenarios** | `kernel/core/lib/{spawn_manager,wave_manager,hunt_scenarios}.js` | 3 | 1,772 | 733 | 163 | 2,668 | 27.5% |
| **09** | **NPC Dialog, Flags & Economy** | `kernel/core/lib/npc/{dialog,session,shop,storage,wander,flags,items}.js` | 7 | 1,626 | 568 | 137 | 2,331 | 24.4% |
| **10** | **Telemetry & Balance Sweeps** | `kernel/core/lib/{telemetry,balance_analysis,balance_sweep,analysis_recipes}.js` | 4 | 2,610 | 669 | 182 | 3,461 | 19.3% |
| **11** | **Rendering, Presentation & VFX** | `kernel/core/lib/{sprite_presentation,tile_draw,wall_wang,overlay_wang}.js`, `kernel/core/scripts/*.js` | 11 | 3,666 | 1,165 | 358 | 5,189 | 22.4% |
| **12** | **Creature Manifest & Pipelines** | `kernel/core/lib/{creature_manifest,creature_names,creature_assets,creature_sprites,asset_names,batch_builder}.js` | 6 | 4,165 | 1,021 | 330 | 5,516 | 18.5% |
| **13** | **Content Bridges & Ports** | `kernel/core/lib/content/{legacy_monster_port,legacy_assets,creature_bridge,equipment_bridge,spawn_rows}.js` | 8 | 3,324 | 904 | 283 | 4,511 | 20.0% |
| **14** | **Simulator Provider & Headless Engine** | `kernel/providers/simulator/{simulator,headless_runner,hunt_opts,default_waypoints}.js` | 4 | 5,386 | 1,323 | 366 | 7,075 | 18.7% |
| **--** | **TOTAL KERNEL ENGINE** | `kernel/` | **132** | **67,828** | **21,419** | **5,630** | **94,877** | **22.6%** |

---

## 3. Interactive Web Applications & Tooling (`kernel/apps/`)

Web applications powered by the engine kernel:

| Application Module | Path | Files | Code LOC | Comments | Blanks | Total Lines |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| **Hunt Simulator Game Client** | `kernel/apps/game/` | 17 | 17,485 | 3,681 | 1,330 | 22,496 |
| **Designer Rules & Dungeon Profile Editor** | `kernel/apps/designer-ui/` | 6 | 5,552 | 861 | 440 | 6,853 |
| **Hunt & Wave Regions Editor UI** | `kernel/apps/hunt-editor/` | 2 | 1,982 | 248 | 183 | 2,413 |
| **Scenario Lab Sandboxing UI** | `kernel/apps/scenario-lab/` | 2 | 1,601 | 180 | 96 | 1,877 |
| **Simulation Analysis & Telemetry Visualizer** | `kernel/apps/simulation-analysis/` | 1 | 806 | 102 | 76 | 984 |
| **Standalone Asset & Batch Web Tools** | `kernel/apps/{asset-manager,batch-builder,sim-batch-builder}.js`, `kernel/apps/wiki/` | 5 | 3,533 | 522 | 311 | 4,366 |
| **TOTAL WEB APPS** | `kernel/apps/` | **33** | **30,959** | **5,594** | **2,436** | **38,989** |

---

## 4. Supporting Infrastructure & Services

| System / Subsystem | Path | Files | Code LOC | Comments | Blanks | Total Lines |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| **Automated Test Suite & Regression Fixtures** | `tests/` | 79 | 56,989 | 2,605 | 4,502 | 64,096 |
| **CLI Tools & Sprite Processing Pipelines** | `bin/` | 29 | 11,121 | 1,841 | 1,051 | 14,013 |
| **Automation & Maintenance Scripts** | `scripts/`, root utility scripts | 18 | 6,398 | 275 | 204 | 6,877 |
| **Backend Job Queue & Catalog PHP API** | `php/` | 19 | 8,117 | 1,329 | 757 | 10,203 |
| **Web Templates, PHP Pages & Widgets** | `html/`, `templates/`, root `*.php` | 51 | 21,685 | 1,251 | 1,635 | 24,571 |
| **Stylesheets (SCSS)** | `scss/` | 11 | 4,948 | 141 | 814 | 5,903 |
| **Schemas & JSON Data Contracts** | `schemas/` | 18 | 3,530 | 0 | 19 | 3,549 |
| **Engine Documentation** | `docs/`, `README.md`, `AGENTS.md` | 35 | 3,147 | 426 | 1,323 | 4,896 |
| **Content Presets & Asset Catalogs (Standard)** | `presets/standard/`, `assets/data/` | 1,721 | 379,904 | 0 | 1,721 | 381,625 |

---

## 5. Legacy Reference Codebase Summary

The repository maintains reference implementations of legacy clients, map editors, and servers for format compatibility, data porting, and behavioral validation.

| Legacy Component | Path | Language / Stack | Files | Code LOC | Comments | Blanks | Total Lines |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| **Legacy Reference Client** | `legacy/client/` | C++, Lua, OTUI, CMake | 1,198 | 266,573 | 24,211 | 43,776 | 334,560 |
| **Legacy Map Editor** | `legacy/map-editor/` | C++, wxWidgets, CMake | 434 | 195,275 | 10,444 | 17,856 | 223,575 |
| **Legacy Reference Server** | `legacy/server/` | C++, Lua, XML, SQL | 6,129 | 924,810 | 26,639 | 102,329 | 1,053,778 |
| **Legacy Asset Port Reference Data** | `assets/legacy/` | Map binaries, monster JSONs | 58 | 1,317,906 | 15 | 103 | 1,318,024 |
| **TOTAL LEGACY REFERENCE CODEBASE** | `legacy/` + `assets/legacy/` | C++ / Lua / Assets | **7,819** | **2,704,564** | **61,309** | **164,064** | **2,929,937** |

---

## 6. Key Comparative Metrics

1. **Modern Engine vs Legacy Footprint**:
   - The modern JavaScript game engine kernel (`kernel/`) delivers a complete, multi-floor simulation, combat pipeline, procedural dungeon generator, and bot AI in **67,828 Code LOC**.
   - By comparison, the legacy reference client + server codebase encompasses **1,386,658 Code LOC** (excluding data files), meaning the modern engine achieves its targeted hunt and dungeon simulation within **~4.9%** of the legacy surface area.
2. **Quality & Test Coverage**:
   - The engine test suite comprises **56,989 Code LOC** (84% of the kernel size), giving the core simulation an unusually high automated regression buffer.
3. **Documentation Density**:
   - The engine kernel features **21,419 comment lines** (22.6% comment density), maintaining documented domain invariants, math formulas, and execution ordering across combat and pathfinding.
