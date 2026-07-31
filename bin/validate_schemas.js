#!/usr/bin/env node
/**
 * Validate preset catalog documents against hand-written JSON Schemas (Phase 0).
 * Uses the `ajv` library only — do not add `ajv-cli` (vulnerable transitive deps).
 *
 * Usage:
 *   node bin/validate_schemas.js
 *   node bin/validate_schemas.js --mode standard
 *   node bin/validate_schemas.js --mode all
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/**
 * Single-file catalogs under presets/<mode>/<dataRel>.
 * @type {{ kind: string, schemaFile: string, dataRel: string, storage?: 'file' }[]}
 */
const CATALOGS = [
  { kind: 'spells', schemaFile: 'schemas/spells.schema.json', dataRel: 'spells.json' },
  { kind: 'classes', schemaFile: 'schemas/classes.schema.json', dataRel: 'classes.json' },
  { kind: 'equipment', schemaFile: 'schemas/equipment.schema.json', dataRel: 'equipment.json' },
  { kind: 'strategies', schemaFile: 'schemas/strategies.schema.json', dataRel: 'strategies.json' },
];

/**
 * Folder entities: each presets/<mode>/<dirRel>/*.json is one document.
 * Covers controlMode on player_profiles / parties (Stage 07 S07-05).
 * @type {{ kind: string, schemaFile: string, dirRel: string, storage: 'folder' }[]}
 */
const FOLDER_ENTITIES = [
  {
    kind: 'player_profiles',
    schemaFile: 'schemas/player_profiles.schema.json',
    dirRel: 'player_profiles',
    storage: 'folder',
  },
  {
    kind: 'parties',
    schemaFile: 'schemas/parties.schema.json',
    dirRel: 'parties',
    storage: 'folder',
  },
];

function loadJson(absPath) {
  return JSON.parse(fs.readFileSync(absPath, 'utf8'));
}

function listModes() {
  const presetsDir = path.join(ROOT, 'presets');
  return fs
    .readdirSync(presetsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort();
}

function parseArgs(argv) {
  let mode = 'standard';
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mode' && argv[i + 1]) {
      mode = argv[++i];
    } else if (a === '--help' || a === '-h') {
      console.log(`Usage: node bin/validate_schemas.js [--mode standard|legacy|all|<id>]`);
      process.exit(0);
    }
  }
  return { mode };
}

function main() {
  let Ajv;
  try {
    Ajv = require('ajv');
  } catch (err) {
    console.error(
      'Missing dependency `ajv`. Install devDependencies:\n  npm install\n' +
        '(If npm cache permissions fail: sudo chown -R "$(id -u):$(id -g)" ~/.npm)'
    );
    process.exit(2);
  }

  // CommonJS export shape differs slightly across ajv 8 builds.
  const AjvCtor = typeof Ajv === 'function' ? Ajv : Ajv.default || Ajv.Ajv;
  const ajv = new AjvCtor({
    allErrors: true,
    strict: false,
    validateSchema: true,
  });

  const { mode: modeArg } = parseArgs(process.argv);
  const modes = modeArg === 'all' ? listModes() : [modeArg];

  /** Compile each schema once ($id must stay unique on the Ajv instance). */
  const validators = new Map();
  for (const cat of [...CATALOGS, ...FOLDER_ENTITIES]) {
    const schemaPath = path.join(ROOT, cat.schemaFile);
    const schema = loadJson(schemaPath);
    validators.set(cat.kind, ajv.compile(schema));
  }

  let failures = 0;
  let checked = 0;

  for (const mode of modes) {
    for (const { kind, dataRel } of CATALOGS) {
      const dataPath = path.join(ROOT, 'presets', mode, dataRel);

      if (!fs.existsSync(dataPath)) {
        console.log(`SKIP  ${mode}/${dataRel} (missing)`);
        continue;
      }

      const data = loadJson(dataPath);
      const validate = validators.get(kind);
      const ok = validate(data);
      checked += 1;

      if (ok) {
        const n =
          kind === 'spells'
            ? (data.spells || []).length
            : kind === 'classes'
              ? (data.classes || []).length
              : '?';
        console.log(`OK    ${mode}/${dataRel} (${n} ${kind})`);
      } else {
        failures += 1;
        console.error(`FAIL  ${mode}/${dataRel}`);
        for (const e of validate.errors || []) {
          console.error(`  - ${e.instancePath || '/'} ${e.message}`);
        }
      }
    }

    for (const { kind, dirRel } of FOLDER_ENTITIES) {
      const dirPath = path.join(ROOT, 'presets', mode, dirRel);
      if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
        console.log(`SKIP  ${mode}/${dirRel}/ (missing)`);
        continue;
      }
      const files = fs
        .readdirSync(dirPath)
        .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
        .sort();
      if (files.length === 0) {
        console.log(`SKIP  ${mode}/${dirRel}/ (empty)`);
        continue;
      }
      const validate = validators.get(kind);
      let folderOk = 0;
      let folderFail = 0;
      for (const file of files) {
        const rel = `${mode}/${dirRel}/${file}`;
        const dataPath = path.join(dirPath, file);
        let data;
        try {
          data = loadJson(dataPath);
        } catch (err) {
          failures += 1;
          folderFail += 1;
          checked += 1;
          console.error(`FAIL  ${rel} (JSON parse: ${err.message})`);
          continue;
        }
        const ok = validate(data);
        checked += 1;
        if (ok) {
          folderOk += 1;
        } else {
          failures += 1;
          folderFail += 1;
          console.error(`FAIL  ${rel}`);
          for (const e of validate.errors || []) {
            console.error(`  - ${e.instancePath || '/'} ${e.message}`);
          }
        }
      }
      if (folderFail === 0) {
        console.log(`OK    ${mode}/${dirRel}/ (${folderOk} ${kind})`);
      } else {
        console.error(
          `FAIL  ${mode}/${dirRel}/ (${folderOk} ok, ${folderFail} failed ${kind})`
        );
      }
    }
  }

  console.log(`\nChecked ${checked} document(s); ${failures} failure(s).`);
  process.exit(failures ? 1 : 0);
}

main();
