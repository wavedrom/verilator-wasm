'use strict';

const fs = require('fs/promises');
const path = require('path');

const exists = async p => {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
};

// The 165 translation units linked into verilator_bin.
//
// Derived from the three object lists in src/Makefile_obj.in rather than from
// whatever objects a native build happens to have left in src/obj_opt/ — that
// directory holds 166 .o files, one of which (V3Scoreboard.o) is built but is
// not on the link line. Enumerating the directory is how an earlier probe
// undercounted at 163.
const OBJ_LIST_VARS = ['RAW_OBJS', 'RAW_OBJS_PCH_ASTMT', 'RAW_OBJS_PCH_ASTNOMT'];

const EXPECTED_COUNT = 165;

const parseTuList = async forkRoot => {
  const makefile = path.join(forkRoot, 'src', 'Makefile_obj.in');
  const text = await fs.readFile(makefile, 'utf8');

  const names = [];
  for (const varName of OBJ_LIST_VARS) {
    // NAME = \  <newline>  entry.o \ ... until a line without a continuation
    const re = new RegExp('^' + varName + '\\s*=\\s*(\\\\\\n(?:.*\\\\\\n)*.*)$', 'm');
    const match = text.match(re);
    if (!match) {
      throw new Error('tu-list: ' + varName + ' not found in ' + makefile);
    }
    const entries = match[1].match(/[A-Za-z0-9_]+\.o/g) || [];
    if (entries.length === 0) {
      throw new Error('tu-list: ' + varName + ' is empty in ' + makefile);
    }
    names.push(...entries.map(o => o.replace(/\.o$/, '')));
  }

  const unique = [...new Set(names)].sort();
  if (unique.length !== names.length) {
    throw new Error('tu-list: duplicate entries across ' + OBJ_LIST_VARS.join(' + '));
  }
  return unique;
};

// TU name -> source file. Only V3Const__gen lives in gen/; the generated
// V3ParseBison.c / V3Lexer.yy.cpp / V3PreLex.yy.cpp are #included by other
// TUs, not compiled directly.
const resolveTuSource = async (name, forkRoot, genDir) => {
  const candidates = [
    path.join(forkRoot, 'src', name + '.cpp'),
    path.join(genDir, name + '.cpp'),
    path.join(genDir, name + '.c')
  ];
  for (const candidate of candidates) {
    if (await exists(candidate)) {
      return candidate;
    }
  }
  throw new Error('tu-list: no source for TU ' + name + ', tried:\n  ' + candidates.join('\n  '));
};

module.exports = {parseTuList, resolveTuSource, EXPECTED_COUNT};
