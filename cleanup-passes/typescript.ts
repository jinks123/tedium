/**
 * @license
 * Copyright (c) 2018 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at
 * http://polymer.github.io/LICENSE.txt
 * The complete set of authors may be found at
 * http://polymer.github.io/AUTHORS.txt
 * The complete set of contributors may be found at
 * http://polymer.github.io/CONTRIBUTORS.txt
 * Code distributed by Google as part of the polymer project is also
 * subject to an additional IP rights grant found at
 * http://polymer.github.io/PATENTS.txt
 */

'use strict';

import * as fse from 'fs-extra';
import * as path from 'path';
import {execFile} from 'child_process';
import * as yaml from 'js-yaml';
import * as semver from 'semver';
import {promisify} from 'util';

import {register} from '../cleanup-pass';
import {ElementRepo} from '../element-repo';
import {makeCommit} from './util';

const execFilePromise = promisify(execFile);

const generatorPackageName = '@polymer/gen-typescript-declarations';
const npmScriptName = 'update-types';
const npmScriptCommand =
    'bower install && gen-typescript-declarations --deleteExisting --outDir .';

let latestGeneratorVersion: string|undefined;
async function getLatestGeneratorVersion(): Promise<string> {
  if (latestGeneratorVersion === undefined) {
    const {stdout} =
        await execFilePromise('npm', ['info', generatorPackageName]);
    const match = stdout.match(/latest: '(\d+\.\d+\.\d+)'/);
    if (!match || !match[1]) {
      throw new Error(
          `Could not find latest version of ${generatorPackageName}`);
    }
    latestGeneratorVersion = match[1];
  }
  return latestGeneratorVersion;
}

/**
 * This pass updates an element repo to include typings generated by
 * https://github.com/Polymer/gen-typescript-declarations/ and configures an
 * "update-types" NPM script that can be run to re-generate them.
 *
 * Throws an error if the repo has a missing or invalid package.json or if npm
 * or bower aren't globally installed.
 */
async function typescriptPass(element: ElementRepo): Promise<void> {
  const packageJsonPath = path.join(element.dir, 'package.json');
  let packageJson: NpmConfig;
  try {
    packageJson = await fse.readJson(packageJsonPath);
  } catch {
    throw new Error(`${element.ghRepo.name}: Missing or invalid package.json.`);
  }

  let majorVersionBump = false;
  let updatedNpmScript = false;
  let updatedTravis = false;
  let updatedTypes = false;

  if (packageJson.devDependencies === undefined) {
    packageJson.devDependencies = {};
  }
  if (packageJson.scripts === undefined) {
    packageJson.scripts = {};
  }

  const newGeneratorVersion = await getLatestGeneratorVersion();
  const oldGeneratorRange = packageJson.devDependencies[generatorPackageName];
  if (oldGeneratorRange === undefined ||
      !semver.satisfies(newGeneratorVersion, oldGeneratorRange)) {
    majorVersionBump = true;
  }
  packageJson.devDependencies[generatorPackageName] = '^' + newGeneratorVersion;

  // The update types script depends on bower because the generator needs to
  // actually resolve dependencies in the HTML import graph.
  if (packageJson.devDependencies['bower'] === undefined) {
    packageJson.devDependencies['bower'] = '^1.8.0';
  }

  if (packageJson.scripts[npmScriptName] !== npmScriptCommand) {
    packageJson.scripts[npmScriptName] = npmScriptCommand;
    updatedNpmScript = true;
  }

  await fse.writeJson(packageJsonPath, packageJson, {spaces: 2});

  // Update Travis config to fail if typings aren't up to date.
  const travisYamlPath = path.join(element.dir, '.travis.yml');
  if (await fse.pathExists(travisYamlPath)) {
    const travisYaml =
        yaml.safeLoad(await fse.readFile(travisYamlPath, 'utf8')) as {
      before_script?: string[];
    }
    if (!travisYaml.before_script) {
      travisYaml.before_script = [];
    }
    // Remove any prior version of this check.
    travisYaml.before_script = travisYaml.before_script.filter(
        (line) => !line.includes('update-types'));

    const travisCommand =
        // Update the types.
        'npm run update-types && ' +
        // If there were any changes, this git command will return non-zero.
        'git diff --exit-code || ' +
        // Show an error message in the Travis log (escape code makes it red).
        '(echo -e \'\\n\\033[31mERROR:\\033[0m Typings are stale. ' +
        'Please run "npm run update-types".\' && ' +
        // The echo command will succeed, so return a non-zero exit code again
        // here so that Travis errors.
        'false)';

    travisYaml.before_script.push(travisCommand);
    await fse.writeFile(travisYamlPath, yaml.safeDump(travisYaml));
  } else {
    console.log(`${element.ghRepo.name}: Missing .travis.yaml`);
  }

  const execOpts = {cwd: element.dir};

  // Install the generator and its dependencies. Delete the package lock in case
  // a newer version of the generator will change our types.
  const packageLockPath = path.join(element.dir, 'package-lock.json');
  if (await fse.pathExists(packageLockPath)) {
    await fse.remove(packageLockPath);
  }
  await execFilePromise('npm', ['install'], execOpts);

  // Run the generator (using the script we added above).
  await execFilePromise('npm', ['run', npmScriptName], execOpts);

  const commitFiles = [];
  for (const changedFile of await element.repo.getStatus()) {
    const filepath = changedFile.path();
    if (filepath.endsWith('.d.ts')) {
      updatedTypes = true;
    } else if (filepath === '.travis.yml') {
      updatedTravis = true;
    } else if (
        filepath === 'package.json' || filepath === 'package-lock.json') {
    } else {
      console.log(
          `${element.ghRepo.name}: Unexpected changed file: ${filepath}`);
      continue;
    }
    commitFiles.push(filepath);
  }

  if (updatedTypes || majorVersionBump || updatedNpmScript || updatedTravis) {
    await makeCommit(
        element, commitFiles, 'Update and/or configure type declarations.');

  } else {
    console.log(`${element.ghRepo.name}: No typings changed.`);
  }
}

register({
  name: 'typescript',
  pass: typescriptPass,
  runsByDefault: false,
});
