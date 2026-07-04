'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const imports = require('../verifiers/imports');
const { tmpdir, makeCfg } = require('./helpers');

test('extractJsSpecifiers covers import/require/dynamic/export-from', () => {
  const src = `
import express from 'express';
import './local.css';
import { x } from "@scope/pkg/sub";
const fs = require('fs');
const lazy = await import('lazy-lib');
export { y } from 'reexported';
`;
  const specs = imports.extractJsSpecifiers(src).sort();
  assert.deepStrictEqual(specs, ['./local.css', '@scope/pkg/sub', 'express', 'fs', 'lazy-lib', 'reexported'].sort());
  assert.strictEqual(imports.packageNameOf('@scope/pkg/sub'), '@scope/pkg');
  assert.strictEqual(imports.packageNameOf('lodash/get'), 'lodash');
});

test('verify JS: installed and declared pass, unknown warns, builtins skipped', () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, 'node_modules', 'express'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ dependencies: { 'declared-only': '1.0.0' } })
  );
  const cfg = makeCfg(dir, 'http://127.0.0.1:1');
  const file = path.join(dir, 'src', 'app.js');
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const findings = imports.verify(
    file,
    `
import express from 'express';
import declared from 'declared-only';
import fs from 'node:fs';
import path from 'path';
import ghost from 'totally-made-up-lib-42';
import local from './util.js';
`,
    cfg
  );
  assert.strictEqual(findings.length, 1);
  assert.strictEqual(findings[0].name, 'totally-made-up-lib-42');
  assert.strictEqual(findings[0].severity, 'warn');
});

test('extractPyModules: import and from forms, top-level only', () => {
  const mods = imports
    .extractPyModules(
      `
import os
import numpy.linalg
from requests import get
from . import sibling
import json, sys
`
    )
    .sort();
  assert.deepStrictEqual(mods, ['json', 'numpy', 'os', 'requests', 'sys'].sort());
});

test('verify Python: stdlib and declared pass, unknown warns with alias hint', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'requirements.txt'), 'numpy==1.26.0\nopencv-python\n');
  fs.writeFileSync(path.join(dir, 'pyproject.toml'), '[project]\nname = "demo"\n');
  const cfg = makeCfg(dir, 'http://127.0.0.1:1');
  const file = path.join(dir, 'main.py');

  const findings = imports.verify(
    file,
    `
import os
import numpy
import cv2
import imaginary_module_xyz
`,
    cfg
  );
  assert.strictEqual(findings.length, 1);
  assert.strictEqual(findings[0].name, 'imaginary_module_xyz');
});
