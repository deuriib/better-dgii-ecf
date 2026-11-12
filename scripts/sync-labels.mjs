#!/usr/bin/env bun
/**
 * Apply `.github/labels.yml` without waiting for a push to the default branch.
 *
 * The workflow is the normal path; this exists because a maintainer labelling an
 * issue five minutes after adding a label should not have to merge to main first,
 * and because labelling by hand in the UI is the drift this file is meant to
 * prevent. Same source of truth, same result.
 *
 * Labels that exist on GitHub but are absent from the file are reported, not
 * deleted: a label may be used by an open issue, and removing it silently would
 * lose information. Deleting is a decision, so it is left to a human.
 *
 * Plain JavaScript on purpose — it runs through the pinned Bun with no build step
 * and no runtime types, and `mise run labels-sync` is the only way to apply it.
 */
import { $ } from 'bun';

const FILE = '.github/labels.yml';

const parsed = Bun.YAML.parse(await Bun.file(FILE).text());
const wanted = parsed?.labels ?? [];

if (wanted.length === 0) {
  throw new Error(`${FILE} declares no labels`);
}

for (const label of wanted) {
  if (typeof label.name !== 'string' || label.name === '') {
    throw new Error(`${FILE}: every label needs a name`);
  }
  if (!/^#[0-9a-f]{6}$/i.test(label.color ?? '')) {
    throw new Error(
      `${label.name}: color must be a 6-digit hex value, got ${label.color}`,
    );
  }
  if (typeof label.description !== 'string' || label.description.length < 10) {
    throw new Error(
      `${label.name}: a description is required and must say when to apply it`,
    );
  }
}

const existing = await $`gh label list --limit 200 --json name`.json();
const existingNames = new Set(existing.map((label) => label.name));
const wantedNames = new Set(wanted.map((label) => label.name));

let created = 0;
let updated = 0;
for (const label of wanted) {
  for (const alias of label.aliases ?? []) {
    if (existingNames.has(alias)) {
      console.warn(
        `note: "${alias}" still exists and should be renamed to "${label.name}" — the sync workflow migrates it via aliases; this script does not.`,
      );
    }
  }
  // `--force` updates an existing label, which keeps this idempotent instead of
  // branching per label into create-or-update.
  await $`gh label create ${label.name} --color ${label.color.replace('#', '')} --description ${label.description} --force`.quiet();
  if (existingNames.has(label.name)) {
    updated += 1;
  } else {
    created += 1;
  }
}

const orphaned = [...existingNames].filter((name) => !wantedNames.has(name));
console.log(
  `labels: ${created} created, ${updated} updated, ${wanted.length} declared`,
);
if (orphaned.length > 0) {
  console.warn(
    `orphaned on GitHub (not in ${FILE}, not deleted): ${orphaned.join(', ')}`,
  );
}
